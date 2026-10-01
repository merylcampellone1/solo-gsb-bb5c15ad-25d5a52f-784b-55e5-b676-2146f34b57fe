'use strict';

const express = require('express');
const { query, withExhibitTransaction } = require('../db');
const { requireRole, requireAuth } = require('../auth');
const { recordAudit } = require('../audit');
const {
  ValidationError,
  nonEmptyString,
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
