'use strict';

const express = require('express');
const { query, withExhibitTransaction } = require('../db');
const { requireRole } = require('../auth');
const { recordAudit } = require('../audit');
const {
  ValidationError,
  assertDate,
  nonEmptyString,
  parseTimeToMinutes,
} = require('../validation');
const {
  lockExhibit,
  getPlan,
  loadBlackoutView,
  registerBlackout,
} = require('../service');
const { wallToTs, tsToWallString, yearMapToObject, doseByYear } = require('../dosing');

const router = express.Router();

router.use(require('../auth').requireAuth);

/** 停灯记录对外字段（驼峰）；yearly 为该记录从估算中扣减的按年剂量（lx·h）。 */
function serializeBlackout(b) {
  const start = b.start != null ? b.start : tsToWallString(new Date(b.start_ts).getTime());
  const end = b.end != null ? b.end : tsToWallString(new Date(b.end_ts).getTime());
  return {
    id: b.id,
    planId: Number(b.plan_id != null ? b.plan_id : b.planId),
    exhibitId: Number(b.exhibit_id != null ? b.exhibit_id : b.exhibitId),
    planTitle: b.plan_title != null ? b.plan_title : b.planTitle,
    planStatus: b.plan_status != null ? b.plan_status : b.planStatus,
    start,
    end,
    reason: b.reason,
    createdBy: b.created_by != null ? b.created_by : b.createdBy,
    creatorName: b.creator_name != null ? b.creator_name : (b.creatorName || null),
    createdAt: b.created_at,
    yearly: b.yearly || {},
    deductionActive: b.deductionActive !== false,
  };
}

/** loadBlackoutView 返回的驼峰对象规范化（补默认字段）。 */
function serializeBlackoutViewItem(b) {
  return serializeBlackout({
    id: b.id,
    plan_id: b.planId,
    exhibit_id: b.exhibitId,
    plan_title: b.planTitle,
    plan_status: b.planStatus,
    start: b.start,
    end: b.end,
    reason: b.reason,
    created_by: b.createdBy,
    creator_name: b.creatorName,
    created_at: b.createdAt,
    yearly: b.yearly,
    deductionActive: b.deductionActive,
  });
}

/**
 * 停灯记录列表（只读，任何登录用户均可查；布展员只读）。
 * 过滤参数（均可空）：exhibitId / planId。
 * 返回逐条记录（附按年扣减量）与按展品汇总的各年扣减量 blackoutDeductionByExhibit。
 */
router.get('/', async (req, res, next) => {
  try {
    const exhibitId = req.query.exhibitId ? Number(req.query.exhibitId) : null;
    const planId = req.query.planId ? Number(req.query.planId) : null;
    if (exhibitId !== null && !Number.isInteger(exhibitId)) {
      throw new ValidationError('展品 ID 无效');
    }
    if (planId !== null && !Number.isInteger(planId)) {
      throw new ValidationError('计划 ID 无效');
    }

    let targetExhibitIds;
    if (exhibitId !== null) {
      targetExhibitIds = [exhibitId];
    } else if (planId !== null) {
      const pre = await query('SELECT exhibit_id FROM plans WHERE id = $1', [planId]);
      if (pre.rows.length === 0) throw new ValidationError('计划不存在');
      targetExhibitIds = [pre.rows[0].exhibit_id];
    } else {
      const { rows } = await query('SELECT id FROM exhibits ORDER BY id');
      targetExhibitIds = rows.map((r) => r.id);
    }

    const items = [];
    const deductionByExhibit = {};
    for (const exId of targetExhibitIds) {
      const view = await loadBlackoutView({ query }, exId);
      let list = view.items;
      if (planId !== null) list = list.filter((b) => Number(b.planId) === planId);
      items.push(...list);
      deductionByExhibit[String(exId)] = view.totalDeductionYearly;
    }
    items.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : b.id - a.id));

    res.json({
      blackouts: items.map(serializeBlackoutViewItem),
      blackoutDeductionByExhibit: deductionByExhibit,
    });
  } catch (err) {
    next(err);
  }
});

/** 解析停灯时段请求体：{ planId, startDate, startTime, endDate, endTime, reason }。 */
function parseBlackoutBody(body) {
  const planId = Number(body.planId);
  if (!Number.isInteger(planId)) throw new ValidationError('计划 ID 无效');
  const startDate = assertDate(body.startDate, '停灯开始日期');
  const endDate = body.endDate ? assertDate(body.endDate, '停灯结束日期') : startDate;
  const startMinute = parseTimeToMinutes(body.startTime);
  const endMinute = parseTimeToMinutes(body.endTime);
  if (endDate < startDate) throw new ValidationError('停灯结束日期不能早于开始日期');
  const reason = nonEmptyString(body.reason, '停灯原因', 1000);
  return {
    planId,
    startMs: wallToTs(startDate, startMinute),
    endMs: wallToTs(endDate, endMinute),
    reason,
  };
}

/**
 * 保管员登记停灯时段：
 *  - 仅已批准/待复核计划；起点早于终点；结束不晚于当前时间
 *  - 完整落在该计划开灯窗内
 *  - 不与同展品未作废实测（含待确认）或其他停灯记录相交
 * 失败一次性指出全部冲突（409），不保存；停灯记录一经保存不可修改/删除。
 * 成功返回更新后的展品详情（兼容既有字段，另附 blackout 与按年扣减量）。
 */
router.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const input = parseBlackoutBody(req.body || {});
    const prePlan = await getPlan({ query }, input.planId);

    const detail = await withExhibitTransaction(prePlan.exhibit_id, async (client) => {
      await lockExhibit(client, prePlan.exhibit_id);
      const row = await registerBlackout(client, input, req.sessionUser);
      const plan = await getPlan(client, input.planId);

      // 按年扣减量（登记时已保证完整落在计划窗内且不与实测相交，按计划预计照度拆分）
      const yearly = yearMapToObject(
        doseByYear([{ start: input.startMs, end: input.endMs }], Number(plan.estimated_lux))
      );
      await recordAudit(client, req.sessionUser, 'blackout.create', 'blackout', row.id, {
        planId: plan.id,
        exhibitId: plan.exhibit_id,
        start: tsToWallString(input.startMs),
        end: tsToWallString(input.endMs),
        reason: input.reason,
        estimatedDeductionYearly: yearly,
      });

      const { exhibitDetail } = require('./exhibits');
      const detailAfter = await exhibitDetail(client, plan.exhibit_id, { lock: true });
      // 取登记人名（拆简单查询，规避内存驱动 JOIN 缺陷）
      const created = (await client.query('SELECT * FROM blackouts WHERE id = $1', [row.id])).rows[0];
      let creatorName = null;
      if (created.created_by) {
        const u = await client.query('SELECT display_name FROM users WHERE id = $1', [created.created_by]);
        creatorName = u.rows[0] ? u.rows[0].display_name : null;
      }
      return {
        ...detailAfter,
        blackout: serializeBlackout({ ...created, plan_title: plan.title, plan_status: plan.status, creator_name: creatorName, yearly }),
      };
    });

    res.status(201).json(detail);
  } catch (err) {
    next(err);
  }
});

// 停灯记录永久保留：不提供修改/删除接口，显式拒绝并给出中文原因。
router.all('/:id', (req, _res, next) => {
  next(new ValidationError(`停灯记录保留，不可${req.method === 'DELETE' ? '删除' : '修改'}`));
});

module.exports = { router, serializeBlackout, serializeBlackoutViewItem };
