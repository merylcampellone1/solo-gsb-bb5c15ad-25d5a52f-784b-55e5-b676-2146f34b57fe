'use strict';

const express = require('express');
const { withExhibitTransaction, query } = require('../db');
const { requireRole, requireAuth } = require('../auth');
const { recordAudit } = require('../audit');
const { ValidationError, ConflictError, AuthError } = require('../validation');
const {
  lockExhibit,
  getPlan,
  getPendingAdjustment,
  decoratePlans,
  evaluateAdjustment,
  evaluateAdjustmentPair,
  normalizeScheduleInput,
  serializeAdjustment,
  planNotStarted,
  dateYmd,
} = require('../service');
const { exhibitDetail } = require('./exhibits');

const router = express.Router();

router.use(requireAuth);

/** 按用户 id 集合批量加载显示名，返回 Map<id, display_name>。q 为查询函数或事务 client。 */
async function loadUserNames(q, idSet) {
  const ids = [...idSet];
  const map = new Map();
  if (ids.length === 0) return map;
  const run = typeof q === 'function' ? q : q.query.bind(q);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await run(
    `SELECT id, display_name FROM users WHERE id IN (${placeholders})`,
    ids
  );
  for (const u of rows) map.set(Number(u.id), u.display_name);
  return map;
}

/** 调整申请列表：可按 planId / exhibitId / status 过滤；带 preview=1 时附带试算。 */
router.get('/', async (req, res, next) => {
  try {
    const planId = req.query.planId ? Number(req.query.planId) : null;
    const exhibitId = req.query.exhibitId ? Number(req.query.exhibitId) : null;
    const status =
      req.query.status && ['pending', 'approved', 'rejected', 'withdrawn'].includes(String(req.query.status))
        ? String(req.query.status)
        : null;
    const withPreview = String(req.query.preview || '') === '1';

    // 先取申请行（避免部分驱动对“连接 + 过滤 + 排序”组合的实现限制），再补展示名
    const { rows } = await query(
      `SELECT * FROM plan_adjustments a
        WHERE ($1::bigint IS NULL OR a.plan_id = $1)
          AND ($2::bigint IS NULL OR a.exhibit_id = $2)
          AND ($3::text IS NULL OR a.status = $3)
        ORDER BY a.id DESC
        LIMIT 1000`,
      [Number.isInteger(planId) ? planId : null,
       Number.isInteger(exhibitId) ? exhibitId : null,
       status]
    );

    let adjustments = rows.map(serializeAdjustment);
    const rawById = new Map(rows.map((row) => [row.id, row]));

    // 补计划/展品/操作人展示名
    const nameIds = new Set();
    for (const row of rows) {
      if (row.created_by) nameIds.add(Number(row.created_by));
      if (row.reviewed_by) nameIds.add(Number(row.reviewed_by));
    }
    const nameMap = await loadUserNames(query, nameIds);
    const { rows: adjPlans } = await query(
      `SELECT id, exhibit_id, title FROM plans
        WHERE id IN (SELECT DISTINCT plan_id FROM plan_adjustments
                      WHERE id IN (${rows.map((_, i) => `$${i + 1}`).join(',')}))`,
      rows.map((row) => row.id)
    );
    const adjPlanById = new Map(adjPlans.map((p) => [Number(p.id), p]));
    const exhibitNameIds = [...new Set(adjPlans.map((p) => Number(p.exhibit_id)))];
    let exhibitNameMap = new Map();
    if (exhibitNameIds.length > 0) {
      const ph = exhibitNameIds.map((_, i) => `$${i + 1}`).join(',');
      const { rows: exRows } = await query(
        `SELECT id, name FROM exhibits WHERE id IN (${ph})`,
        exhibitNameIds
      );
      exhibitNameMap = new Map(exRows.map((e) => [Number(e.id), e.name]));
    }
    for (const a of adjustments) {
      const p = adjPlanById.get(a.planId);
      a.planTitle = p ? p.title : null;
      a.exhibitName = p ? exhibitNameMap.get(Number(p.exhibit_id)) || null : null;
      const raw = rawById.get(a.id);
      a.creatorName = raw.created_by ? nameMap.get(Number(raw.created_by)) || null : null;
      a.reviewerName = raw.reviewed_by ? nameMap.get(Number(raw.reviewed_by)) || null : null;
    }

    // 原值（来自所属计划当前值）
    if (adjustments.length > 0) {
      const planIds = [...new Set(adjustments.map((a) => a.planId))];
      const placeholders = planIds.map((_, i) => `$${i + 1}`).join(',');
      const { rows: planRows } = await query(
        `SELECT id, start_date, end_date, light_periods, estimated_lux, status, title FROM plans
          WHERE id IN (${placeholders})`,
        planIds
      );
      const planById = new Map(planRows.map((p) => [Number(p.id), p]));
      adjustments = adjustments.map((a) => {
        const p = planById.get(a.planId);
        a.original = p
          ? {
              title: p.title,
              status: p.status,
              startDate: String(p.start_date).slice(0, 10),
              endDate: String(p.end_date).slice(0, 10),
              periods: p.light_periods,
              estimatedLux: Number(p.estimated_lux),
            }
          : null;
        return a;
      });
    }

    // 待审申请附带拟改值试算（原值 vs 拟改值、冲突明细）
    if (withPreview) {
      const pendings = adjustments.filter((a) => a.status === 'pending');
      // 按展品分组，在展品事务中逐组试算（复用行锁串行化，避免脏读干扰）
      const byExhibit = new Map();
      for (const a of pendings) {
        if (!byExhibit.has(a.exhibitId)) byExhibit.set(a.exhibitId, []);
        byExhibit.get(a.exhibitId).push(a);
      }
      for (const [exId, list] of byExhibit) {
        await withExhibitTransaction(exId, async (client) => {
          await lockExhibit(client, exId);
          for (const a of list) {
            const plan = await getPlan(client, a.planId);
            const evalResult = await evaluateAdjustment(client, plan, rawById.get(a.id));
            a.preview = {
              ok: evalResult.ok,
              conflicts: evalResult.conflicts,
              oldResidueYearly: evalResult.oldResidueYearly,
              newResidueYearly: evalResult.newResidueYearly,
              yearlyReport: evalResult.yearlyReport,
            };
          }
        });
      }
    }

    res.json({ adjustments });
  } catch (err) {
    next(err);
  }
});

// 调整申请详情（含原值与拟改值试算）
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await query(`SELECT * FROM plan_adjustments WHERE id = $1`, [id]);
    if (rows.length === 0) throw new ValidationError('调整申请不存在');
    const rawAdjustment = rows[0];
    const adjustment = serializeAdjustment(rawAdjustment);
    const nameMap = await loadUserNames(query, new Set(
      [rawAdjustment.created_by, rawAdjustment.reviewed_by].filter(Boolean).map(Number)
    ));
    adjustment.creatorName = rawAdjustment.created_by
      ? nameMap.get(Number(rawAdjustment.created_by)) || null : null;
    adjustment.reviewerName = rawAdjustment.reviewed_by
      ? nameMap.get(Number(rawAdjustment.reviewed_by)) || null : null;
    const { rows: titleRows } = await query(
      `SELECT p.title AS plan_title, e.name AS exhibit_name
         FROM plans p JOIN exhibits e ON e.id = p.exhibit_id
        WHERE p.id = $1`,
      [rawAdjustment.plan_id]
    );
    if (titleRows[0]) {
      adjustment.planTitle = titleRows[0].plan_title;
      adjustment.exhibitName = titleRows[0].exhibit_name;
    }
    const detail = await withExhibitTransaction(adjustment.exhibitId, async (client) => {
      await lockExhibit(client, adjustment.exhibitId);
      const plan = await getPlan(client, adjustment.planId);
      adjustment.original = {
        title: plan.title,
        status: plan.status,
        startDate: String(plan.start_date).slice(0, 10),
        endDate: String(plan.end_date).slice(0, 10),
        periods: plan.light_periods,
        estimatedLux: Number(plan.estimated_lux),
      };
      if (adjustment.status === 'pending') {
        const evalResult = await evaluateAdjustment(client, plan, rawAdjustment);
        adjustment.preview = {
          ok: evalResult.ok,
          conflicts: evalResult.conflicts,
          oldResidueYearly: evalResult.oldResidueYearly,
          newResidueYearly: evalResult.newResidueYearly,
          yearlyReport: evalResult.yearlyReport,
        };
      }
      return adjustment;
    });
    res.json({ adjustment: detail });
  } catch (err) {
    next(err);
  }
});

/**
 * 布展员提交调整申请：
 *  - 仅 installer
 *  - 计划必须存在、已批准且尚未开始
 *  - 同一计划同时只允许一份待审申请（重复明确拒绝）
 *  - 新展期/开灯时段/照度走与建计划一致的中文校验（无效时段 400）
 * 待审期间原计划继续占用额度（此处不改计划）。
 */
router.post('/', requireRole('installer'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const planId = Number(body.planId);
    if (!Number.isInteger(planId)) throw new ValidationError('计划 ID 无效');
    const input = normalizeScheduleInput(body);
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 1000) : null;

    const result = await withExhibitTransaction((await getPlan({ query }, planId)).exhibit_id,
      async (client) => {
        const prePlan = await getPlan(client, planId);
        await lockExhibit(client, prePlan.exhibit_id);
        // 锁后重读最新状态
        const plan = await getPlan(client, planId);

        if (plan.status !== 'approved') {
          throw new ValidationError(
            `只有已批准且尚未开始的计划才能提交调整申请（当前状态：${plan.status}）`
          );
        }
        if (!planNotStarted(plan)) {
          throw new ValidationError('计划已开始，不能再提交调整申请');
        }
        const existing = await getPendingAdjustment(client, planId);
        if (existing) {
          throw new ConflictError(
            `该计划已有待审调整申请 #${existing.id}，请先撤回后再重新提交`,
            { existingAdjustmentId: existing.id }
          );
        }

        const inserted = await client.query(
          `INSERT INTO plan_adjustments
             (plan_id, exhibit_id, start_date, end_date, light_periods, estimated_lux,
              reason, status, created_by)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'pending', $8)
           RETURNING *`,
          [
            planId,
            plan.exhibit_id,
            input.startDate,
            input.endDate,
            JSON.stringify(input.periodSpecs),
            input.estimatedLux,
            reason,
            req.sessionUser.userId,
          ]
        );
        await recordAudit(client, req.sessionUser, 'plan.adjustment.submit',
          'plan_adjustment', inserted.rows[0].id, {
            planId,
            exhibitId: plan.exhibit_id,
            original: {
              startDate: String(plan.start_date).slice(0, 10),
              endDate: String(plan.end_date).slice(0, 10),
              periods: plan.light_periods,
              estimatedLux: Number(plan.estimated_lux),
            },
            proposed: {
              startDate: input.startDate,
              endDate: input.endDate,
              periods: input.periodSpecs,
              estimatedLux: input.estimatedLux,
            },
            reason,
          });

        // 回传试算，便于页面展示原值与拟改值（申请本身保持 pending）
        const adj = inserted.rows[0];
        const evalResult = await evaluateAdjustment(client, plan, adj);
        const adjustment = serializeAdjustment(adj);
        adjustment.original = {
          title: plan.title,
          status: plan.status,
          startDate: String(plan.start_date).slice(0, 10),
          endDate: String(plan.end_date).slice(0, 10),
          periods: plan.light_periods,
          estimatedLux: Number(plan.estimated_lux),
        };
        adjustment.preview = {
          ok: evalResult.ok,
          conflicts: evalResult.conflicts,
          oldResidueYearly: evalResult.oldResidueYearly,
          newResidueYearly: evalResult.newResidueYearly,
          yearlyReport: evalResult.yearlyReport,
        };
        return adjustment;
      });

    res.status(201).json({ adjustment: result });
  } catch (err) {
    next(err);
  }
});

/**
 * 拟改值试算（不提交）：任意登录用户可对已批准且未开始的计划试算一组新参数，
 * 供提交前页面展示原值/拟改值与冲突提示。不写库。
 */
router.post('/preview', requireRole('installer'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const planId = Number(body.planId);
    if (!Number.isInteger(planId)) throw new ValidationError('计划 ID 无效');
    const input = normalizeScheduleInput(body);

    const result = await withExhibitTransaction((await getPlan({ query }, planId)).exhibit_id,
      async (client) => {
        const prePlan = await getPlan(client, planId);
        await lockExhibit(client, prePlan.exhibit_id);
        const plan = await getPlan(client, planId);
        if (plan.status !== 'approved') {
          throw new ValidationError(`只有已批准且尚未开始的计划才能试算（当前状态：${plan.status}）`);
        }
        if (!planNotStarted(plan)) throw new ValidationError('计划已开始，不能再调整');
        const evalResult = await evaluateAdjustment(client, plan, {
          start_date: input.startDate,
          end_date: input.endDate,
          light_periods: input.periodSpecs,
          estimated_lux: input.estimatedLux,
        });
        return {
          proposed: {
            startDate: input.startDate,
            endDate: input.endDate,
            periods: input.periodSpecs,
            estimatedLux: input.estimatedLux,
          },
          ok: evalResult.ok,
          conflicts: evalResult.conflicts,
          oldResidueYearly: evalResult.oldResidueYearly,
          newResidueYearly: evalResult.newResidueYearly,
          yearlyReport: evalResult.yearlyReport,
        };
      });
    res.json({ preview: result });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 成对核准：同一展品两份待审调整申请同时替换原窗（互换/协同挪动档期）
// 注意：必须注册在 '/:id/approve' 之前，否则 '/pair/approve' 会被 ':id' 捕获。
// ---------------------------------------------------------------------------

/** 解析请求体中的两个申请编号：adjustmentIds 数组、长度 2、互不相同。 */
function parsePairIds(body) {
  const ids = body && Array.isArray(body.adjustmentIds) ? body.adjustmentIds : null;
  if (!ids || ids.length !== 2) {
    throw new ValidationError('请提供两个不同的申请编号（adjustmentIds 数组，长度 2）');
  }
  const [a, b] = ids.map(Number);
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new ValidationError('申请编号必须是整数');
  }
  if (a === b) throw new ValidationError('两个申请编号必须不同');
  return [a, b];
}

/**
 * 读取两份申请并做组成性校验：存在、不同计划、同一展品、均待审。
 * q 为查询函数或事务 client。返回按输入顺序的 [adjA, adjB]。
 */
async function loadPairAdjustments(q, idA, idB) {
  const run = typeof q === 'function' ? q : q.query.bind(q);
  const { rows } = await run(
    'SELECT * FROM plan_adjustments WHERE id IN ($1, $2)',
    [idA, idB]
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const adjA = byId.get(idA);
  const adjB = byId.get(idB);
  if (!adjA) throw new ValidationError(`调整申请 #${idA} 不存在`);
  if (!adjB) throw new ValidationError(`调整申请 #${idB} 不存在`);
  if (Number(adjA.plan_id) === Number(adjB.plan_id)) {
    throw new ValidationError(
      `申请 #${idA} 与 #${idB} 关联同一计划 #${adjA.plan_id}，成对核准须选择两条不同计划的申请`
    );
  }
  if (Number(adjA.exhibit_id) !== Number(adjB.exhibit_id)) {
    throw new ValidationError(
      `申请 #${idA}（展品 #${adjA.exhibit_id}）与 #${idB}（展品 #${adjB.exhibit_id}）跨展品，` +
        '成对核准仅限同一展品'
    );
  }
  for (const adj of [adjA, adjB]) {
    if (adj.status !== 'pending') {
      throw new ValidationError(
        `调整申请 #${adj.id} 已结案（当前状态：${adj.status}），不能参与成对核准`
      );
    }
  }
  return [adjA, adjB];
}

/** 计划当前值（原值）概要，供成对结果对照展示。 */
function planOriginalValues(plan) {
  return {
    title: plan.title,
    status: plan.status,
    startDate: dateYmd(plan.start_date),
    endDate: dateYmd(plan.end_date),
    periods: plan.light_periods,
    estimatedLux: Number(plan.estimated_lux),
  };
}

/** 成对试算/核对的对外形态：两份申请（含原值）+ 核对结果 + 按年报告。 */
function pairPayload(adjA, adjB, planA, planB, evalResult) {
  return {
    exhibitId: Number(adjA.exhibit_id),
    adjustments: [
      { ...serializeAdjustment(adjA), original: planOriginalValues(planA) },
      { ...serializeAdjustment(adjB), original: planOriginalValues(planB) },
    ],
    ok: evalResult.ok,
    conflicts: evalResult.conflicts,
    items: evalResult.items,
    yearlyReport: evalResult.yearlyReport,
  };
}

/** 成对核对失败的中文原因列表（错误信息与页面共用）。 */
function pairConflictMessages(evalResult, planA, planB) {
  const c = evalResult.conflicts;
  const parts = [];
  const titleOf = (pid) => (Number(pid) === Number(planA.id) ? planA.title : planB.title);
  for (const x of c.notApproved) {
    parts.push(`计划「${titleOf(x.planId)}」(#${x.planId}) 已不是“已批准”状态（当前：${x.status}）`);
  }
  for (const x of c.notStarted) {
    parts.push(`计划「${titleOf(x.planId)}」(#${x.planId}) 已经开始`);
  }
  for (const m of c.outsideMeasurements) {
    parts.push(
      `计划 #${m.planId} 的未作废实测 #${m.id}（${m.start} ~ ${m.end}，${m.status}）不在其新开灯窗内`
    );
  }
  for (const b of c.outsideBlackouts || []) {
    parts.push(
      `计划 #${b.planId} 的停灯记录 #${b.id}（${b.start} ~ ${b.end}）不在其新开灯窗内（停灯保留、不可改删）`
    );
  }
  if (c.pairOverlap) parts.push('两份拟改开灯窗彼此重叠');
  for (const p of c.overlappingPlans) {
    parts.push(
      `申请 #${p.adjustmentId} 的拟改窗与同展品` +
        `${p.other.status === 'pending_review' ? '待复核' : '已批准'}` +
        `计划「${p.other.title}」(#${p.other.id}) 开灯时间重叠`
    );
  }
  for (const y of c.missingLimits) parts.push(`${y} 年尚未登记年度额度`);
  for (const o of c.overflows) {
    const contrib = o.contributions
      .map((ct) => `计划 #${ct.planId} 贡献 ${ct.newResidue}`)
      .join('，');
    parts.push(
      `${o.year} 年：上限 ${o.limit}，其他占用 ${o.usedByOthers}，` +
        `两份拟改残余合计 ${o.newResidueTotal}（${contrib}），合计 ${o.projected}，超额 ${o.excess} lx·h`
    );
  }
  return parts;
}

/**
 * 成对试算（保管员）：两份待审申请同时替换原窗的核对，不写库。
 * 组成性错误（同一计划/跨展品/已结案/编号无效）直接 400 并指出原因。
 */
router.post('/pair/preview', requireRole('conservator'), async (req, res, next) => {
  try {
    const [idA, idB] = parsePairIds(req.body || {});
    const pre = await loadPairAdjustments(query, idA, idB);
    const result = await withExhibitTransaction(pre[0].exhibit_id, async (client) => {
      await lockExhibit(client, pre[0].exhibit_id);
      // 锁内重读重核，避免预检后状态被并发修改
      const [adjA, adjB] = await loadPairAdjustments(client, idA, idB);
      const planA = await getPlan(client, adjA.plan_id);
      const planB = await getPlan(client, adjB.plan_id);
      const evalResult = await evaluateAdjustmentPair(client, planA, adjA, planB, adjB);
      return pairPayload(adjA, adjB, planA, planB, evalResult);
    });
    res.json({ pairPreview: result });
  } catch (err) {
    next(err);
  }
});

/**
 * 成对核准（保管员）：展品锁事务内重新核对全部规则，
 * 全部通过才原子更新两条计划、结案两份申请并记审计；
 * 任一失败则事务回滚，两份申请仍待审、计划与额度不变。
 */
router.post('/pair/approve', requireRole('conservator'), async (req, res, next) => {
  try {
    const [idA, idB] = parsePairIds(req.body || {});
    const pre = await loadPairAdjustments(query, idA, idB);
    const exhibitId = pre[0].exhibit_id;

    const detail = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);
      // 锁内重新核对组成与状态（预检后可能被并发撤回/结案）
      const [adjA, adjB] = await loadPairAdjustments(client, idA, idB);
      const planA = await getPlan(client, adjA.plan_id);
      const planB = await getPlan(client, adjB.plan_id);

      const evalResult = await evaluateAdjustmentPair(client, planA, adjA, planB, adjB);
      if (!evalResult.ok) {
        // 核对失败：两份申请保持待审，事务回滚，计划与额度不变
        throw new ConflictError(
          `成对核准（申请 #${idA} + #${idB}）未通过核对：` +
            pairConflictMessages(evalResult, planA, planB).join('；'),
          {
            adjustmentIds: [idA, idB],
            conflicts: evalResult.conflicts,
            items: evalResult.items,
            yearlyReport: evalResult.yearlyReport,
          }
        );
      }

      // 全部通过：原子更新两条计划 + 结案两份申请 + 审计
      const entries = [
        { adj: adjA, plan: planA, otherAdj: adjB, otherPlan: planB, item: evalResult.items[0] },
        { adj: adjB, plan: planB, otherAdj: adjA, otherPlan: planA, item: evalResult.items[1] },
      ];
      for (const { adj, plan, otherAdj, otherPlan, item } of entries) {
        await client.query(
          `UPDATE plans
              SET start_date = $2, end_date = $3, light_periods = $4::jsonb,
                  estimated_lux = $5, review_reason = NULL, updated_at = now()
            WHERE id = $1`,
          [plan.id, adj.start_date, adj.end_date, JSON.stringify(adj.light_periods), adj.estimated_lux]
        );
        await client.query(
          `UPDATE plan_adjustments
              SET status = 'approved', reviewed_by = $2, reviewed_at = now(), updated_at = now()
            WHERE id = $1`,
          [adj.id, req.sessionUser.userId]
        );
        await recordAudit(client, req.sessionUser, 'plan.adjustment.pair_approve',
          'plan_adjustment', adj.id, {
            planId: plan.id,
            exhibitId: plan.exhibit_id,
            pairWith: otherAdj.id,
            pairPlanId: otherPlan.id,
            oldResidueYearly: item.oldResidueYearly,
            newResidueYearly: item.newResidueYearly,
            oldValues: planOriginalValues(plan),
            newValues: {
              startDate: dateYmd(adj.start_date),
              endDate: dateYmd(adj.end_date),
              periods: adj.light_periods,
              estimatedLux: Number(adj.estimated_lux),
            },
          });
        await recordAudit(client, req.sessionUser, 'plan.update_via_adjustment', 'plan', plan.id, {
          adjustmentId: adj.id,
          pairWith: otherAdj.id,
          oldResidueYearly: item.oldResidueYearly,
          newResidueYearly: item.newResidueYearly,
        });
      }

      const detailAfter = await exhibitDetail(client, exhibitId, { lock: true });
      return {
        ...detailAfter,
        pairApproval: {
          adjustmentIds: [idA, idB],
          planIds: [planA.id, planB.id],
          items: evalResult.items,
          yearlyReport: evalResult.yearlyReport,
        },
      };
    });

    res.json(detail);
  } catch (err) {
    next(err);
  }
});

/** 保管员批准调整申请。 */
router.post('/:id/approve', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await query('SELECT exhibit_id, plan_id FROM plan_adjustments WHERE id = $1', [id]);
    if (row.rows.length === 0) throw new ValidationError('调整申请不存在');
    const exhibitId = row.rows[0].exhibit_id;

    const detail = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);
      const adjRows = await client.query('SELECT * FROM plan_adjustments WHERE id = $1 FOR UPDATE', [id]);
      const adj = adjRows.rows[0];
      if (!adj) throw new ValidationError('调整申请不存在');
      if (adj.status !== 'pending') {
        throw new ValidationError(`该调整申请当前状态（${adj.status}）不能批准`);
      }
      const plan = await getPlan(client, adj.plan_id);

      // 批准时在展品锁事务内重新核对全部规则
      const evalResult = await evaluateAdjustment(client, plan, adj);
      if (!evalResult.ok) {
        const c = evalResult.conflicts;
        const parts = [];
        if (c.notApproved) parts.push(`计划已不是“已批准”状态（当前：${plan.status}）`);
        if (c.notStarted) parts.push('计划已经开始');
        for (const m of c.outsideMeasurements) {
          parts.push(
            `未作废实测 #${m.id}（${m.start} ~ ${m.end}，${m.status}）不在新开灯窗内`
          );
        }
        for (const b of c.outsideBlackouts || []) {
          parts.push(
            `停灯记录 #${b.id}（${b.start} ~ ${b.end}）不在新开灯窗内（停灯记录保留、不可改删，请把新窗覆盖该时段）`
          );
        }
        for (const p of c.overlappingPlans) {
          parts.push(`与同展品${p.status === 'pending_review' ? '待复核' : '已批准'}计划「${p.title}」(#${p.id}) 开灯时间重叠`);
        }
        for (const y of c.missingLimits) parts.push(`${y} 年尚未登记年度额度`);
        for (const o of c.overflows) {
          parts.push(
            `${o.year} 年：上限 ${o.limit}，其他占用 ${o.usedByOthers}，原残余 ${o.oldResidue}，` +
              `拟改残余 ${o.newResidue}，合计 ${o.projected}，超额 ${o.excess} lx·h`
          );
        }
        // 校验失败：申请保持待审，以便布展员撤回后重提；事务回滚，不改计划
        throw new ConflictError(`调整申请 #${id} 未通过核对：` + parts.join('；'), {
          adjustmentId: id,
          conflicts: c,
          yearlyReport: evalResult.yearlyReport,
        });
      }

      // 通过：原子更新计划 + 结案申请 + 审计
      await client.query(
        `UPDATE plans
            SET start_date = $2, end_date = $3, light_periods = $4::jsonb,
                estimated_lux = $5, review_reason = NULL, updated_at = now()
          WHERE id = $1`,
        [plan.id, adj.start_date, adj.end_date, JSON.stringify(adj.light_periods), adj.estimated_lux]
      );
      await client.query(
        `UPDATE plan_adjustments
            SET status = 'approved', reviewed_by = $2, reviewed_at = now(), updated_at = now()
          WHERE id = $1`,
        [id, req.sessionUser.userId]
      );
      await recordAudit(client, req.sessionUser, 'plan.adjustment.approve',
        'plan_adjustment', id, {
          planId: plan.id,
          exhibitId: plan.exhibit_id,
          oldResidueYearly: evalResult.oldResidueYearly,
          newResidueYearly: evalResult.newResidueYearly,
          oldValues: {
            startDate: String(plan.start_date).slice(0, 10),
            endDate: String(plan.end_date).slice(0, 10),
            periods: plan.light_periods,
            estimatedLux: Number(plan.estimated_lux),
          },
          newValues: {
            startDate: String(adj.start_date).slice(0, 10),
            endDate: String(adj.end_date).slice(0, 10),
            periods: adj.light_periods,
            estimatedLux: Number(adj.estimated_lux),
          },
        });
      await recordAudit(client, req.sessionUser, 'plan.update_via_adjustment', 'plan', plan.id, {
        adjustmentId: id,
        oldResidueYearly: evalResult.oldResidueYearly,
        newResidueYearly: evalResult.newResidueYearly,
      });

      return exhibitDetail(client, plan.exhibit_id, { lock: true });
    });

    res.json(detail);
  } catch (err) {
    next(err);
  }
});

/** 保管员驳回调整申请：不改变计划，申请结案为 rejected。 */
router.post('/:id/reject', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const reason =
      req.body && req.body.reason ? String(req.body.reason).slice(0, 1000) : null;
    const row = await query('SELECT exhibit_id FROM plan_adjustments WHERE id = $1', [id]);
    if (row.rows.length === 0) throw new ValidationError('调整申请不存在');
    const result = await withExhibitTransaction(row.rows[0].exhibit_id, async (client) => {
      await lockExhibit(client, row.rows[0].exhibit_id);
      const adjRows = await client.query('SELECT * FROM plan_adjustments WHERE id = $1 FOR UPDATE', [id]);
      const adj = adjRows.rows[0];
      if (!adj) throw new ValidationError('调整申请不存在');
      if (adj.status !== 'pending') {
        throw new ValidationError(`该调整申请当前状态（${adj.status}）不能驳回`);
      }
      await client.query(
        `UPDATE plan_adjustments
            SET status = 'rejected', reject_reason = $2, reviewed_by = $3,
                reviewed_at = now(), updated_at = now()
          WHERE id = $1`,
        [id, reason, req.sessionUser.userId]
      );
      await recordAudit(client, req.sessionUser, 'plan.adjustment.reject',
        'plan_adjustment', id, { planId: adj.plan_id, reason });

      const plan = await getPlan(client, adj.plan_id);
      const [decorated] = await decoratePlans(client, [plan]);
      return { ok: true, adjustmentId: id, plan: decorated };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** 布展员撤回自己的待审调整申请；保管员可撤回任何待审申请。撤回后可重新提交。 */
router.post('/:id/withdraw', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await query('SELECT exhibit_id FROM plan_adjustments WHERE id = $1', [id]);
    if (row.rows.length === 0) throw new ValidationError('调整申请不存在');
    const result = await withExhibitTransaction(row.rows[0].exhibit_id, async (client) => {
      await lockExhibit(client, row.rows[0].exhibit_id);
      const adjRows = await client.query('SELECT * FROM plan_adjustments WHERE id = $1 FOR UPDATE', [id]);
      const adj = adjRows.rows[0];
      if (!adj) throw new ValidationError('调整申请不存在');
      if (adj.status !== 'pending') {
        throw new ValidationError(`该调整申请当前状态（${adj.status}）不能撤回`);
      }
      const isOwner = Number(adj.created_by) === req.sessionUser.userId;
      const isConservator = req.sessionUser.role === 'conservator';
      if (!isOwner && !isConservator) {
        throw new AuthError('只能撤回自己提交的调整申请', 403);
      }
      await client.query(
        `UPDATE plan_adjustments
            SET status = 'withdrawn', reviewed_by = CASE WHEN $2 THEN $3 ELSE reviewed_by END,
                reviewed_at = now(), updated_at = now()
          WHERE id = $1`,
        [id, isConservator, req.sessionUser.userId]
      );
      await recordAudit(client, req.sessionUser, 'plan.adjustment.withdraw',
        'plan_adjustment', id, { planId: adj.plan_id, byConservator: isConservator });

      const plan = await getPlan(client, adj.plan_id);
      const [decorated] = await decoratePlans(client, [plan]);
      return { ok: true, adjustmentId: id, plan: decorated };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
