'use strict';

const express = require('express');
const { query, withExhibitTransaction, withMultiExhibitTransaction } = require('../db');
const { requireRole, requireAuth } = require('../auth');
const { recordAudit } = require('../audit');
const {
  ValidationError,
  nonEmptyString,
  ConflictError,
} = require('../validation');
const {
  lockExhibit,
  getPlan,
  getOccupyingPlans,
  planWindows,
  computeOccupancy,
  buildOverflows,
  planOverlaps,
  decoratePlans,
  normalizeScheduleInput,
  evaluatePlanBatch,
} = require('../service');
const {
  doseByYear,
  yearMapToObject,
  buildWindows,
  subtractIntervals,
} = require('../dosing');
const { AuthError } = require('../validation');
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
// 联合核准：2~10 条不同的待批准计划同时试算 / 同时批准（可跨展品）
// 试算布展员与保管员均可调用；只有保管员可提交联合核准。
// 必须注册在 '/:id' 之前，否则 '/batch/preview' 会被 ':id' 捕获。
// ---------------------------------------------------------------------------

/** 解析请求体中的计划编号：planIds 数组、长度 2~10、互不相同的正整数。 */
function parseBatchIds(body) {
  const raw = body && Array.isArray(body.planIds) ? body.planIds : null;
  if (!raw || raw.length < 2 || raw.length > 10) {
    throw new ValidationError('请提供 2 至 10 条不同计划的编号（planIds 数组，长度 2~10）');
  }
  const ids = raw.map(Number);
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new ValidationError('计划编号必须为正整数');
  }
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError('联合核准的计划编号必须互不相同');
  }
  return ids;
}

/** 锁外预检：计划均须存在；返回 { ids, exhibitIds }。状态/占用在锁事务内重新核对。 */
async function loadBatchMeta(ids) {
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await query(
    `SELECT id, exhibit_id FROM plans WHERE id IN (${placeholders})`,
    ids
  );
  const found = new Map(rows.map((r) => [Number(r.id), Number(r.exhibit_id)]));
  for (const id of ids) {
    if (!found.has(id)) throw new ValidationError(`计划 #${id} 不存在`);
  }
  return { ids, exhibitIds: [...new Set(ids.map((id) => found.get(id)))] };
}

/** 在多展品事务内：按展品 id 升序加展品行锁，再执行核对。 */
async function runBatchTransaction(exhibitIds, ids) {
  return withMultiExhibitTransaction(exhibitIds, async (client) => {
    for (const exId of [...exhibitIds].sort((a, b) => a - b)) {
      await lockExhibit(client, exId);
    }
    return evaluatePlanBatch(client, ids);
  });
}

/** 联合核对失败的中文原因汇总（错误信息与页面共用）。 */
function batchConflictMessages(result) {
  const c = result.conflicts;
  const parts = [];
  for (const p of c.invalidStatus) {
    parts.push(`计划「${p.title}」(#${p.planId}) 当前状态为 ${p.status}，不是待批准`);
  }
  for (const o of c.intraGroupOverlaps) {
    parts.push(
      `组内同展品计划「${o.planTitle}」(#${o.planId}) 与「${o.otherTitle}」(#${o.otherPlanId}) 开灯时间重叠`
    );
  }
  for (const p of c.overlappingPlans) {
    parts.push(
      `计划「${p.planTitle}」(#${p.planId}) 与同展品${p.other.status === 'pending_review' ? '待复核' : '已批准'}` +
      `计划「${p.other.title}」(#${p.other.id}) 开灯时间重叠`
    );
  }
  for (const m of c.missingLimits) {
    parts.push(`展品 #${m.exhibitId} ${m.year} 年尚未登记年度额度`);
  }
  for (const o of c.overflows) {
    const contrib = o.contributions
      .map((ct) => `计划 #${ct.planId} 新增 ${ct.residue}`)
      .join('，');
    parts.push(
      `展品 #${o.exhibitId} ${o.year} 年：上限 ${o.limit}，原占用 ${o.usedByOthers}，` +
        `组内新增合计 ${o.addedByGroup}（${contrib}），合计 ${o.projected}，超额 ${o.excess} lx·h`
    );
  }
  return parts;
}

/**
 * 联合试算：布展员/保管员均可调用，不写库。
 * 返回每条计划的展品、各自然年新增估算占用，以及按展品的原占用、上限、冲突。
 */
router.post('/batch/preview', async (req, res, next) => {
  try {
    const ids = parseBatchIds(req.body || {});
    const { exhibitIds } = await loadBatchMeta(ids);
    const result = await runBatchTransaction(exhibitIds, ids);
    res.json({ batchPreview: result });
  } catch (err) {
    next(err);
  }
});

/**
 * 提交联合核准（仅保管员）：
 * 在多展品锁事务内重新核对计划状态与实时占用（试算与提交口径一致），
 * 全部通过才一次批准全部计划并记录审计；任一失败则整组计划与审计均不变（事务回滚），
 * 返回涉及的计划、年份和冲突原因（409）。
 */
router.post('/batch/approve', requireRole('conservator'), async (req, res, next) => {
  try {
    const ids = parseBatchIds(req.body || {});
    const { exhibitIds } = await loadBatchMeta(ids);

    const detail = await withMultiExhibitTransaction(exhibitIds, async (client) => {
      for (const exId of [...exhibitIds].sort((a, b) => a - b)) {
        await lockExhibit(client, exId);
      }
      // 锁内重新核对：计划状态与实时占用（预检/试算后可能已被他人改动）
      const result = await evaluatePlanBatch(client, ids);
      if (!result.ok) {
        throw new ConflictError(
          `联合核准未通过核对（计划 ${ids.map((x) => `#${x}`).join('、')}）：` +
            batchConflictMessages(result).join('；'),
          {
            planIds: result.planIds,
            conflicts: result.conflicts,
            items: result.items,
            exhibits: result.exhibits,
          }
        );
      }

      // 全部通过：一次批准全部计划 + 审计（每条计划一条审批审计 + 一条整组事件）
      const approvedPlanIds = [];
      for (const item of result.items) {
        const upd = await client.query(
          `UPDATE plans
              SET status = 'approved', approved_by = $1, approved_at = now(),
                  review_reason = NULL, updated_at = now()
            WHERE id = $2 AND status = 'submitted'
            RETURNING id, exhibit_id, status`,
          [req.sessionUser.userId, item.planId]
        );
        if (upd.rows.length === 0) {
          // 极端并发下状态在评估后被改：直接抛错回滚整组
          throw new ConflictError(
            `计划 #${item.planId} 状态在提交时已变化，本次联合核准整组未执行，请重新核对`,
            { planIds: result.planIds, changedPlanId: item.planId }
          );
        }
        approvedPlanIds.push(item.planId);
        await recordAudit(client, req.sessionUser, 'plan.batch_approve_item',
          'plan', item.planId, {
            exhibitId: item.exhibitId,
            batchPlanIds: result.planIds,
            addedYearly: item.addedYearly,
          });
      }
      await recordAudit(client, req.sessionUser, 'plan.batch_approve', 'plan', null, {
        planIds: approvedPlanIds,
        exhibitIds: result.exhibits.map((x) => x.exhibitId),
      });

      // 返回各相关展品的最新详情；单展品时同时把该展品详情字段铺到顶层（与单条批准同构）
      const exhibitDetails = {};
      for (const ex of result.exhibits) {
        exhibitDetails[String(ex.exhibitId)] = await exhibitDetail(client, ex.exhibitId, { lock: true });
      }
      const payload = {
        batchApproval: {
          planIds: approvedPlanIds,
          exhibitIds: result.exhibits.map((x) => x.exhibitId),
          items: result.items,
          exhibits: result.exhibits,
        },
        exhibitDetails,
      };
      if (result.exhibits.length === 1) {
        Object.assign(payload, exhibitDetails[String(result.exhibits[0].exhibitId)]);
      }
      return payload;
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
