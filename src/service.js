'use strict';

const {
  ValidationError,
  ConflictError,
  parsePeriods,
  assertDate,
  positiveNumber,
  nonEmptyString,
} = require('./validation');
const {
  buildWindows,
  doseByYear,
  subtractIntervals,
  yearMapToObject,
  addYearDose,
  intersects,
  containsInterval,
  anyIntersect,
  clipIntervalToWindows,
  round3,
  wallToTs,
  tsToWallString,
  yearOfTs,
} = require('./dosing');

const ACTIVE_PLAN_STATUSES = ['approved', 'pending_review'];
const PENDING_ADJUSTMENT = 'pending';

/** 规范化 DATE 值：真实 pg 经类型解析返回 'YYYY-MM-DD'；个别驱动（如内存测试）可能给 Date。 */
function dateYmd(v) {
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(
      v.getUTCDate()
    ).padStart(2, '0')}`;
  }
  return v;
}

/** 读取展品（可加行锁，事务内批准/确认时使用）。 */
async function lockExhibit(client, exhibitId) {
  const { rows } = await client.query('SELECT * FROM exhibits WHERE id = $1 FOR UPDATE', [exhibitId]);
  if (rows.length === 0) throw new ValidationError('展品不存在');
  return rows[0];
}

async function getPlan(client, planId) {
  const { rows } = await client.query('SELECT * FROM plans WHERE id = $1', [planId]);
  if (rows.length === 0) throw new ValidationError('计划不存在');
  return rows[0];
}

/** 取该展品占用额度的计划（已批准、待复核）。excludePlanId 用于把待批计划自身排除。 */
async function getOccupyingPlans(client, exhibitId, excludePlanId = null) {
  // 状态为模块内固定白名单，直接内联到 SQL（避免不同驱动对 ANY($) 数组绑定的差异）
  const statusList = ACTIVE_PLAN_STATUSES.map((s) => `'${s}'`).join(',');
  const { rows } = await client.query(
    `SELECT * FROM plans
      WHERE exhibit_id = $1 AND status IN (${statusList})
        AND ($2::bigint IS NULL OR id <> $2)
      ORDER BY id`,
    [exhibitId, excludePlanId]
  );
  return rows;
}

async function getActiveMeasurements(client, exhibitId) {
  const { rows } = await client.query(
    `SELECT m.*, p.status AS plan_status
       FROM measurements m JOIN plans p ON p.id = m.plan_id
      WHERE m.exhibit_id = $1 AND m.status = 'confirmed'
      ORDER BY m.start_ts`,
    [exhibitId]
  );
  return rows;
}

function planWindows(plan) {
  return buildWindows(dateYmd(plan.start_date), dateYmd(plan.end_date), parsePeriods(normalizePeriods(plan.light_periods)));
}

/** JSONB 开灯时段：真实 pg 驱动返回数组，个别驱动（如内存测试）返回字符串，统一成数组。 */
function normalizePeriods(value) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (_) {
      throw new ValidationError('开灯时段数据格式无效');
    }
  }
  return value;
}

/**
 * 读取展品的全部停灯记录（永久保留，计划已取消/驳回也带出），附计划字段供按窗计算。
 * 仅 planId 过滤时返回该计划的停灯（用于调整核对窗外判定）。
 * 注意：拆成多条简单查询而非 JOIN —— 个别内存驱动（pg-mem）对多表 JOIN 的实现有缺陷。
 */
async function getBlackoutRows(client, exhibitId, { planId = null } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM blackouts
      WHERE exhibit_id = $1
        AND ($2::bigint IS NULL OR plan_id = $2)
      ORDER BY start_ts, id`,
    [exhibitId, planId]
  );
  if (rows.length === 0) return rows;
  const planIds = [...new Set(rows.map((r) => Number(r.plan_id)))];
  const placeholders = planIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows: planRows } = await client.query(
    `SELECT id, title, status, start_date, end_date, light_periods, estimated_lux
       FROM plans WHERE id IN (${placeholders})`,
    planIds
  );
  const planById = new Map(planRows.map((p) => [Number(p.id), p]));
  const userIds = [...new Set(rows.map((r) => r.created_by).filter(Boolean))];
  const userMap = new Map();
  if (userIds.length > 0) {
    const uph = userIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: userRows } = await client.query(
      `SELECT id, display_name FROM users WHERE id IN (${uph})`,
      userIds
    );
    for (const u of userRows) userMap.set(Number(u.id), u.display_name);
  }
  return rows.map((row) => {
    const p = planById.get(Number(row.plan_id));
    return {
      ...row,
      plan_title: p ? p.title : null,
      plan_status: p ? p.status : null,
      plan_start_date: p ? p.start_date : null,
      plan_end_date: p ? p.end_date : null,
      plan_light_periods: p ? p.light_periods : null,
      plan_estimated_lux: p ? p.estimated_lux : null,
      creator_name: row.created_by ? userMap.get(Number(row.created_by)) || null : null,
    };
  });
}

/**
 * 一条停灯记录“从估算中实际扣减”的有效时间窗：
 *   停灯区间 ∩ 所属计划开灯窗 − 同展品全部已确认实测覆盖。
 * 口径：停灯只从所属计划未被已确认实测覆盖的估算时段扣除；与实测相交的部分（业务上互斥，
 * 此处为防御性处理）不扣估算（该部分由实测计量）。
 */
function effectiveBlackoutWindows(row, planWindowsById, confirmedWindows) {
  const windows = planWindowsById.get(Number(row.plan_id)) || [];
  const clipped = clipIntervalToWindows(
    { start: new Date(row.start_ts).getTime(), end: new Date(row.end_ts).getTime() },
    windows
  );
  return subtractIntervals(clipped, confirmedWindows);
}

/**
 * 构造展品停灯视图：每条记录附按年扣减量（按其所属计划预计照度，按自然年拆分）。
 * 返回 { items, windowsByPlan: Map<planId, [{start,end}有效扣减窗]>,
 *        totalDeductionYearly: {year: dose} }
 *
 * 口径说明：
 *  - 停灯记录永久保留；所属计划已不再占用（取消/驳回）时，记录照常列出并给出“若按当前计划窗
    *    计算的名义扣减量”，但 isActive=false 且不计入 totalDeductionYearly（computeOccupancy 本就
    *    不含这些计划的估算残余）。
 *  - confirmedRows: 该展品已确认实测行（默认自行查询）。
 */
async function loadBlackoutView(client, exhibitId, { confirmedRows = null } = {}) {
  const rows = await getBlackoutRows(client, exhibitId);
  const activePlans = await getOccupyingPlans(client, exhibitId);
  const activeIds = new Set(activePlans.map((p) => Number(p.id)));
  const measurements = confirmedRows || (await getActiveMeasurements(client, exhibitId));
  const confirmedWindows = measurements.map((m) => ({
    start: new Date(m.start_ts).getTime(),
    end: new Date(m.end_ts).getTime(),
  }));

  // 以记录联表的计划字段构造计划窗（含已取消计划，便于给出名义扣减量）
  const planWindowsById = new Map();
  const planLuxById = new Map();
  for (const row of rows) {
    const pid = Number(row.plan_id);
    if (!planWindowsById.has(pid)) {
      planWindowsById.set(pid, buildWindows(
        dateYmd(row.plan_start_date),
        dateYmd(row.plan_end_date),
        parsePeriods(normalizePeriods(row.plan_light_periods))
      ));
      planLuxById.set(pid, Number(row.plan_estimated_lux));
    }
  }

  const windowsByPlan = new Map();
  const totalDeductionYearly = {};
  const items = rows.map((row) => {
    const pid = Number(row.plan_id);
    const eff = effectiveBlackoutWindows(row, planWindowsById, confirmedWindows);
    const yearly = yearMapToObject(doseByYear(eff, planLuxById.get(pid)));
    const isActive = activeIds.has(pid);
    if (isActive) {
      if (!windowsByPlan.has(pid)) windowsByPlan.set(pid, []);
      windowsByPlan.get(pid).push(...eff);
      addYearDose(totalDeductionYearly, yearly);
    }
    return {
      id: row.id,
      planId: pid,
      exhibitId: Number(row.exhibit_id),
      planTitle: row.plan_title,
      planStatus: row.plan_status,
      start: tsToWallString(new Date(row.start_ts).getTime()),
      end: tsToWallString(new Date(row.end_ts).getTime()),
      reason: row.reason,
      createdBy: row.created_by,
      creatorName: row.creator_name || null,
      createdAt: row.created_at,
      yearly,
      deductionActive: isActive,
    };
  });

  return { items, windowsByPlan, totalDeductionYearly };
}

/** 取同展品与给定区间相交的未作废实测（含待确认草稿），排除 excludeId。 */
async function findOverlappingMeasurement(client, exhibitId, startMs, endMs, excludeId = null) {
  const { rows } = await client.query(
    `SELECT id, start_ts, end_ts FROM measurements
      WHERE exhibit_id = $1 AND status <> 'annulled'
        AND ($4::bigint IS NULL OR id <> $4)
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id
      LIMIT 1`,
    [exhibitId, new Date(startMs), new Date(endMs), excludeId]
  );
  return rows[0] || null;
}

/** 取同展品与给定区间相交的其他停灯记录（停灯永久保留，无作废状态），排除 excludeId。 */
async function findOverlappingBlackout(client, exhibitId, startMs, endMs, excludeId = null) {
  // 不使用 JOIN：个别内存驱动（pg-mem）对 JOIN + 时间不等式组合的实现有缺陷
  const { rows } = await client.query(
    `SELECT id, plan_id, start_ts, end_ts FROM blackouts
      WHERE exhibit_id = $1
        AND ($4::bigint IS NULL OR id <> $4)
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id
      LIMIT 1`,
    [exhibitId, new Date(startMs), new Date(endMs), excludeId]
  );
  return rows[0] || null;
}

/**
 * 计划在扣除“已确认实测覆盖 + 本计划停灯”后的估算剂量（按年）。
 * 统一扣减口径：批准/复核、占用查询、调整试算/成对核准、上限下调预演均经此或同构逻辑。
 */
function planResidueYearly(plan, measWindows, blackoutWindowsByPlan) {
  const windows = planWindows(plan);
  const coverers = measWindows.filter((mw) => windows.some((w) => intersects(w, mw)));
  const blackouts = (blackoutWindowsByPlan && blackoutWindowsByPlan.get(Number(plan.id))) || [];
  const remaining = subtractIntervals(windows, [...coverers, ...blackouts]);
  return yearMapToObject(doseByYear(remaining, Number(plan.estimated_lux)));
}

/**
 * 计算一件展品的年度额度占用。
 * 口径：
 *   used[year] = Σ 已确认实测剂量（按时窗自然年拆分）
 *              + Σ 已批准/待复核计划“未被已确认实测覆盖、且扣除本计划停灯后”的估算剂量
 * 同一计划窗口先被该展品全部已确认实测（通常即本计划的实测）与本计划停灯扣除，再按其照度估算，
 * 因此实测确认后该时段自动以实测替代估算；停灯时段自动从估算中扣减（不扣实测、不释放排期）。
 */
async function computeOccupancy(client, exhibitId, { excludePlanId = null, extraMeasurement = null } = {}) {
  const plans = await getOccupyingPlans(client, exhibitId, excludePlanId);
  const measurements = await getActiveMeasurements(client, exhibitId);
  const limitRows = await client.query(
    'SELECT year, limit_lxh FROM annual_limits WHERE exhibit_id = $1',
    [exhibitId]
  );
  const limits = {};
  for (const r of limitRows.rows) limits[String(r.year)] = Number(r.limit_lxh);

  const measWindows = measurements.map((m) => ({
    id: m.id,
    planId: m.plan_id,
    start: new Date(m.start_ts).getTime(),
    end: new Date(m.end_ts).getTime(),
    lux: Number(m.actual_lux),
  }));
  // 预演一条尚未确认（或刚录入）的实测，用于超额预判
  if (extraMeasurement) {
    measWindows.push({
      id: extraMeasurement.id || -1,
      planId: extraMeasurement.planId,
      start: extraMeasurement.start,
      end: extraMeasurement.end,
      lux: extraMeasurement.lux,
      draft: true,
    });
  }

  // 停灯视图：记录列表（附按年扣减量）+ 按计划分组的“有效扣减窗”（仅占用中的计划计入）
  const blackoutView = await loadBlackoutView(client, exhibitId, { confirmedRows: measurements });

  const used = {};
  const sources = [];

  // 1) 实测部分（停灯不减实测）
  for (const mw of measWindows) {
    const yearly = yearMapToObject(doseByYear([{ start: mw.start, end: mw.end }], mw.lux));
    addYearDose(used, yearly);
    sources.push({
      kind: 'measurement',
      id: mw.id,
      planId: mw.planId,
      start: tsToWallString(mw.start),
      end: tsToWallString(mw.end),
      lux: mw.lux,
      yearly,
    });
  }

  // 2) 计划的估算残余（开灯窗 − 已确认实测覆盖 − 本计划停灯）
  for (const plan of plans) {
    const yearly = planResidueYearly(plan, measWindows, blackoutView.windowsByPlan);
    addYearDose(used, yearly);
    sources.push({
      kind: 'plan',
      id: plan.id,
      title: plan.title,
      status: plan.status,
      startDate: plan.start_date,
      endDate: plan.end_date,
      periods: plan.light_periods,
      lux: Number(plan.estimated_lux),
      yearly,
    });
  }

  const years = {};
  const allYears = new Set([
    ...Object.keys(limits),
    ...Object.keys(used),
  ].map(Number));
  for (const year of [...allYears].sort((a, b) => a - b)) {
    const key = String(year);
    const usedVal = round3(used[key] || 0);
    const limitVal = limits[key] !== undefined ? round3(limits[key]) : null;
    years[key] = {
      year,
      limit: limitVal,
      used: usedVal,
      remaining: limitVal === null ? null : round3(limitVal - usedVal),
      over: limitVal === null ? false : usedVal - limitVal > 0.005,
    };
  }

  return {
    limits,
    used,
    years,
    sources,
    plans,
    measurements,
    blackouts: blackoutView.items,
    blackoutDeductionYearly: blackoutView.totalDeductionYearly,
  };
}

/** 检查新增/复核的年度剂量并入当前占用后是否超限，返回超额明细数组。 */
function buildOverflows(currentUsed, limits, addedYearly) {
  const overflows = [];
  for (const [yearStr, add] of Object.entries(addedYearly)) {
    const limit = limits[yearStr];
    if (limit === undefined || limit === null) {
      throw new ConflictError(`${yearStr} 年尚未登记年度额度，无法批准`, {
        missingLimit: yearStr,
      });
    }
    const projected = round3((currentUsed[yearStr] || 0) + add);
    if (projected - limit > 0.005) {
      overflows.push({
        year: Number(yearStr),
        limit: round3(limit),
        usedBefore: round3(currentUsed[yearStr] || 0),
        addedByThisPlan: round3(add),
        projected,
        excess: round3(projected - limit),
      });
    }
  }
  return overflows;
}

/** 计划时间窗是否与同展品另一占用计划相交。 */
function planOverlaps(targetWindows, otherPlan) {
  return anyIntersect(targetWindows, planWindows(otherPlan));
}

/**
 * 校验实测时段：
 *  - 必须落在所属已批准/待复核计划的开灯窗内
 *  - 不得与同展品任何未作废实测重叠
 *  - 不得与同展品任何停灯记录相交（停灯与实测互斥，录入或确认都拒绝）
 * 返回 { start, end, windows }（毫秒）
 */
async function validateMeasurementWindow(client, plan, startYmd, startMinute, endYmd, endMinute, excludeMeasId = null) {
  if (!ACTIVE_PLAN_STATUSES.includes(plan.status)) {
    throw new ValidationError('只有已批准（或待复核）计划才能登记实测');
  }
  const start = wallToTs(startYmd, startMinute);
  const end = wallToTs(endYmd, endMinute);
  if (!(end > start)) throw new ValidationError('实测时段结束必须晚于开始');

  const windows = planWindows(plan);
  const seg = { start, end };
  if (!windows.some((w) => containsInterval(w, seg))) {
    throw new ValidationError(
      `实测时段 ${tsToWallString(start)} ~ ${tsToWallString(end)} 不在该计划的开灯时段内`
    );
  }
  const overlap = await findOverlappingMeasurement(client, plan.exhibit_id, start, end, excludeMeasId);
  if (overlap) {
    throw new ConflictError(
      `与已登记实测 #${overlap.id}（${tsToWallString(new Date(overlap.start_ts).getTime())} ~ ` +
        `${tsToWallString(new Date(overlap.end_ts).getTime())}）时间重叠，已拒绝`,
      { overlappingMeasurementId: overlap.id }
    );
  }
  const blackoutClash = await findOverlappingBlackout(client, plan.exhibit_id, start, end);
  if (blackoutClash) {
    throw new ConflictError(
      `实测时段与停灯记录 #${blackoutClash.id}（计划 #${blackoutClash.plan_id}，` +
        `${tsToWallString(new Date(blackoutClash.start_ts).getTime())} ~ ` +
        `${tsToWallString(new Date(blackoutClash.end_ts).getTime())}）相交，已拒绝；` +
        '停灯时段不可录入实测，停灯记录亦不可修改/删除',
      { overlappingBlackoutId: blackoutClash.id, overlappingBlackoutPlanId: blackoutClash.plan_id }
    );
  }
  return { start, end, windows };
}

/**
 * 校验并登记停灯时段（由路由在展品锁事务内调用）：
 *  - 计划必须为已批准或待复核
 *  - 起点须早于终点；结束不得晚于当前时间（只登记已发生时段）
 *  - 时段必须完整落在该计划当前开灯窗内
 *  - 不得与同展品未作废实测（含待确认草稿）相交
 *  - 不得与同展品其他停灯记录相交
 *  - 原因必填
 * 全部失败一次性收集：窗口/时间类错误抛 400；冲突类抛 409 并在 details 中指出全部冲突，不保存。
 * 返回插入的停灯行。
 */
async function registerBlackout(client, { planId, startMs, endMs, reason }, actor) {
  const plan = await getPlan(client, planId);
  if (!ACTIVE_PLAN_STATUSES.includes(plan.status)) {
    throw new ValidationError(
      `只有已批准或待复核计划才能登记停灯（当前状态：${plan.status}）`
    );
  }
  if (!(endMs > startMs)) throw new ValidationError('停灯时段起点须早于终点');
  const nowMs = Date.now();
  if (endMs > nowMs) {
    throw new ValidationError(
      `停灯结束时刻（${tsToWallString(endMs)}）晚于当前时间，只能登记已发生的停灯时段`
    );
  }
  const reasonText = nonEmptyString(reason, '停灯原因', 1000);

  const windows = planWindows(plan);
  const seg = { start: startMs, end: endMs };
  if (!windows.some((w) => containsInterval(w, seg))) {
    throw new ValidationError(
      `停灯时段 ${tsToWallString(startMs)} ~ ${tsToWallString(endMs)} ` +
        '没有完整落在该计划的开灯窗内'
    );
  }

  // 冲突一次性收集：未作废实测（含草稿）与其他停灯记录
  const { rows: measRows } = await client.query(
    `SELECT id, plan_id, start_ts, end_ts, status
       FROM measurements
      WHERE exhibit_id = $1 AND status <> 'annulled'
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id`,
    [plan.exhibit_id, new Date(startMs), new Date(endMs)]
  );
  const { rows: blackoutRows } = await client.query(
    `SELECT id, plan_id, start_ts, end_ts FROM blackouts
      WHERE exhibit_id = $1
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id`,
    [plan.exhibit_id, new Date(startMs), new Date(endMs)]
  );
  if (measRows.length > 0 || blackoutRows.length > 0) {
    // 计划标题单独批量查（避免 JOIN + 时间不等式在个别内存驱动上的实现问题）
    const planIds = [...new Set(blackoutRows.map((b) => Number(b.plan_id)))];
    const titleMap = new Map();
    if (planIds.length > 0) {
      const placeholders = planIds.map((_, i) => `$${i + 1}`).join(',');
      const tRows = await client.query(
        `SELECT id, title FROM plans WHERE id IN (${placeholders})`,
        planIds
      );
      for (const t of tRows.rows) titleMap.set(Number(t.id), t.title);
    }
    const overlappingMeasurements = measRows.map((m) => ({
      id: m.id,
      planId: m.plan_id,
      status: m.status,
      start: tsToWallString(new Date(m.start_ts).getTime()),
      end: tsToWallString(new Date(m.end_ts).getTime()),
    }));
    const overlappingBlackouts = blackoutRows.map((b) => ({
      id: b.id,
      planId: b.plan_id,
      planTitle: titleMap.get(Number(b.plan_id)) || null,
      start: tsToWallString(new Date(b.start_ts).getTime()),
      end: tsToWallString(new Date(b.end_ts).getTime()),
    }));
    const parts = [];
    for (const m of overlappingMeasurements) {
      parts.push(`与${m.status === 'draft' ? '待确认' : '已确认'}实测 #${m.id}（${m.start} ~ ${m.end}）相交`);
    }
    for (const b of overlappingBlackouts) {
      parts.push(`与停灯记录 #${b.id}（计划「${b.planTitle}」，${b.start} ~ ${b.end}）相交`);
    }
    throw new ConflictError(`停灯登记失败：${parts.join('；')}，未保存`, {
      overlappingMeasurements,
      overlappingBlackouts,
    });
  }

  const inserted = await client.query(
    `INSERT INTO blackouts (plan_id, exhibit_id, start_ts, end_ts, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [planId, plan.exhibit_id, new Date(startMs), new Date(endMs), reasonText, actor.userId]
  );
  return inserted.rows[0];
}

/**
 * 迟到实测超额后，找出需要转为“待复核”的计划：
 * 同展品、已批准、在超额年份尚有估算剂量、且计划首个开灯时刻尚未开始。
 */
function plansToFlag(plans, occupancy, overflowYears, nowMs) {
  const planEstimate = new Map();
  for (const src of occupancy.sources.filter((s) => s.kind === 'plan')) {
    planEstimate.set(src.id, src.yearly);
  }
  const flagged = [];
  for (const plan of plans) {
    if (plan.status !== 'approved') continue;
    const yearly = planEstimate.get(plan.id) || {};
    if (!overflowYears.some((y) => (yearly[String(y)] || 0) > 0)) continue;
    const firstStart = Math.min(...planWindows(plan).map((w) => w.start));
    if (firstStart > nowMs) flagged.push({ plan, firstStart });
  }
  return flagged;
}

// ---------------------------------------------------------------------------
// 计划调整申请
// ---------------------------------------------------------------------------

/**
 * 规范化“新展期 + 每日开灯时段 + 预计照度”输入（创建计划与调整申请共用）。
 * 返回 { startDate, endDate, periodSpecs, periods, estimatedLux }。
 */
function normalizeScheduleInput(body, { withTitle = false } = {}) {
  const out = {};
  if (withTitle) out.title = nonEmptyString(body.title, '计划名称', 200);
  const startDate = assertDate(body.startDate, '开始日期');
  const endDate = assertDate(body.endDate, '结束日期');
  if (endDate < startDate) throw new ValidationError('结束日期不能早于开始日期');
  const rawPeriods = body.periods;
  if (!Array.isArray(rawPeriods) || rawPeriods.some((p) => typeof p !== 'string')) {
    throw new ValidationError('每日开灯时段必须是字符串数组，如 ["09:00-12:00"]');
  }
  const periods = parsePeriods(rawPeriods);
  // 规范为 HH:MM-HH:MM（允许输入 HH:MM:00）
  const periodSpecs = periods.map((p) => {
    const endMin = (p.startMin + p.durationMin) % 1440;
    const fmt = (min) =>
      `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    return `${fmt(p.startMin)}-${fmt(endMin)}`;
  });
  const estimatedLux = positiveNumber(body.estimatedLux, '预计照度（lx）', { max: 1000000 });

  // 展期最长约 5 年，防止误填导致的巨型计算
  const spanMs =
    Date.UTC(
      Number(endDate.slice(0, 4)),
      Number(endDate.slice(5, 7)) - 1,
      Number(endDate.slice(8, 10))
    ) -
    Date.UTC(
      Number(startDate.slice(0, 4)),
      Number(startDate.slice(5, 7)) - 1,
      Number(startDate.slice(8, 10))
    );
  if (spanMs / 86400000 + 1 > 1860) throw new ValidationError('展期跨度不能超过约 5 年');

  return { ...out, startDate, endDate, periodSpecs, periods, estimatedLux };
}

/** 取某计划当前唯一一份待审调整申请（无则 null）。 */
async function getPendingAdjustment(client, planId) {
  const { rows } = await client.query(
    `SELECT a.*, u.display_name AS creator_name, r.display_name AS reviewer_name
       FROM plan_adjustments a
       LEFT JOIN users u ON u.id = a.created_by
       LEFT JOIN users r ON r.id = a.reviewed_by
      WHERE a.plan_id = $1 AND a.status = 'pending'
      ORDER BY a.id DESC
      LIMIT 1`,
    [planId]
  );
  return rows[0] || null;
}

/** 取多份计划各自的待审调整申请，返回 Map<planId, adjustment>。 */
async function getPendingAdjustments(client, planIds) {
  const result = new Map();
  const ids = [...new Set(planIds.filter((id) => id !== null && id !== undefined))];
  if (ids.length === 0) return result;
  // 动态占位符，避免不同驱动对 ANY($) 数组绑定的差异
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await client.query(
    `SELECT a.*, u.display_name AS creator_name, r.display_name AS reviewer_name
       FROM plan_adjustments a
       LEFT JOIN users u ON u.id = a.created_by
       LEFT JOIN users r ON r.id = a.reviewed_by
      WHERE a.status = 'pending' AND a.plan_id IN (${placeholders})
      ORDER BY a.id DESC`,
    ids
  );
  for (const row of rows) {
    if (!result.has(Number(row.plan_id))) result.set(Number(row.plan_id), row);
  }
  return result;
}

/**
 * 计划首个开灯时刻（毫秒）。
 */
function planFirstStart(plan) {
  return Math.min(...planWindows(plan).map((w) => w.start));
}

/** 计划是否“尚未开始”（首个开灯时刻晚于 now）。 */
function planNotStarted(plan, nowMs = Date.now()) {
  return planFirstStart(plan) > nowMs;
}

/** 调整申请的拟改开灯窗（毫秒区间）。 */
function adjustmentWindows(adj) {
  return buildWindows(
    dateYmd(adj.start_date),
    dateYmd(adj.end_date),
    parsePeriods(normalizePeriods(adj.light_periods))
  );
}

/**
 * 调整申请试算（事务内、已持有展品行锁后调用）：
 * 保管员批准时重新核对的全部规则：
 *   1) 计划仍已批准且尚未开始
 *   2) 同展品所有未作废（draft/confirmed）实测都落在新开灯窗内（本计划的实测；
 *      其他计划的窗口与本计划窗口不相交，其实测必然落在新窗外，不属于本计划核对范围）
 *   3) 新窗口不与同展品其他已批准/待复核计划的开灯时刻重叠
 *   4) 按自然年：原计划“估算残余”替换为新窗口“未被已确认实测覆盖部分”的估算剂量后，
 *      任一年不得超过年度上限（未登记上限的年份也算冲突）
 * 返回 { ok, plan, windows, conflicts:{notApproved,notStarted,outsideMeasurements,
 *          overlappingPlans, overflows, missingLimits}, oldResidueYearly, newResidueYearly,
 *          occupiedWithoutPlan, yearlyReport }
 */
async function evaluateAdjustment(client, plan, adjInput, nowMs = Date.now()) {
  const targetWindows = adjustmentWindows(adjInput);
  const conflicts = {
    notApproved: plan.status !== 'approved',
    notStarted: !planNotStarted(plan, nowMs),
    outsideMeasurements: [],
    outsideBlackouts: [],
    overlappingPlans: [],
    overflows: [],
    missingLimits: [],
  };

  // 1) 未作废实测必须完整落在某个新开灯窗内（仅核对本计划的实测）
  const { rows: measRows } = await client.query(
    `SELECT id, start_ts, end_ts, status, actual_lux
       FROM measurements
      WHERE plan_id = $1 AND status <> 'annulled'
      ORDER BY id`,
    [plan.id]
  );
  for (const m of measRows) {
    const seg = {
      start: new Date(m.start_ts).getTime(),
      end: new Date(m.end_ts).getTime(),
    };
    if (!targetWindows.some((w) => containsInterval(w, seg))) {
      conflicts.outsideMeasurements.push({
        id: m.id,
        status: m.status,
        lux: Number(m.actual_lux),
        start: tsToWallString(seg.start),
        end: tsToWallString(seg.end),
      });
    }
  }

  // 1b) 已登记停灯记录永久保留，必须同样完整落在某个新开灯窗内（停灯不可改删）
  const ownBlackoutRows = await getBlackoutRows(client, plan.exhibit_id, { planId: plan.id });
  for (const b of ownBlackoutRows) {
    const seg = {
      start: new Date(b.start_ts).getTime(),
      end: new Date(b.end_ts).getTime(),
    };
    if (!targetWindows.some((w) => containsInterval(w, seg))) {
      conflicts.outsideBlackouts.push({
        id: b.id,
        start: tsToWallString(seg.start),
        end: tsToWallString(seg.end),
        reason: b.reason,
      });
    }
  }
  const ownBlackoutAllWindows = ownBlackoutRows.map((b) => ({
    start: new Date(b.start_ts).getTime(),
    end: new Date(b.end_ts).getTime(),
  }));
  // 新窗内的本计划停灯有效区间（停灯与已确认实测业务互斥，防御性再扣实测覆盖）
  const ownBlackoutsInNew = [];
  for (const hole of ownBlackoutAllWindows) {
    for (const part of clipIntervalToWindows(hole, targetWindows)) ownBlackoutsInNew.push(part);
  }

  // 2) 与同展品其他已批准/待复核计划的开灯时刻重叠
  const others = await getOccupyingPlans(client, plan.exhibit_id, plan.id);
  for (const other of others) {
    if (planOverlaps(targetWindows, other)) {
      conflicts.overlappingPlans.push({
        id: other.id,
        title: other.title,
        status: other.status,
        startDate: dateYmd(other.start_date),
        endDate: dateYmd(other.end_date),
      });
    }
  }

  // 3) 按自然年替换估算残余后的额度核算
  // 本计划已确认实测覆盖的区间（draft 不计量、仍由估算占位）
  const confirmedMeas = measRows.filter((m) => m.status === 'confirmed');
  const coverers = confirmedMeas
    .map((m) => ({ start: new Date(m.start_ts).getTime(), end: new Date(m.end_ts).getTime() }))
    .filter((mw) => targetWindows.some((w) => intersects(w, mw)));
  // 新残余 = 新窗 − 已确认实测覆盖 − 落在新窗内的本计划停灯（统一扣减口径）
  const newRemaining = subtractIntervals(targetWindows, [...coverers, ...ownBlackoutsInNew]);
  const newResidueYearly = yearMapToObject(doseByYear(newRemaining, Number(adjInput.estimated_lux)));

  const occupancy = await computeOccupancy(client, plan.exhibit_id, { excludePlanId: plan.id });
  const limits = occupancy.limits;
  const occupiedWithoutPlan = occupancy.used;

  // 原残余按年（与 computeOccupancy 对本计划的口径一致：原窗 − 全展品已确认实测 − 本计划停灯）
  const oldWindows = planWindows(plan);
  const allConfirmed = await getActiveMeasurements(client, plan.exhibit_id);
  const allMeasWindows = allConfirmed.map((m) => ({
    start: new Date(m.start_ts).getTime(),
    end: new Date(m.end_ts).getTime(),
  }));
  const ownBlackoutsInOld = [];
  for (const hole of ownBlackoutAllWindows) {
    for (const part of clipIntervalToWindows(hole, oldWindows)) ownBlackoutsInOld.push(part);
  }
  const oldRemaining = subtractIntervals(
    oldWindows,
    [
      ...allMeasWindows.filter((mw) => oldWindows.some((w) => intersects(w, mw))),
      ...ownBlackoutsInOld,
    ]
  );
  const oldResidue = yearMapToObject(doseByYear(oldRemaining, Number(plan.estimated_lux)));

  // 4) 合并每个相关年份：上限、不含本计划的占用、原残余、新残余、合计、超额
  const yearsSet = new Set([
    ...Object.keys(limits),
    ...Object.keys(occupiedWithoutPlan),
    ...Object.keys(oldResidue),
    ...Object.keys(newResidueYearly),
  ].map(Number));
  const yearlyReport = {};
  for (const year of [...yearsSet].sort((a, b) => a - b)) {
    const key = String(year);
    const limit = limits[key] !== undefined && limits[key] !== null ? round3(limits[key]) : null;
    const otherUsed = round3(occupiedWithoutPlan[key] || 0);
    const oldVal = round3(oldResidue[key] || 0);
    const newVal = round3(newResidueYearly[key] || 0);
    const projected = round3(otherUsed + newVal);
    const row = {
      year,
      limit,
      usedByOthers: otherUsed,
      oldResidue: oldVal,
      newResidue: newVal,
      projected,
      remainingAfter: limit === null ? null : round3(limit - projected),
      excess: null,
    };
    if (limit === null) {
      // 新残余占用了该年却没登记上限 -> 冲突
      if (newVal > 0) conflicts.missingLimits.push(Number(year));
    } else if (projected - limit > 0.005) {
      row.excess = round3(projected - limit);
      conflicts.overflows.push(row);
    }
    yearlyReport[key] = row;
  }

  const ok =
    !conflicts.notApproved &&
    !conflicts.notStarted &&
    conflicts.outsideMeasurements.length === 0 &&
    conflicts.outsideBlackouts.length === 0 &&
    conflicts.overlappingPlans.length === 0 &&
    conflicts.overflows.length === 0 &&
    conflicts.missingLimits.length === 0;

  return {
    ok,
    conflicts,
    windows: targetWindows,
    oldResidueYearly: oldResidue,
    newResidueYearly,
    occupiedWithoutPlan,
    yearlyReport,
  };
}

/**
 * 成对核准试算（事务内、已持有展品行锁后调用）：
 * 同一展品两份待审调整申请（两条不同计划）同时生效的核对：
 *   1) 两条计划都已批准且尚未开始
 *   2) 两条计划各自所有未作废（draft/confirmed）实测都落在各自新开灯窗内
 *   3) 两份拟改新窗彼此不重叠，且都不与同展品其他已批准/待复核计划的开灯时刻重叠
 *      （两条原计划都被替换，故二者不参与“其他计划”判定）
 *   4) 按自然年：两份旧估算残余同时替换为各自新窗“未被已确认实测覆盖部分”的估算量，
 *      任一年不得超过年度上限（未登记上限的年份也算冲突）
 * 组成性校验（同一计划/跨展品/申请已结案）在路由层拒绝，不进入本函数。
 * 返回 { ok, conflicts:{notStarted,notApproved,outsideMeasurements,pairOverlap,
 *        overlappingPlans,overflows,missingLimits}, items, yearlyReport }
 * items: 每份申请各自的 { adjustmentId, planId, title, oldResidueYearly, newResidueYearly }
 */
async function evaluateAdjustmentPair(client, planA, adjA, planB, adjB, nowMs = Date.now()) {
  const pair = [
    { plan: planA, adj: adjA, windows: adjustmentWindows(adjA) },
    { plan: planB, adj: adjB, windows: adjustmentWindows(adjB) },
  ];
  const conflicts = {
    notApproved: [],
    notStarted: [],
    outsideMeasurements: [],
    outsideBlackouts: [],
    pairOverlap: false,
    overlappingPlans: [],
    overflows: [],
    missingLimits: [],
  };

  // 1) 两条计划的状态与开始时刻
  for (const { plan, adj } of pair) {
    if (plan.status !== 'approved') {
      conflicts.notApproved.push({ adjustmentId: adj.id, planId: plan.id, status: plan.status });
    }
    if (!planNotStarted(plan, nowMs)) {
      conflicts.notStarted.push({ adjustmentId: adj.id, planId: plan.id });
    }
  }

  // 2) 各计划未作废实测必须完整落在各自新开灯窗内；同时收集各计划已确认实测
  const measByPlan = new Map();
  const blackoutsByPlan = new Map();
  for (const { plan, adj, windows } of pair) {
    const { rows: measRows } = await client.query(
      `SELECT id, start_ts, end_ts, status, actual_lux
         FROM measurements
        WHERE plan_id = $1 AND status <> 'annulled'
        ORDER BY id`,
      [plan.id]
    );
    measByPlan.set(Number(plan.id), measRows);
    for (const m of measRows) {
      const seg = {
        start: new Date(m.start_ts).getTime(),
        end: new Date(m.end_ts).getTime(),
      };
      if (!windows.some((w) => containsInterval(w, seg))) {
        conflicts.outsideMeasurements.push({
          adjustmentId: adj.id,
          planId: plan.id,
          id: m.id,
          status: m.status,
          lux: Number(m.actual_lux),
          start: tsToWallString(seg.start),
          end: tsToWallString(seg.end),
        });
      }
    }

    // 停灯记录永久保留，同样必须完整落在各自新开灯窗内
    const bRows = await getBlackoutRows(client, plan.exhibit_id, { planId: plan.id });
    blackoutsByPlan.set(Number(plan.id), bRows);
    for (const b of bRows) {
      const seg = {
        start: new Date(b.start_ts).getTime(),
        end: new Date(b.end_ts).getTime(),
      };
      if (!windows.some((w) => containsInterval(w, seg))) {
        conflicts.outsideBlackouts.push({
          adjustmentId: adj.id,
          planId: plan.id,
          id: b.id,
          start: tsToWallString(seg.start),
          end: tsToWallString(seg.end),
          reason: b.reason,
        });
      }
    }
  }

  // 3a) 两份拟改新窗彼此不得重叠
  conflicts.pairOverlap = anyIntersect(pair[0].windows, pair[1].windows);

  // 3b) 新窗不得与同展品其他已批准/待复核计划重叠（排除被替换的两条原计划）
  const others = (await getOccupyingPlans(client, planA.exhibit_id, null))
    .filter((p) => Number(p.id) !== Number(planA.id) && Number(p.id) !== Number(planB.id));
  for (const { plan, adj, windows } of pair) {
    for (const other of others) {
      if (anyIntersect(windows, planWindows(other))) {
        conflicts.overlappingPlans.push({
          adjustmentId: adj.id,
          planId: plan.id,
          other: {
            id: other.id,
            title: other.title,
            status: other.status,
            startDate: dateYmd(other.start_date),
            endDate: dateYmd(other.end_date),
          },
        });
      }
    }
  }

  // 4) 估算残余替换核算（口径与单份 evaluateAdjustment 一致）
  const allConfirmed = await getActiveMeasurements(client, planA.exhibit_id);
  const allMeasWindows = allConfirmed.map((m) => ({
    start: new Date(m.start_ts).getTime(),
    end: new Date(m.end_ts).getTime(),
  }));

  const items = [];
  for (const { plan, adj, windows } of pair) {
    // 本计划全部停灯窗（登记时已保证落在原窗内且不与实测相交）
    const ownBlackoutHoles = (blackoutsByPlan.get(Number(plan.id)) || []).map((b) => ({
      start: new Date(b.start_ts).getTime(),
      end: new Date(b.end_ts).getTime(),
    }));
    const clipHoles = (targetWindows) => {
      const out = [];
      for (const hole of ownBlackoutHoles) {
        for (const part of clipIntervalToWindows(hole, targetWindows)) out.push(part);
      }
      return out;
    };

    // 原残余：原窗扣除本展品全部已确认实测覆盖与本计划停灯（与 computeOccupancy 口径一致）
    const oldWindows = planWindows(plan);
    const oldRemaining = subtractIntervals(
      oldWindows,
      [
        ...allMeasWindows.filter((mw) => oldWindows.some((w) => intersects(w, mw))),
        ...clipHoles(oldWindows),
      ]
    );
    const oldResidueYearly = yearMapToObject(doseByYear(oldRemaining, Number(plan.estimated_lux)));

    // 新残余：新窗扣除本计划已确认实测覆盖（draft 不计量、仍由估算占位）与落在新窗内的本计划停灯
    const confirmedOwn = (measByPlan.get(Number(plan.id)) || [])
      .filter((m) => m.status === 'confirmed')
      .map((m) => ({ start: new Date(m.start_ts).getTime(), end: new Date(m.end_ts).getTime() }))
      .filter((mw) => windows.some((w) => intersects(w, mw)));
    const newRemaining = subtractIntervals(windows, [...confirmedOwn, ...clipHoles(windows)]);
    const newResidueYearly = yearMapToObject(doseByYear(newRemaining, Number(adj.estimated_lux)));

    items.push({
      adjustmentId: adj.id,
      planId: plan.id,
      title: plan.title,
      oldResidueYearly,
      newResidueYearly,
    });
  }

  // 占用基数：当前占用中包含两份旧残余，同时扣除即得“其他占用”
  const occupancy = await computeOccupancy(client, planA.exhibit_id);
  const limits = occupancy.limits;
  const yearsSet = new Set([
    ...Object.keys(limits),
    ...Object.keys(occupancy.used),
    ...items.flatMap((it) => [
      ...Object.keys(it.oldResidueYearly),
      ...Object.keys(it.newResidueYearly),
    ]),
  ].map(Number));

  const yearlyReport = {};
  for (const year of [...yearsSet].sort((a, b) => a - b)) {
    const key = String(year);
    const limit = limits[key] !== undefined && limits[key] !== null ? round3(limits[key]) : null;
    const oldTotal = round3(items.reduce((s, it) => s + (it.oldResidueYearly[key] || 0), 0));
    const newTotal = round3(items.reduce((s, it) => s + (it.newResidueYearly[key] || 0), 0));
    const usedByOthers = round3((occupancy.used[key] || 0) - oldTotal);
    const projected = round3(usedByOthers + newTotal);
    // 各计划贡献（按年）：旧残余 -> 拟改残余
    const contributions = items.map((it) => ({
      adjustmentId: it.adjustmentId,
      planId: it.planId,
      title: it.title,
      oldResidue: round3(it.oldResidueYearly[key] || 0),
      newResidue: round3(it.newResidueYearly[key] || 0),
    }));
    const row = {
      year,
      limit,
      usedByOthers,
      oldResidueTotal: oldTotal,
      newResidueTotal: newTotal,
      contributions,
      projected,
      remainingAfter: limit === null ? null : round3(limit - projected),
      excess: null,
    };
    if (limit === null) {
      // 新残余占用了该年却没登记上限 -> 冲突
      if (newTotal > 0) conflicts.missingLimits.push(Number(year));
    } else if (projected - limit > 0.005) {
      row.excess = round3(projected - limit);
      conflicts.overflows.push(row);
    }
    yearlyReport[key] = row;
  }

  const ok =
    conflicts.notApproved.length === 0 &&
    conflicts.notStarted.length === 0 &&
    conflicts.outsideMeasurements.length === 0 &&
    conflicts.outsideBlackouts.length === 0 &&
    !conflicts.pairOverlap &&
    conflicts.overlappingPlans.length === 0 &&
    conflicts.overflows.length === 0 &&
    conflicts.missingLimits.length === 0;

  return { ok, conflicts, items, yearlyReport };
}

/**
 * 给计划行附加：
 *  - notStarted：首个开灯时刻是否尚未到来
 *  - pendingAdjustment：当前待审调整申请（含拟改值试算 preview，可选）
 * plans: 单行或数组；withPreview 时会做完整试算（调用方须在展品事务/只读连接均可）。
 */
async function decoratePlans(client, plansInput, { withPreview = false, nowMs = Date.now() } = {}) {
  const list = Array.isArray(plansInput) ? plansInput : [plansInput];
  if (list.length === 0) return plansInput;
  const pendingMap = await getPendingAdjustments(client, list.map((p) => p.id));
  for (const plan of list) {
    plan.not_started = plan.status === 'approved' && planNotStarted(plan, nowMs);
    plan.notStarted = plan.not_started;
    const adj = pendingMap.get(Number(plan.id));
    if (adj) {
      const base = serializeAdjustment(adj);
      if (withPreview && plan.status === 'approved' && planNotStarted(plan, nowMs)) {
        const evalResult = await evaluateAdjustment(client, plan, adj, nowMs);
        base.preview = {
          ok: evalResult.ok,
          conflicts: evalResult.conflicts,
          oldResidueYearly: evalResult.oldResidueYearly,
          newResidueYearly: evalResult.newResidueYearly,
          yearlyReport: evalResult.yearlyReport,
        };
      }
      plan.pending_adjustment = base;
      plan.pendingAdjustment = base;
    } else {
      plan.pending_adjustment = null;
      plan.pendingAdjustment = null;
    }
  }
  return plansInput;
}

/** 调整申请的对外字段（驼峰）。 */
function serializeAdjustment(a) {
  if (!a) return null;
  return {
    id: a.id,
    planId: a.plan_id,
    exhibitId: a.exhibit_id,
    startDate: dateYmd(a.start_date),
    endDate: dateYmd(a.end_date),
    periods: normalizePeriods(a.light_periods),
    estimatedLux: Number(a.estimated_lux),
    reason: a.reason,
    status: a.status,
    rejectReason: a.reject_reason,
    createdBy: a.created_by,
    creatorName: a.creator_name || null,
    reviewedBy: a.reviewed_by,
    reviewerName: a.reviewer_name || null,
    reviewedAt: a.reviewed_at,
    createdAt: a.created_at,
    planTitle: a.plan_title || null,
    exhibitName: a.exhibit_name || null,
    // 原值（列表/详情联表带出处）
    original: a.original || null,
  };
}

// ---------------------------------------------------------------------------
// 下调年度上限：预演核算
// ---------------------------------------------------------------------------

/**
 * 预演把某展品某自然年上限降到 proposedLimit 后的额度核算（不写库）。
 * 返回内容：
 *  - 该年已确认实测（逐条，含按年剂量）
 *  - 各已批准/待复核计划在该年的估算残余
 *  - 预计合计/剩余/超额量
 *  - 超额时仍在该年有估算残余且尚未开始的已批准计划（flagCandidates）
 *  - fingerprint：当前占用快照指纹（供预演凭证校验“额度或相关占用是否已变化”）
 *
 * 口径与 computeOccupancy 完全一致（已确认实测 + 计划估算残余）。
 * 该年尚未登记上限时返回 400（下调必须针对既有上限；登记新上限请用 limits 接口）。
 */
async function computeLimitPreview(client, exhibitId, year, proposedLimit, { nowMs = Date.now() } = {}) {
  const yearStr = String(year);
  const { rows: limitRows } = await client.query(
    'SELECT year, limit_lxh FROM annual_limits WHERE exhibit_id = $1 AND year = $2 FOR UPDATE',
    [exhibitId, year]
  );
  if (limitRows.length === 0) {
    throw new ValidationError(`${year} 年尚未登记年度上限，不能下调；请先登记该年度上限`);
  }
  const currentLimit = round3(Number(limitRows[0].limit_lxh));

  const occupancy = await computeOccupancy(client, exhibitId);
  const used = round3(occupancy.used[yearStr] || 0);
  const excess = used - proposedLimit > 0.005 ? round3(used - proposedLimit) : 0;

  // 该年已确认实测（仅列在该年剂量 > 0 的，避免无关年份噪音）
  const confirmedMeasurements = occupancy.sources
    .filter((s) => s.kind === 'measurement' && (s.yearly[yearStr] || 0) > 0)
    .map((s) => ({
      id: s.id,
      planId: s.planId,
      start: s.start,
      end: s.end,
      lux: s.lux,
      yearDose: round3(s.yearly[yearStr]),
      yearly: s.yearly,
    }));

  // 各已批准/待复核计划在该年的估算残余
  const planById = new Map(occupancy.plans.map((p) => [p.id, p]));
  const planResidues = occupancy.sources
    .filter((s) => s.kind === 'plan' && (s.yearly[yearStr] || 0) > 0)
    .map((s) => {
      const firstStart = Math.min(...planWindows(planById.get(s.id)).map((w) => w.start));
      return {
        id: s.id,
        title: s.title,
        status: s.status,
        startDate: s.startDate,
        endDate: s.endDate,
        periods: normalizePeriods(s.periods),
        lux: s.lux,
        yearResidue: round3(s.yearly[yearStr]),
        firstStart: tsToWallString(firstStart),
        notStarted: s.status === 'approved' && firstStart > nowMs,
      };
    });

  // 超额时：仍在该年有估算残余、且尚未开始的已批准计划（下调成功后将转待复核）
  const flagCandidates = excess > 0
    ? planResidues.filter((p) => p.status === 'approved' && p.notStarted)
    : [];
  // 已开始但仍占用该年残余的计划：不转状态，但剩余超额仍如实显示
  const startedResiduePlans = excess > 0
    ? planResidues.filter((p) => p.status === 'approved' && !p.notStarted)
    : [];

  // 该年各条停灯记录的估算扣减量（与占用口径一致；已取消计划的停灯 deductionActive=false）
  const blackoutDeductions = (occupancy.blackouts || [])
    .filter((b) => (b.yearly[yearStr] || 0) > 0)
    .map((b) => ({
      id: b.id,
      planId: b.planId,
      planTitle: b.planTitle,
      planStatus: b.planStatus,
      start: b.start,
      end: b.end,
      reason: b.reason,
      yearDeduction: round3(b.yearly[yearStr]),
      active: b.deductionActive,
    }));

  // ---- 凭证指纹快照：覆盖上限/未作废实测/占用计划/时刻 ----
  const { rows: allMeasRows } = await client.query(
    `SELECT id, plan_id, start_ts, end_ts, actual_lux, status
       FROM measurements
      WHERE exhibit_id = $1 AND status <> 'annulled'
      ORDER BY id`,
    [exhibitId]
  );
  const fingerprintMeasures = allMeasRows.map((m) => ({
    id: m.id,
    planId: m.plan_id,
    start: new Date(m.start_ts).getTime(),
    end: new Date(m.end_ts).getTime(),
    lux: Number(m.actual_lux),
    status: m.status,
  }));
  const fingerprintPlans = occupancy.plans.map((p) => ({
    id: p.id,
    status: p.status,
    startDate: dateYmd(p.start_date),
    endDate: dateYmd(p.end_date),
    periods: normalizePeriods(p.light_periods),
    lux: Number(p.estimated_lux),
    yearResidue: round3(
      (occupancy.sources.find((s) => s.kind === 'plan' && s.id === p.id) || { yearly: {} })
        .yearly[yearStr] || 0
    ),
  }));
  // 此刻已开始（首个开灯时刻已过）的已批准计划 id：时间相关状态仅体现在这里
  const startedPlanIds = occupancy.plans
    .filter((p) => p.status === 'approved')
    .filter((p) => Math.min(...planWindows(p).map((w) => w.start)) <= nowMs)
    .map((p) => p.id)
    .sort((a, b) => a - b);

  // 停灯记录也属于“相关占用”：新增/变化须使旧预演凭证失效
  const fingerprintBlackouts = (occupancy.blackouts || []).map((b) => ({
    id: b.id,
    planId: b.planId,
    start: b.start,
    end: b.end,
    yearly: b.yearly,
    active: b.deductionActive,
  }));

  return {
    exhibitId,
    year,
    currentLimit,
    proposedLimit: round3(proposedLimit),
    used,
    remaining: round3(proposedLimit - used),
    excess,
    over: excess > 0,
    confirmedMeasurements,
    planResidues,
    blackoutDeductions,
    flagCandidates,
    startedResiduePlans,
    signature: {
      currentLimit,
      measurements: fingerprintMeasures,
      plans: fingerprintPlans,
      blackouts: fingerprintBlackouts,
      startedPlanIds,
    },
  };
}

module.exports = {
  ACTIVE_PLAN_STATUSES,
  lockExhibit,
  getPlan,
  getOccupyingPlans,
  dateYmd,
  planWindows,
  planResidueYearly,
  findOverlappingMeasurement,
  findOverlappingBlackout,
  getBlackoutRows,
  loadBlackoutView,
  registerBlackout,
  computeOccupancy,
  buildOverflows,
  planOverlaps,
  validateMeasurementWindow,
  plansToFlag,
  computeLimitPreview,
  yearOfTs,
  // 调整申请
  normalizeScheduleInput,
  getPendingAdjustment,
  getPendingAdjustments,
  planFirstStart,
  planNotStarted,
  adjustmentWindows,
  evaluateAdjustment,
  evaluateAdjustmentPair,
  decoratePlans,
  serializeAdjustment,
};
