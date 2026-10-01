'use strict';

const express = require('express');
const { query, withExhibitTransaction, withExhibitsTransaction } = require('../db');
const { requireRole, requireAuth } = require('../auth');
const { recordAudit } = require('../audit');
const {
  ValidationError,
  nonEmptyString,
} = require('../validation');
const {
  lockExhibit,
  getPlan,
  getPlansByIds,
  getOccupyingPlans,
  planWindows,
  computeOccupancy,
  buildOverflows,
  planOverlaps,
  decoratePlans,
  normalizeScheduleInput,
  evaluatePlanBatch,
  batchConflictMessages,
} = require('../service');
const {
  doseByYear,
  yearMapToObject,
  buildWindows,
  subtractIntervals,
} = require('../dosing');
const { ConflictError, AuthError } = require('../validation');
const { exhibitDetail } = require('./exhibits');

const router = express.Router();

router.use(requireAuth);

function normalizePlanInput(body) {
  return normalizeScheduleInput(body, { withTitle: true });
}

// 计划列表（可按展品过滤）
router.get('/', async (req, res, next) => {
  try {
    const exhibitId = req.query.exhibitId ? Number(req.query.exhibitId) : null;
    const { rows } = await query(
      `SELECT p.*, e.name AS exhibit_name, u.display_name AS creator_name,
              a.display_name AS approver_name
         FROM plans p
         JOIN exhibits e ON e.id = p.exhibit_id
         LEFT JOIN users u ON u.id = p.created_by
         LEFT JOIN users a ON a.id = p.approved_by
        WHERE ($1::bigint IS NULL OR p.exhibit_id = $1)
        ORDER BY p.id DESC`,
      [exhibitId]
    );
    // 附加各计划的待审调整申请概要（不改原有字段，保持响应兼容）
    await decoratePlans({ query }, rows);
    res.json({ plans: rows });
  } catch (err) {
    next(err);
  }
});

// 布展员创建计划
router.post('/', requireRole('installer'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const exhibitId = Number(body.exhibitId);
    if (!Number.isInteger(exhibitId)) throw new ValidationError('展品 ID 无效');
    const input = normalizePlanInput(body);

    const { rows } = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);

      // 创建时也提示与占用计划的时间重叠，便于布展员及时调整
      const windows = buildWindowsSafe(input);
      const existing = await getOccupyingPlans(client, exhibitId);
      const clash = existing.find((p) => planOverlaps(windows, p));
      if (clash) {
        throw new ConflictError(
          `与同一展品已批准/待复核计划「${clash.title}」(#${clash.id}) 的开灯时间重叠，无法提交`,
          { overlappingPlanId: clash.id }
        );
      }

      const inserted = await client.query(
        `INSERT INTO plans
           (exhibit_id, title, start_date, end_date, light_periods, estimated_lux, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING *`,
        [
          exhibitId,
          input.title,
          input.startDate,
          input.endDate,
          JSON.stringify(input.periodSpecs),
          input.estimatedLux,
          req.sessionUser.userId,
        ]
      );
      const yearly = yearMapToObject(doseByYear(windows, input.estimatedLux));
      await recordAudit(client, req.sessionUser, 'plan.create', 'plan', inserted.rows[0].id, {
        exhibitId,
        periods: input.periodSpecs,
        estimatedLux: input.estimatedLux,
        estimatedYearly: yearly,
      });
      return inserted;
    });
    res.status(201).json({ plan: rows[0] });
  } catch (err) {
    next(err);
  }
});

function buildWindowsSafe(input) {
  return buildWindows(input.startDate, input.endDate, input.periods);
}

// ---------------------------------------------------------------------------
// 联合核准：按编号选取 2~10 条不同的待批准计划，整组同时试算 / 一次批准
// 注意：必须注册在 '/:id' 之前，否则 '/batch/preview' 会被 ':id' 捕获。
// ---------------------------------------------------------------------------

/** 解析联合核准请求体：planIds 数组、2~10 个互不相同的正整数，返回按输入顺序的编号。 */
function parseBatchIds(body) {
  const raw = body && Array.isArray(body.planIds) ? body.planIds : null;
  if (!raw || raw.length < 2 || raw.length > 10) {
    throw new ValidationError('请选择 2 至 10 条不同的待批准计划（planIds 数组）');
  }
  const ids = raw.map(Number);
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new ValidationError('计划编号必须是正整数');
  }
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError('联合核准的计划编号必须互不相同');
  }
  return ids;
}

/**
 * 按输入顺序装配计划行（缺失即 400）。q 为查询函数或事务 client。
 * 同时返回 planTitleById 供中文错误信息使用。
 */
async function loadOrderedPlans(q, ids) {
  const run = typeof q === 'function' ? q : q.query.bind(q);
  const rows = await getPlansByIds({ query: run }, ids);
  const byId = new Map(rows.map((p) => [Number(p.id), p]));
  const ordered = [];
  for (const id of ids) {
    const plan = byId.get(id);
    if (!plan) throw new ValidationError(`计划 #${id} 不存在`);
    ordered.push(plan);
  }
  return ordered;
}

/** 联合试算对外形态：展品名 + 每条计划（含按年新增/原占用/上限/冲突标记）+ 按展品年度合并报告。 */
async function buildBatchPayload(client, ids, orderedPlans, evalResult) {
  const exhibitIds = [...new Set(orderedPlans.map((p) => Number(p.exhibit_id)))];
  let exhibitNameById = new Map();
  if (exhibitIds.length > 0) {
    const ph = exhibitIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await client.query(`SELECT id, name FROM exhibits WHERE id IN (${ph})`, exhibitIds);
    exhibitNameById = new Map(rows.map((e) => [Number(e.id), e.name]));
  }
  const itemById = new Map(evalResult.items.map((it) => [Number(it.planId), it]));

  const plans = orderedPlans.map((plan) => {
    const item = itemById.get(Number(plan.id)) || {};
    return {
      ...plan,
      not_started: plan.status === 'approved',
      notStarted: plan.status === 'approved',
      pending_adjustment: null,
      pendingAdjustment: null,
      batch: {
        grossEstimateYearly: item.grossEstimateYearly || {},
        residueYearly: item.residueYearly || {},
        yearly: item.yearly || {},
        conflicts: planConflictFlags(evalResult, Number(plan.id)),
      },
    };
  });

  const exhibits = evalResult.exhibits.map((rep) => ({
    exhibitId: rep.exhibitId,
    exhibitName: exhibitNameById.get(Number(rep.exhibitId)) || null,
    yearlyReport: rep.yearlyReport,
  }));

  return {
    planIds: ids,
    ok: evalResult.ok,
    conflicts: evalResult.conflicts,
    plans,
    exhibits,
  };
}

/** 汇总单条计划涉及的全部冲突（供试算结果逐计划展示）。 */
function planConflictFlags(evalResult, planId) {
  const c = evalResult.conflicts;
  return {
    notSubmitted: c.notSubmitted.some((x) => Number(x.planId) === planId)
      ? (c.notSubmitted.find((x) => Number(x.planId) === planId) || {}).status
      : null,
    internalOverlaps: c.internalOverlaps
      .filter((x) => Number(x.planId) === planId || Number(x.otherPlanId) === planId)
      .map((x) => (Number(x.planId) === planId
        ? { otherPlanId: x.otherPlanId, otherPlanTitle: x.otherPlanTitle }
        : { otherPlanId: x.planId, otherPlanTitle: x.planTitle })),
    overlappingPlans: c.overlappingPlans
      .filter((x) => Number(x.planId) === planId)
      .map((x) => x.other),
    missingLimitYears: c.missingLimits
      .filter((x) => Number(x.planId) === planId)
      .map((x) => x.year),
    overflowYears: c.overflows
      .filter((o) => o.contributions.some((ct) => Number(ct.planId) === planId))
      .map((o) => o.year),
  };
}

/**
 * 联合试算（布展员与保管员均可）：不写库。
 * 组内同展品开灯窗彼此不重叠、且不与其他已批准/待复核计划重叠；
 * 按自然年合并组内同展品各计划估算残余（实测替代估算、停灯扣减口径）校验上限。
 */
router.post('/batch/preview', requireAuth, async (req, res, next) => {
  try {
    const ids = parseBatchIds(req.body || {});
    const prePlans = await loadOrderedPlans(query, ids);
    const exhibitIds = [...new Set(prePlans.map((p) => Number(p.exhibit_id)))];
    const result = await withExhibitsTransaction(exhibitIds, async (client) => {
      const orderedPlans = await loadOrderedPlans(client, ids);
      const evalResult = await evaluatePlanBatch(client, orderedPlans);
      return buildBatchPayload(client, ids, orderedPlans, evalResult);
    });
    res.json({ batchPreview: result });
  } catch (err) {
    next(err);
  }
});

/**
 * 联合核准提交（仅保管员）：在涉及展品的锁事务内重新核对计划状态与实时占用，
 * 全部通过才一次把组内计划全部批准并逐条 + 汇总记录审计；
 * 任一失败则事务回滚，组内计划与审计均不变，409 返回涉及的计划、年份与冲突原因。
 * 单展品时成功响应与既有单条批准同构（展品详情字段位于顶层，另附 batchApproval）。
 */
router.post('/batch/approve', requireRole('conservator'), async (req, res, next) => {
  try {
    const ids = parseBatchIds(req.body || {});
    const prePlans = await loadOrderedPlans(query, ids);
    const exhibitIds = [...new Set(prePlans.map((p) => Number(p.exhibit_id)))];

    const detail = await withExhibitsTransaction(exhibitIds, async (client) => {
      // 锁内重读：状态/占用可能在预检后被并发改动
      const orderedPlans = await loadOrderedPlans(client, ids);
      const evalResult = await evaluatePlanBatch(client, orderedPlans);
      if (!evalResult.ok) {
        const titleById = new Map(orderedPlans.map((p) => [Number(p.id), p.title]));
        throw new ConflictError(
          `联合核准（计划 ${ids.map((id) => `#${id}`).join('、')}）未通过核对：` +
            batchConflictMessages(evalResult, titleById).join('；'),
          {
            planIds: ids,
            conflicts: evalResult.conflicts,
            items: evalResult.items,
            exhibits: evalResult.exhibits,
          }
        );
      }

      // 全部通过：一次批准组内全部计划（同一事务）
      const residueByPlan = new Map(evalResult.items.map((it) => [Number(it.planId), it.residueYearly]));
      for (const plan of orderedPlans) {
        await client.query(
          `UPDATE plans
              SET status = 'approved', approved_by = $1, approved_at = now(),
                  review_reason = NULL, updated_at = now()
            WHERE id = $2 AND status = 'submitted'`,
          [req.sessionUser.userId, plan.id]
        );
        await recordAudit(client, req.sessionUser, 'plan.batch_approve_item',
          'plan', plan.id, {
            exhibitId: Number(plan.exhibit_id),
            batchPlanIds: ids,
            addedYearly: residueByPlan.get(Number(plan.id)) || {},
          });
      }
      await recordAudit(client, req.sessionUser, 'plan.batch_approve',
        'plan', orderedPlans[0].id, {
          planIds: ids,
          exhibitIds,
          items: evalResult.items.map((it) => ({
            planId: it.planId, exhibitId: it.exhibitId, residueYearly: it.residueYearly,
          })),
          yearlyByExhibit: evalResult.exhibits.map((rep) => ({
            exhibitId: rep.exhibitId,
            yearly: rep.yearlyReport,
          })),
        });

      const batchApproval = {
        planIds: ids,
        exhibitIds,
        items: evalResult.items,
        exhibits: evalResult.exhibits,
      };

      // 成功响应：单展品时与既有单条批准同构（展品详情顶层字段保持兼容）
      if (exhibitIds.length === 1) {
        const detailAfter = await exhibitDetail(client, exhibitIds[0], { lock: true });
        return { ...detailAfter, batchApproval };
      }
      // 跨展品：返回各展品最新详情（既有单展品字段不适用，不新增顶层展品详情字段）
      const details = [];
      for (const exId of exhibitIds) {
        details.push(await exhibitDetail(client, exId, { lock: true }));
      }
      return { ok: true, batchApproval, exhibitDetails: details };
    });

    res.json(detail);
  } catch (err) {
    next(err);
  }
});

// 计划详情
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const plan = await getPlan({ query }, id);
    const windows = planWindows(plan);
    const estimatedYearly = yearMapToObject(doseByYear(windows, Number(plan.estimated_lux)));
    // 待审调整申请：附带原值与拟改值试算（冲突计划/实测/超额年份与数值）
    await decoratePlans({ query }, [plan], { withPreview: true });
    res.json({ plan, estimatedYearly });
  } catch (err) {
    next(err);
  }
});

/**
 * 批准 / 复核通过：核心事务
 *  - 行锁锁定展品，串行化并发批准
 *  - 时间重叠（具体开灯时刻）不得批准
 *  - 已确认实测 + 其他已批准计划估算 + 本计划估算残余 超年度额度 -> 409，列明年份与超额量
 */
async function approve(req, res) {
  const id = Number(req.params.id);
  // 先读出展品 id，再进入该展品的串行化事务（应用锁 + SELECT FOR UPDATE 双保险）
  const prePlan = await getPlan({ query }, id);
  const detail = await withExhibitTransaction(prePlan.exhibit_id, async (client) => {
    // 先锁展品，再读计划，确保拿到的是最新状态（与取消/驳回/其他批准互斥）
    await lockExhibit(client, prePlan.exhibit_id);
    const plan = await getPlan(client, id);

    if (!['submitted', 'pending_review'].includes(plan.status)) {
      throw new ValidationError(`当前状态（${plan.status}）不能批准`);
    }

    const targetWindows = planWindows(plan);

    // 1) 同展品时间重叠检查
    const others = await getOccupyingPlans(client, plan.exhibit_id, id);
    const clash = others.find((p) => planOverlaps(targetWindows, p));
    if (clash) {
      throw new ConflictError(
        `与同一展品计划「${clash.title}」(#${clash.id}) 的开灯时间重叠，不得批准`,
        { overlappingPlanId: clash.id, overlappingPlanTitle: clash.title }
      );
    }

    // 2) 年度额度检查（本计划估算残余 = 自身实测与停灯已覆盖之外的部分，统一扣减口径）
    const occupancy = await computeOccupancy(client, plan.exhibit_id, { excludePlanId: id });
    const { rows: measRows } = await client.query(
      `SELECT start_ts, end_ts FROM measurements WHERE plan_id = $1 AND status = 'confirmed'`,
      [id]
    );
    const selfMeas = measRows.map((m) => ({
      start: new Date(m.start_ts).getTime(),
      end: new Date(m.end_ts).getTime(),
    }));
    const { rows: blackoutRows } = await client.query(
      `SELECT start_ts, end_ts FROM blackouts WHERE plan_id = $1 ORDER BY id`,
      [id]
    );
    const selfBlackouts = blackoutRows.map((b) => ({
      start: new Date(b.start_ts).getTime(),
      end: new Date(b.end_ts).getTime(),
    }));
    const remainingWindows = subtractIntervals(targetWindows, [...selfMeas, ...selfBlackouts]);
    const addedYearly = yearMapToObject(doseByYear(remainingWindows, Number(plan.estimated_lux)));

    const overflows = buildOverflows(occupancy.used, occupancy.limits, addedYearly);
    if (overflows.length > 0) {
      throw new ConflictError(
        `批准将导致 ${overflows.map((o) => `${o.year} 年超出 ${o.excess} lx·h`).join('；')}`,
        { overflows }
      );
    }

    const prevStatus = plan.status;
    await client.query(
      `UPDATE plans
          SET status = 'approved', approved_by = $1, approved_at = now(),
              review_reason = NULL, updated_at = now()
        WHERE id = $2`,
      [req.sessionUser.userId, id]
    );
    await recordAudit(client, req.sessionUser, prevStatus === 'submitted' ? 'plan.approve' : 'plan.reapprove',
      'plan', id, { exhibitId: plan.exhibit_id, addedYearly });

    return exhibitDetail(client, plan.exhibit_id, { lock: true });
  });
  res.json(detail);
}

router.post('/:id/approve', requireRole('conservator'), (req, res, next) =>
  approve(req, res).catch(next)
);

// 保管员驳回（仅待批准计划）
router.post('/:id/reject', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 1000) : null;
    const prePlan = await getPlan({ query }, id);
    await withExhibitTransaction(prePlan.exhibit_id, async (client) => {
      await lockExhibit(client, prePlan.exhibit_id);
      const plan = await getPlan(client, id);
      if (plan.status !== 'submitted') throw new ValidationError('只有待批准计划可以驳回');
      await client.query(
        `UPDATE plans SET status = 'rejected', updated_at = now() WHERE id = $1`,
        [id]
      );
      await recordAudit(client, req.sessionUser, 'plan.reject', 'plan', id, { reason });
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * 取消计划：
 *  - 布展员可取消自己尚未批准的计划
 *  - 保管员可取消任何 submitted/approved/pending_review 计划
 */
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 1000) : null;
    const prePlan = await getPlan({ query }, id);
    await withExhibitTransaction(prePlan.exhibit_id, async (client) => {
      await lockExhibit(client, prePlan.exhibit_id);
      const plan = await getPlan(client, id);
      const isOwn = Number(plan.created_by) === req.sessionUser.userId;
      const isConservator = req.sessionUser.role === 'conservator';
      if (plan.status === 'submitted' && !(isOwn || isConservator)) {
        throw new AuthError('只能取消自己提交的计划', 403);
      }
      if (!['submitted', 'approved', 'pending_review'].includes(plan.status)) {
        throw new ValidationError(`当前状态（${plan.status}）不能取消`);
      }
      if ((plan.status === 'approved' || plan.status === 'pending_review') && !isConservator) {
        throw new AuthError('已批准计划只能由保管员取消', 403);
      }
      await client.query(
        `UPDATE plans SET status = 'cancelled', review_reason = COALESCE($2, review_reason),
                          updated_at = now() WHERE id = $1`,
        [id, reason]
      );
      await recordAudit(client, req.sessionUser, 'plan.cancel', 'plan', id, {
        exhibitId: plan.exhibit_id,
        reason,
        previousStatus: plan.status,
      });
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
