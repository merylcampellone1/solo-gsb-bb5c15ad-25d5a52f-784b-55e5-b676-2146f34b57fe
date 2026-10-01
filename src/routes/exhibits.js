'use strict';

const express = require('express');
const { query, withTransaction, withExhibitTransaction } = require('../db');
const { requireRole } = require('../auth');
const { recordAudit } = require('../audit');
const { ValidationError, ConflictError, nonEmptyString, positiveNumber } = require('../validation');
const { computeOccupancy, lockExhibit, decoratePlans, computeLimitPreview } = require('../service');
const { tsToWallString } = require('../dosing');
const { fingerprintSnapshot, issueVoucher, peekVoucher, consumeVoucher } = require('../limit-preview');

const router = express.Router();

function serializeMeasurement(m) {
  return {
    id: m.id,
    planId: m.plan_id,
    exhibitId: m.exhibit_id,
    start: tsToWallString(new Date(m.start_ts).getTime()),
    end: tsToWallString(new Date(m.end_ts).getTime()),
    actualLux: Number(m.actual_lux),
    status: m.status,
    note: m.note,
    createdAt: m.created_at,
  };
}

async function exhibitDetail(client, exhibitId, { lock = false } = {}) {
  const exhibit = lock ? await lockExhibit(client, exhibitId)
    : (await client.query('SELECT * FROM exhibits WHERE id = $1', [exhibitId])).rows[0];
  if (!exhibit) throw new ValidationError('展品不存在');

  const occupancy = await computeOccupancy(client, exhibitId);
  const plans = (
    await client.query(
      `SELECT p.*, u.display_name AS creator_name, a.display_name AS approver_name
         FROM plans p
         LEFT JOIN users u ON u.id = p.created_by
         LEFT JOIN users a ON a.id = p.approved_by
        WHERE p.exhibit_id = $1 ORDER BY p.id DESC`,
      [exhibitId]
    )
  ).rows;
  // 附加各计划的待审调整申请（含原值/拟改值试算），原有字段保持不变
  await decoratePlans(client, plans, { withPreview: true });
  const measurements = (
    await client.query(
      `SELECT * FROM measurements WHERE exhibit_id = $1 ORDER BY start_ts DESC, id DESC`,
      [exhibitId]
    )
  ).rows.map(serializeMeasurement);

  // 停灯记录（保留、不可改删）及各年扣减量；既有查询字段不变，仅附加新字段
  // 延迟 require 以避免与 routes/blackouts 形成循环依赖
  const { serializeBlackoutViewItem } = require('./blackouts');
  const blackouts = (occupancy.blackouts || []).map(serializeBlackoutViewItem);
  const blackoutDeductionYearly = occupancy.blackoutDeductionYearly || {};

  return {
    exhibit,
    years: occupancy.years,
    sources: occupancy.sources,
    plans,
    measurements,
    blackouts,
    blackoutDeductionYearly,
  };
}

/** 解析请求中的年份与拟定正数上限。 */
function parseYearAndLimit(body) {
  const year = Number(body.year);
  if (!Number.isInteger(year) || year < 1900 || year > 2999) {
    throw new ValidationError('年份必须是 1900-2999 之间的整数');
  }
  const limitLxh = positiveNumber(body.limitLxh, '年度照度时数上限（lx·h）');
  return { year, limitLxh };
}

/** 预演结果对外形态（剥离内部指纹原始数据，仅保留 token）。 */
function publicPreview(preview, token) {
  const { signature, ...rest } = preview;
  void signature;
  return { ...rest, token, tokenExpiresInSeconds: 600 };
}

/**
 * 下调成功后的共有处理：原子写入新上限，
 * 把本次核算列出的 flagCandidates（仍有该年估算残余且尚未开始的已批准计划）
 * 全部转为待复核并写明原因；已开始计划不转状态。
 * 原审批记录（approved_by/approved_at）与实测记录均保留（只更新状态/原因字段）。
 * 返回 { flagged, overflows }。
 */
async function applyLowerAndFlag(client, actor, exhibitId, year, previousLimit, preview, { auditAction }) {
  await client.query(
    `INSERT INTO annual_limits (exhibit_id, year, limit_lxh, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (exhibit_id, year) DO UPDATE SET limit_lxh = EXCLUDED.limit_lxh`,
    [exhibitId, year, preview.proposedLimit, actor.userId]
  );

  const flagged = [];
  if (preview.over && preview.flagCandidates.length > 0) {
    for (const fp of preview.flagCandidates) {
      const reason =
        `${year} 年照度时数上限下调（${previousLimit} → ${preview.proposedLimit} lx·h）后预计超额 ` +
        `${preview.excess} lx·h，本计划该年估算残余 ${fp.yearResidue} lx·h，转待复核`;
      // 仅当仍是已批准时才转（锁内重算后状态可能已变；状态变化本应触发指纹不一致，
      // 但旧接口（无凭证）路径允许直接修改，故这里再保护一次）
      const upd = await client.query(
        `UPDATE plans
            SET status = 'pending_review', review_reason = $2, updated_at = now()
          WHERE id = $1 AND status = 'approved'
          RETURNING id, status, review_reason`,
        [fp.id, reason]
      );
      if (upd.rows.length === 0) continue;
      await recordAudit(client, actor, 'plan.flag_review_limit_lower', 'plan', fp.id, {
        exhibitId,
        year,
        previousLimit,
        newLimit: preview.proposedLimit,
        excess: preview.excess,
        yearResidue: fp.yearResidue,
      });
      flagged.push({
        id: fp.id,
        title: fp.title,
        firstStart: fp.firstStart,
        yearResidue: fp.yearResidue,
        overflowYears: [year],
      });
    }
  }

  await recordAudit(client, actor, auditAction, 'exhibit', exhibitId, {
    year,
    previousLimit,
    limitLxh: preview.proposedLimit,
    lowered: preview.proposedLimit < previousLimit,
    excess: preview.excess,
    flaggedPlanIds: flagged.map((f) => f.id),
  });

  return {
    flagged,
    overflows: preview.over
      ? [{
          year,
          limit: preview.proposedLimit,
          previousLimit,
          projected: preview.used,
          excess: preview.excess,
        }]
      : [],
  };
}

// 展品列表（带每展品年度额度概况）
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM exhibits ORDER BY id');
    const items = [];
    for (const e of rows) {
      const occupancy = await computeOccupancy({ query }, e.id);
      items.push({ ...e, years: occupancy.years });
    }
    res.json({ exhibits: items });
  } catch (err) {
    next(err);
  }
});

// 展品详情：剩余额度、占用来源、计划、实测
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const detail = await exhibitDetail({ query }, id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

// 保管员登记展品
router.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const name = nonEmptyString(req.body.name, '展品名称', 200);
    const accessionNo = req.body.accessionNo ? nonEmptyString(req.body.accessionNo, '编号', 100) : null;
    const medium = req.body.medium ? nonEmptyString(req.body.medium, '材质', 200) : null;
    const note = typeof req.body.note === 'string' ? req.body.note.slice(0, 1000) : null;

    const { rows } = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO exhibits (name, accession_no, medium, note, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, accessionNo, medium, note, req.sessionUser.userId]
      );
      await recordAudit(client, req.sessionUser, 'exhibit.create', 'exhibit', inserted.rows[0].id, { name });
      return inserted;
    });
    res.status(201).json({ exhibit: rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * 下调年度上限预演（不改状态）：
 * 返回预演凭证 + 该年已确认实测、各计划估算残余、预计超额量、
 * 以及超额时仍有该年估算残余且尚未开始的已批准计划。
 */
router.post('/:id/limits/preview', requireRole('conservator'), async (req, res, next) => {
  try {
    const exhibitId = Number(req.params.id);
    const { year, limitLxh } = parseYearAndLimit(req.body || {});
    const result = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);
      const preview = await computeLimitPreview(client, exhibitId, year, limitLxh);
      if (!(limitLxh < preview.currentLimit)) {
        throw new ValidationError(
          `拟定上限 ${limitLxh} 不低于现行上限 ${preview.currentLimit}，不属于下调；` +
          '如需调整请使用“保存上限”'
        );
      }
      const now = Date.now();
      const fingerprint = fingerprintSnapshot(preview.signature);
      const token = issueVoucher({
        userId: req.sessionUser.userId,
        exhibitId,
        year,
        proposedLimit: limitLxh,
        fingerprint,
      }, now);
      return publicPreview(preview, token);
    });
    res.json({ preview: result });
  } catch (err) {
    next(err);
  }
});

/**
 * 携预演凭证提交下调：
 * 同一展品锁事务内即时重算；额度或相关占用自预演以来已变化（指纹不一致）则拒绝，
 * 返回最新核算结果与新凭证（details.preview / details.token），状态不变。
 * 通过则原子更新上限、保留原审批与实测，并把本次核算列出的计划转为待复核。
 */
router.post('/:id/limits/lower', requireRole('conservator'), async (req, res, next) => {
  try {
    const exhibitId = Number(req.params.id);
    const { year, limitLxh } = parseYearAndLimit(req.body || {});
    const token = req.body && req.body.token;

    // 先在锁外校验凭证基本形态（缺失/过期/字段不符），避免无谓开事务
    // 真正的“占用是否变化”校验必须在锁内重算后进行。
    const detail = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);

      const preview = await computeLimitPreview(client, exhibitId, year, limitLxh);
      const now = Date.now();

      // 缺失/过期/字段不符/他人凭证：400，且不消耗任何凭证（peek 只读）
      const voucher = peekVoucher(token, {
        userId: req.sessionUser.userId,
        exhibitId,
        year,
        proposedLimit: limitLxh,
      }, now);

      // 状态变化类拒绝（指纹不一致，含现行上限已被他人改动到不高于拟定上限的情形）
      // 一律 409 + 最新结果与新凭证，且不消耗旧凭证。
      const issueStale = () => {
        const freshToken = issueVoucher({
          userId: req.sessionUser.userId,
          exhibitId,
          year,
          proposedLimit: limitLxh,
          fingerprint: fingerprintSnapshot(preview.signature),
        }, now);
        throw new ConflictError(
          `自预演以来 ${year} 年额度或相关占用已变化，本次下调未执行；请按最新核算结果确认后重新提交`,
          { preview: publicPreview(preview, freshToken) }
        );
      };

      if (!(limitLxh < preview.currentLimit)) {
        // 现行上限已被他人下调到不高于拟定上限：属“额度已变化”，返回最新结果
        issueStale();
      }

      // 锁内重算指纹与凭证签发时不一致 -> 拒绝并返回新结果（含新凭证）
      if (fingerprintSnapshot(preview.signature) !== voucher.fingerprint) {
        issueStale();
      }

      // 全部一致，才消耗一次性凭证并落库
      consumeVoucher(token, {
        userId: req.sessionUser.userId,
        exhibitId,
        year,
        proposedLimit: limitLxh,
      }, now);

      const previousLimit = preview.currentLimit;
      const { flagged, overflows } = await applyLowerAndFlag(
        client, req.sessionUser, exhibitId, year, previousLimit, preview,
        { auditAction: 'limit.lower' }
      );

      // 成功响应与既有额度修改接口兼容：展品详情字段位于顶层
      const detailAfter = await exhibitDetail(client, exhibitId, { lock: true });
      return {
        ...detailAfter,
        year,
        previousLimit,
        newLimit: limitLxh,
        flaggedPlans: flagged,
        overflows,
      };
    });

    res.json(detail);
  } catch (err) {
    next(err);
  }
});

// 保管员登记/修改某展品某自然年的照度时数上限（成功响应保持兼容：仍返回展品详情）
router.post('/:id/limits', requireRole('conservator'), async (req, res, next) => {
  try {
    const exhibitId = Number(req.params.id);
    const { year, limitLxh } = parseYearAndLimit(req.body || {});

    const detail = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);

      // 先在旧上限下即时重算（同一事务），得到超额与待转计划
      let previousLimit = null;
      let preview = null;
      let lowerOutcome = { flagged: [], overflows: [] };
      const prevRows = await client.query(
        'SELECT limit_lxh FROM annual_limits WHERE exhibit_id = $1 AND year = $2',
        [exhibitId, year]
      );
      if (prevRows.rows.length > 0) {
        previousLimit = Number(prevRows.rows[0].limit_lxh);
      }
      if (previousLimit !== null && limitLxh < previousLimit) {
        preview = await computeLimitPreview(client, exhibitId, year, limitLxh);
        lowerOutcome = await applyLowerAndFlag(
          client, req.sessionUser, exhibitId, year, previousLimit, preview,
          { auditAction: 'limit.upsert' }
        );
      } else {
        // 新登记或上调：仅更新上限（不转任何计划状态）
        await client.query(
          `INSERT INTO annual_limits (exhibit_id, year, limit_lxh, created_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (exhibit_id, year) DO UPDATE SET limit_lxh = EXCLUDED.limit_lxh`,
          [exhibitId, year, limitLxh, req.sessionUser.userId]
        );
        await recordAudit(client, req.sessionUser, 'limit.upsert', 'exhibit', exhibitId, {
          year,
          previousLimit,
          limitLxh,
          lowered: false,
        });
      }
      const detailAfter = await exhibitDetail(client, exhibitId, { lock: true });
      return {
        ...detailAfter,
        // 兼容字段之外，附带本次下调核算结果（不下调时为空数组，不影响既有消费者）
        limitLowered: lowerOutcome.overflows.length > 0
          ? { year, previousLimit, newLimit: limitLxh, excess: lowerOutcome.overflows[0].excess }
          : null,
        flaggedPlans: lowerOutcome.flagged,
        overflows: lowerOutcome.overflows,
      };
    });
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

module.exports = { router, exhibitDetail, serializeMeasurement };
