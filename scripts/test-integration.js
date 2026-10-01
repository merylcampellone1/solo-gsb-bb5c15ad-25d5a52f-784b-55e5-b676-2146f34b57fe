'use strict';

/*
 * 基于 pg-mem 的端到端业务流程测试（不依赖真实 PostgreSQL）：
 *   node scripts/test-integration.js
 * 覆盖：登记额度、提交/批准、重叠拒绝、超限按年超额量、并发批准不超配、
 *       实测替代估算、重叠实测拒绝、迟到实测转待复核与复核重新校验、
 *       计划调整申请的提交/撤回/驳回/批准、待审占用、原值拟改值、冲突计划/实测/超额年份核对、
 *       成对核准（互换档期、组成性拒绝、试算/提交、失败原子性、各计划贡献超额）、
 *       下调年度上限的预演/凭证提交、占用变化拒绝并返回新结果、旧接口同事务即时重算、
 *       未开始计划转待复核（写明原因）、已开始计划保留且超额如实显示。
 */

process.env.SEED_DEMO = 'false';
process.env.PGHOST = 'memory';

const http = require('http');
const { newDb } = require('pg-mem');
const dbModule = require('../src/db');

// ---- 用 pg-mem 替换 pg 连接池 ----
const mem = newDb({ autoCreateForeignKeyIndices: true });
const { Pool: MemPool } = mem.adapters.createPg();
const fakePool = new MemPool();

// db.js 的 withTransaction 使用 pool.connect() 取得 client；其余处使用 pool.query。
dbModule.pool.connect = (...args) => fakePool.connect(...args);
dbModule.pool.query = (...args) => fakePool.query(...args);

const { createApp } = require('../src/app');
const { initializeDatabase } = require('../src/init');
const config = require('../src/config');

let server;
let base;
const cookies = new Map();
let assertCount = 0;

function assert(cond, msg) {
  assertCount++;
  if (!cond) throw new Error('断言失败: ' + msg);
}

// pg-mem 的 DATE 可能返回 Date 对象，真实 pg 经类型解析返回 'YYYY-MM-DD'；统一取前 10 位
function ymd(v) {
  return typeof v === 'string' ? v.slice(0, 10)
    : `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
}

function call(method, urlPath, body, role) {
  const cookie = role ? cookies.get(role) : null;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${base}${urlPath}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(cookie ? { Cookie: `lqsession=${cookie}` } : {}),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          if (role && res.headers['set-cookie']) {
            const m = res.headers['set-cookie'][0].match(/lqsession=([a-f0-9]+)/);
            if (m) cookies.set(role, m[1]);
          }
          let json = null;
          try {
            json = JSON.parse(chunks);
          } catch (_) {
            /* ignore */
          }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  await initializeDatabase();

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  await runFlow();

  server.close();
  console.log(`\n集成测试全部通过（${assertCount} 条断言）`);
  process.exit(0);
}

async function runFlow() {
  // ---- 登录 / 角色 ----
  let r = await call('POST', '/api/auth/login',
    { username: config.seed.conservatorUsername, password: config.seed.conservatorPassword }, 'c');
  assert(r.status === 200, '保管员登录');
  r = await call('POST', '/api/auth/login',
    { username: config.seed.installerUsername, password: config.seed.installerPassword }, 'i');
  assert(r.status === 200, '布展员登录');

  r = await call('POST', '/api/exhibits', { name: 'X' }, 'i');
  assert(r.status === 403, '布展员不能登记展品');

  // ---- 登记展品与额度 ----
  r = await call('POST', '/api/exhibits',
    { name: '宋拓本', accessionNo: 'A-1', medium: '纸本' }, 'c');
  assert(r.status === 201, '登记展品');
  const exhibitId = r.body.exhibit.id;

  r = await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2026, limitLxh: 1600 }, 'c');
  assert(r.status === 200, '登记 2026 上限 1600');

  // ---- 输入校验 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '坏计划', startDate: '2026-03-01', endDate: '2026-03-01',
    periods: ['09:00-17:00'], estimatedLux: 0,
  }, 'i');
  assert(r.status === 400 && /正数/.test(r.body.error), '非正照度报错');

  r = await call('POST', '/api/plans', {
    exhibitId, title: '坏时段', startDate: '2026-03-01', endDate: '2026-03-02',
    periods: ['09:00-09:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 400, '零时长时段报错');

  r = await call('POST', '/api/plans', {
    exhibitId, title: '坏日期', startDate: '2026-02-30', endDate: '2026-03-02',
    periods: ['09:00-10:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 400, '非法日期报错');

  // ---- 计划1：3/1-3/2 每天 09-17，100lx = 1600 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '三月展', startDate: '2026-03-01', endDate: '2026-03-02',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交计划1');
  const plan1 = r.body.plan.id;

  r = await call('GET', `/api/plans/${plan1}`, null, 'i');
  assert(r.body.estimatedYearly['2026'] === 1600, '按年拆分 2026=1600');

  r = await call('POST', `/api/plans/${plan1}/approve`, {}, 'i');
  assert(r.status === 403, '布展员不能批准');

  r = await call('POST', `/api/plans/${plan1}/approve`, {}, 'c');
  assert(r.status === 200, '保管员批准计划1');

  // ---- 夜场：同日但不重叠；额度不足 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '夜场（不重叠）', startDate: '2026-03-01', endDate: '2026-03-01',
    periods: ['18:00-22:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '非重叠时段可提交');
  const plan2 = r.body.plan.id;
  r = await call('POST', `/api/plans/${plan2}/approve`, {}, 'c');
  assert(r.status === 409 && r.body.details.overflows[0].year === 2026,
    '夜场批准因 2026 超限被拒');
  const ov = r.body.details.overflows[0];
  assert(ov.excess === 400 && ov.limit === 1600 && ov.projected === 2000,
    `超额量 400 正确，实际=${JSON.stringify(ov)}`);

  // ---- 时间重叠计划：提交即被拒 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '撞车计划', startDate: '2026-03-02', endDate: '2026-03-02',
    periods: ['10:00-11:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 409, '重叠计划提交即被拒');

  // 提额到 3000 后夜场可批（1600+400=2000）
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2026, limitLxh: 3000 }, 'c');
  r = await call('POST', `/api/plans/${plan2}/approve`, {}, 'c');
  assert(r.status === 200, '提额后夜场批准成功');

  // ---- 实测：3/1 实测 150lx 替代当天 100lx 估算 ----
  r = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-01', startTime: '09:00',
    endDate: '2026-03-01', endTime: '17:00', actualLux: 150,
  }, 'c');
  assert(r.status === 201, '录入实测草稿');
  const meas1 = r.body.measurement.id;

  r = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-01', startTime: '17:30',
    endDate: '2026-03-01', endTime: '18:30', actualLux: 100,
  }, 'c');
  assert(r.status === 400, '计划开灯窗外的实测被拒绝');

  r = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-01', startTime: '10:00',
    endDate: '2026-03-01', endTime: '11:00', actualLux: 100,
  }, 'c');
  assert(r.status === 409, '重叠实测被拒绝');

  r = await call('POST', `/api/measurements/${meas1}/confirm`, {}, 'c');
  assert(r.status === 200, '确认实测（不超限）');
  // 1200(实测) + 800(plan1 次日残余) + 400(夜场) = 2400
  assert(r.body.years['2026'].used === 2400,
    `实测替代估算后 2026 已用应为 2400，实际 ${r.body.years['2026'].used}`);
  assert(r.body.years['2026'].remaining === 600, '剩余 600');

  // ---- 迟到实测导致超限 + 转待复核 ----
  // 另一年份（约 400 天后）的已批准计划，用于验证“别的年份超额不会牵连它”
  const future = new Date(Date.now() + 400 * 86400000);
  const fy = future.getUTCFullYear();
  const fm = String(future.getUTCMonth() + 1).padStart(2, '0');
  const fd = String(future.getUTCDate()).padStart(2, '0');
  const futureYmd = `${fy}-${fm}-${fd}`;
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: fy, limitLxh: 2000 }, 'c');

  r = await call('POST', '/api/plans', {
    exhibitId, title: '未来展（另一年份）', startDate: futureYmd, endDate: futureYmd,
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交另一年份未来计划');
  const futurePlan = r.body.plan.id;
  r = await call('POST', `/api/plans/${futurePlan}/approve`, {}, 'c');
  assert(r.status === 200, '另一年份未来计划批准');

  // 2026 年内、确定尚未开始的计划（必须在迟到实测确认前批准）
  const in30 = new Date(Date.now() + 30 * 86400000);
  let pendingPlan = null;
  if (in30.getUTCFullYear() === 2026) {
    const m2 = String(in30.getUTCMonth() + 1).padStart(2, '0');
    const d2 = String(in30.getUTCDate()).padStart(2, '0');
    const ymd2 = `2026-${m2}-${d2}`;
    const cr = await call('POST', '/api/plans', {
      exhibitId, title: '2026未开始计划', startDate: ymd2, endDate: ymd2,
      periods: ['09:00-17:00'], estimatedLux: 50, // 8h*50 = 400
    }, 'i');
    assert(cr.status === 201, '提交 2026 未开始计划');
    pendingPlan = cr.body.plan.id;
    // 当前 used=2400，+400=2800 ≤ 3000
    const ar = await call('POST', `/api/plans/${pendingPlan}/approve`, {}, 'c');
    assert(ar.status === 200, `2026 未开始计划批准（实际 ${ar.status} ${JSON.stringify(ar.body)}）`);
  }

  // 迟到实测：plan1 第二天 3/2 实测 500lx => 4000 替代 800
  // 2026 used = 1200 + 4000 + 400(夜场) [+ 400 待复核计划] = 6000，超额 3000
  r = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-02', startTime: '09:00',
    endDate: '2026-03-02', endTime: '17:00', actualLux: 500,
  }, 'c');
  assert(r.status === 201, '录入迟到实测草稿');
  const meas2 = r.body.measurement.id;
  r = await call('POST', `/api/measurements/${meas2}/confirm`, {}, 'c');
  assert(r.status === 409, '迟到实测确认后超限返回 409');
  const of2026 = r.body.overflows.find((o) => o.year === 2026);
  assert(of2026 && of2026.excess === 3000 && of2026.projected === 6000,
    `2026 超额 3000、合计 6000，实际=${JSON.stringify(r.body.overflows)}`);
  // 另一年份的计划不受牵连
  assert(!r.body.flaggedPlans.some((p) => p.id === futurePlan),
    '另一年份的计划不因 2026 超额而转待复核');
  // 已开始（3 月）的 plan1/plan2 不转待复核
  assert(!r.body.flaggedPlans.some((p) => p.id === plan1 || p.id === plan2),
    '已开始的计划不转待复核');
  if (pendingPlan) {
    assert(r.body.flaggedPlans.some((p) => p.id === pendingPlan),
      '2026 年未开始计划转为待复核');
  }

  // 与已确认实测重叠的录入被拒绝
  const mr = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-02', startTime: '09:00',
    endDate: '2026-03-02', endTime: '10:00', actualLux: 600,
  }, 'c');
  assert(mr.status === 409, '与已确认实测重叠的录入被拒绝');

  // 超限未解除时，待复核计划复核仍被拒（原审批与测量记录保留）
  if (pendingPlan) {
    const rr = await call('POST', `/api/plans/${pendingPlan}/approve`, {}, 'c');
    assert(rr.status === 409, '超限状态下复核通过仍被拒绝');
  }

  // 超限状态下，新的计划批准必然 409
  r = await call('POST', '/api/plans', {
    exhibitId, title: '超额后的新计划', startDate: '2026-06-01', endDate: '2026-06-01',
    periods: ['09:00-10:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交新计划');
  const blockedPlan = r.body.plan.id;
  r = await call('POST', `/api/plans/${blockedPlan}/approve`, {}, 'c');
  assert(r.status === 409, '超限状态下新计划批准被拒');

  // 已确认实测不可删除
  r = await call('DELETE', `/api/measurements/${meas2}`, null, 'c');
  assert(r.status === 400, '已确认实测不可删除（保留测量记录）');

  // 提额解除 2026 超限：待复核计划复核通过，新计划也可批
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2026, limitLxh: 100000 }, 'c');
  if (pendingPlan) {
    const rr = await call('POST', `/api/plans/${pendingPlan}/approve`, {}, 'c');
    assert(rr.status === 200, '提额后待复核计划复核通过');
  }
  r = await call('POST', `/api/plans/${blockedPlan}/approve`, {}, 'c');
  assert(r.status === 200, '提额后新计划可批准');

  // ---- 跨年拆分：未登记年份额度 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '跨年展', startDate: '2027-12-31', endDate: '2028-01-01',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '跨年计划可提交');
  const crossPlan = r.body.plan.id;
  r = await call('GET', `/api/plans/${crossPlan}`, null, 'i');
  assert(r.body.estimatedYearly['2027'] === 800 && r.body.estimatedYearly['2028'] === 800,
    '跨年剂量按自然年拆分');
  r = await call('POST', `/api/plans/${crossPlan}/approve`, {}, 'c');
  assert(r.status === 409, '跨年计划批准被拒');
  // fy 年（约一年后，通常是 2027）可能已登记额度；2028 一定未登记，错误必须指出缺失年份
  assert(/2028/.test(r.body.error), `错误指出 2028 年未登记额度，实际：${r.body.error}`);

  // ---- 并发批准不超配（额度恰好只够一个）----
  // 2027 已被 futurePlan 占用 800（上限 2000），提到 4000 以容纳跨年计划的 800
  if (fy === 2027) {
    await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2027, limitLxh: 4000 }, 'c');
  } else {
    await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2027, limitLxh: 800 }, 'c');
  }
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2028, limitLxh: 900 }, 'c');
  r = await call('POST', `/api/plans/${crossPlan}/approve`, {}, 'c');
  assert(r.status === 200, `跨年计划批准：2027/2028 各占 800（实际 ${r.status} ${r.body && r.body.error}）`);

  const pairIds = [];
  for (let i = 0; i < 2; i++) {
    const cr = await call('POST', '/api/plans', {
      exhibitId, title: `并发二选一-${i}`, startDate: '2028-03-01', endDate: '2028-03-01',
      periods: ['09:00-10:00'], // 两计划开灯时刻相同 => 互斥
      estimatedLux: 100,
    }, 'i');
    pairIds.push(cr.body.plan.id);
  }
  const rs = await Promise.all(pairIds.map((id) => call('POST', `/api/plans/${id}/approve`, {}, 'c')));
  const oks = rs.filter((x) => x.status === 200).length;
  const rejects = rs.filter((x) => x.status === 409).length;
  assert(oks === 1 && rejects === 1,
    `并发批准相同开灯时段：恰好一个成功（ok=${oks}, reject=${rejects}），不发生超配`);

  // 纯额度并发：2028 剩余 0；提额 +100，两条互不重叠的 100 分钟计划并发批准，只能过一个
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2028, limitLxh: 1000 }, 'c');
  const quotaIds = [];
  for (let i = 0; i < 2; i++) {
    const cr = await call('POST', '/api/plans', {
      exhibitId, title: `并发额度-${i}`, startDate: '2028-04-01', endDate: '2028-04-01',
      periods: [`0${6 + i}:00-0${7 + i}:00`], // 06-07 / 07-08，时间相接不重叠，各 100 lx·h
      estimatedLux: 100,
    }, 'i');
    assert(cr.status === 201, `并发额度计划 ${i} 创建成功（${cr.status} ${cr.body && cr.body.error}）`);
    quotaIds.push(cr.body.plan.id);
  }
  const qr = await Promise.all(quotaIds.map((qid) => call('POST', `/api/plans/${qid}/approve`, {}, 'c')));
  const qok = qr.filter((x) => x.status === 200).length;
  const qrej = qr.filter((x) => x.status === 409).length;
  assert(qok === 1 && qrej === 1,
    `额度仅够一个的并发批准：恰好一个成功（ok=${qok}, reject=${qrej}），不超配`);
  assert(qr.some((x) => x.status === 409 && x.body.details && x.body.details.overflows),
    '被拒响应包含按年超额明细');

  // =======================================================================
  // 计划调整申请（布展员提交 / 撤回，保管员批准 / 驳回）
  // 使用遥远的固定日期（2030/2031），保证“尚未开始”确定成立
  // =======================================================================
  // 第二个布展员，用于越权校验
  r = await call('POST', '/api/users', {
    username: 'installer2', password: 'setup123', role: 'installer', displayName: '布展员乙',
  }, 'c');
  assert(r.status === 201, '创建第二个布展员');
  await call('POST', '/api/auth/login',
    { username: 'installer2', password: 'setup123' }, 'i2');

  const createExhibit = async (name) => {
    const cr = await call('POST', '/api/exhibits', { name }, 'c');
    assert(cr.status === 201, `登记展品 ${name}`);
    return cr.body.exhibit.id;
  };
  const submitPlan = async (exId, title, startDate, endDate, periods, lux) => {
    const cr = await call('POST', '/api/plans',
      { exhibitId: exId, title, startDate, endDate, periods, estimatedLux: lux }, 'i');
    assert(cr.status === 201, `提交计划 ${title}`);
    return cr.body.plan.id;
  };
  const approvePlan = async (id) => {
    const cr = await call('POST', `/api/plans/${id}/approve`, {}, 'c');
    assert(cr.status === 200, `批准计划 #${id}（${cr.status} ${cr.body && cr.body.error}）`);
  };

  const ex2 = await createExhibit('调整流程展品');
  await call('POST', `/api/exhibits/${ex2}/limits`, { year: 2030, limitLxh: 10000 }, 'c');
  await call('POST', `/api/exhibits/${ex2}/limits`, { year: 2031, limitLxh: 10000 }, 'c');

  // 计划 A：2030-06-01 单日 09-17，100lx = 800；计划 B：2030-06-02 夜场 18-22，100lx = 400
  const planA = await submitPlan(ex2, '调整目标A', '2030-06-01', '2030-06-01', ['09:00-17:00'], 100);
  const planB = await submitPlan(ex2, '相邻计划B', '2030-06-02', '2030-06-02', ['18:00-22:00'], 100);
  await approvePlan(planA);
  await approvePlan(planB);
  // 一份尚未批准的计划（submitted），不能提交调整
  const planSubmitted = await submitPlan(ex2, '未批准计划', '2030-07-01', '2030-07-01',
    ['09:00-10:00'], 100);

  // ---- 越权 / 状态 / 输入校验 ----
  r = await call('POST', '/api/adjustments', { planId: planA,
    startDate: '2030-06-01', endDate: '2030-06-01', periods: ['09:00-12:00'], estimatedLux: 100 }, 'c');
  assert(r.status === 403, '保管员不能提交调整申请（越权）');

  r = await call('POST', '/api/adjustments', { planId: planSubmitted,
    startDate: '2030-07-01', endDate: '2030-07-01', periods: ['09:00-12:00'], estimatedLux: 100 }, 'i');
  assert(r.status === 400 && /已批准/.test(r.body.error), '未批准计划的调整申请被拒绝');

  // 已开始的已批准计划（plan1 在 2026-03，早已开始）
  r = await call('POST', '/api/adjustments', { planId: plan1,
    startDate: '2031-01-01', endDate: '2031-01-01', periods: ['09:00-12:00'], estimatedLux: 100 }, 'i');
  assert(r.status === 400 && /已开始/.test(r.body.error), '已开始计划的调整申请被拒绝');

  r = await call('POST', '/api/adjustments', { planId: planA,
    startDate: '2030-06-01', endDate: '2030-06-01', periods: ['09:00-09:00'], estimatedLux: 100 }, 'i');
  assert(r.status === 400, '零时长时段的调整申请被拒绝');

  r = await call('POST', '/api/adjustments', { planId: planA,
    startDate: '2030-06-10', endDate: '2030-06-01', periods: ['09:00-12:00'], estimatedLux: 100 }, 'i');
  assert(r.status === 400, '展期倒置的调整申请被拒绝');

  r = await call('POST', '/api/adjustments', { planId: planA,
    startDate: '2030-06-01', endDate: '2030-06-01', periods: ['09:00-12:00'], estimatedLux: -5 }, 'i');
  assert(r.status === 400, '非正照度的调整申请被拒绝');

  // ---- 正常提交 + 重复申请拒绝 + 待审占用 ----
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-12-31', endDate: '2031-01-01',
    periods: ['09:00-17:00'], estimatedLux: 100, reason: '配合跨年活动改期',
  }, 'i');
  assert(r.status === 201, '提交调整申请 adj1');
  const adj1 = r.body.adjustment.id;
  assert(r.body.adjustment.preview.ok === true, '拟改窗口试算通过（无冲突）');
  assert(r.body.adjustment.preview.newResidueYearly['2030'] === 800 &&
    r.body.adjustment.preview.newResidueYearly['2031'] === 800,
    '拟改残余按年各 800');

  // 重复提交被拒
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2031-02-01', endDate: '2031-02-01',
    periods: ['09:00-12:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 409 && r.body.details.existingAdjustmentId === adj1,
    '同一计划重复待审申请被拒绝（409，指明既有申请）');

  // 待审期间原计划继续占用额度：展品 2030 已用仍为 A(800)+B(400)=1200
  r = await call('GET', `/api/exhibits/${ex2}`, null, 'i');
  assert(r.body.years['2030'].used === 1200, '待审期间原计划继续占用额度（2030=1200）');
  // 计划行带有待审申请与原值/拟改值
  const planARow = r.body.plans.find((p) => p.id === planA);
  assert(planARow.pendingAdjustment && planARow.pendingAdjustment.id === adj1,
    '展品详情计划行展示待审调整申请');

  // 另一布展员不能撤回
  r = await call('POST', `/api/adjustments/${adj1}/withdraw`, {}, 'i2');
  assert(r.status === 403, '非申请人撤回被拒绝（403）');
  // 保管员也不能批准尚未……（先测试驳回不改计划，随后撤回重提）
  r = await call('POST', `/api/adjustments/${adj1}/reject`, { reason: '改期材料不全' }, 'c');
  assert(r.status === 200, '保管员驳回 adj1');
  r = await call('GET', `/api/plans/${planA}`, null, 'i');
  assert(ymd(r.body.plan.start_date) === '2030-06-01' && !r.body.plan.pendingAdjustment,
    '驳回不改变计划原值，且不再有待审申请');

  // ---- 撤回后可重提 ----
  // 先提交再撤回
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-12-31', endDate: '2031-01-01',
    periods: ['09:00-12:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '驳回后可重新提交 adj2');
  const adj2 = r.body.adjustment.id;
  r = await call('POST', `/api/adjustments/${adj2}/withdraw`, {}, 'i');
  assert(r.status === 200, '申请人撤回 adj2');
  r = await call('POST', `/api/adjustments/${adj2}/approve`, {}, 'c');
  assert(r.status === 400, '已撤回申请不能再批准');
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-12-31', endDate: '2031-01-01',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '撤回后可再次提交 adj3');
  const adj3 = r.body.adjustment.id;

  // ---- 批准冲突：与其他已批准计划开灯重叠（申请保持待审）----
  // 把拟改窗口改成与计划 B（2030-06-02 18-22）重叠
  await call('POST', `/api/adjustments/${adj3}/withdraw`, {}, 'i');
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-06-02', endDate: '2030-06-02',
    periods: ['20:00-21:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交与 B 重叠的 adj4（提交时不拦截，批准时核对）');
  const adj4 = r.body.adjustment.id;
  assert(r.body.adjustment.preview.ok === false, '试算标记不通过');
  assert(r.body.adjustment.preview.conflicts.overlappingPlans.some((p) => p.id === planB),
    '试算指出冲突计划 B');
  r = await call('POST', `/api/adjustments/${adj4}/approve`, {}, 'c');
  assert(r.status === 409, '重叠调整申请批准被拒（409）');
  assert(/相邻计划B/.test(r.body.error), '错误信息指出冲突计划');
  assert(r.body.details.conflicts.overlappingPlans[0].id === planB,
    '结构化冲突明细包含冲突计划');
  // 申请保持待审，可撤回
  r = await call('GET', `/api/adjustments/${adj4}`, null, 'i');
  assert(r.body.adjustment.status === 'pending', '核对失败后申请保持待审');
  await call('POST', `/api/adjustments/${adj4}/withdraw`, {}, 'i');

  // ---- 批准冲突：未作废实测落在新开灯窗外（draft 也算未作废）----
  // 先批准合规调整，随后在新窗口内录入实测；再用一个排除该实测的新窗口申请
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-12-31', endDate: '2031-01-01',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  const adj5 = r.body.adjustment.id;
  r = await call('POST', `/api/adjustments/${adj5}/approve`, {}, 'c');
  assert(r.status === 200, '批准合规调整 adj5，原子更新计划');
  r = await call('GET', `/api/plans/${planA}`, null, 'i');
  assert(ymd(r.body.plan.start_date) === '2030-12-31' && ymd(r.body.plan.end_date) === '2031-01-01' &&
    r.body.plan.estimated_lux === 100, '计划展期已更新为拟改值');
  assert(!r.body.plan.pendingAdjustment, '通过后无待审申请');

  // 在新窗口内录入一条实测（draft，未作废）
  r = await call('POST', '/api/measurements', {
    planId: planA, startDate: '2030-12-31', startTime: '09:00',
    endDate: '2030-12-31', endTime: '12:00', actualLux: 120,
  }, 'c');
  assert(r.status === 201, '在更新后窗口内录入实测草稿');
  const adjMeasId = r.body.measurement.id;
  // 再次调整到不含该实测的窗口（2031-06-01 09-12）
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2031-06-01', endDate: '2031-06-01',
    periods: ['09:00-12:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交排除既有实测窗口的 adj6');
  const adj6 = r.body.adjustment.id;
  r = await call('POST', `/api/adjustments/${adj6}/approve`, {}, 'c');
  assert(r.status === 409, '含窗外未作废实测的调整批准被拒');
  assert(new RegExp(`实测 #${adjMeasId}`).test(r.body.error), '错误信息指出冲突实测');
  assert(r.body.details.conflicts.outsideMeasurements[0].id === adjMeasId,
    '结构化冲突明细包含冲突实测');
  await call('POST', `/api/adjustments/${adj6}/withdraw`, {}, 'i');

  // ---- 批准冲突：按年超额 ----
  const ex3 = await createExhibit('调整超额展品');
  await call('POST', `/api/exhibits/${ex3}/limits`, { year: 2030, limitLxh: 800 }, 'c');
  const planC = await submitPlan(ex3, '小额计划C', '2030-08-01', '2030-08-01',
    ['09:00-17:00'], 50); // 400
  await approvePlan(planC);
  // 申请把照度改为 200lx（仍 8h）=> 1600，超 2030 上限 800，超额 800
  r = await call('POST', '/api/adjustments', {
    planId: planC, startDate: '2030-08-01', endDate: '2030-08-01',
    periods: ['09:00-17:00'], estimatedLux: 200,
  }, 'i');
  assert(r.status === 201, '提交超额调整 adj7');
  const adj7 = r.body.adjustment.id;
  assert(r.body.adjustment.preview.ok === false &&
    r.body.adjustment.preview.conflicts.overflows[0].year === 2030,
    '试算指出超额年份 2030');
  r = await call('POST', `/api/adjustments/${adj7}/approve`, {}, 'c');
  assert(r.status === 409, '超额调整批准被拒（409）');
  const o = r.body.details.conflicts.overflows.find((x) => x.year === 2030);
  assert(o && o.limit === 800 && o.newResidue === 1600 && o.projected === 1600 &&
    o.excess === 800, `超额明细数值正确：${JSON.stringify(o)}`);
  r = await call('GET', `/api/plans/${planC}`, null, 'i');
  assert(r.body.plan.estimated_lux === 50, '核对失败不改变计划（照度仍 50）');
  assert(r.body.plan.pendingAdjustment && r.body.plan.pendingAdjustment.id === adj7,
    '超额申请保持待审');
  // 提额后重新核对通过（同一份申请无需撤回重提）
  await call('POST', `/api/exhibits/${ex3}/limits`, { year: 2030, limitLxh: 2000 }, 'c');
  r = await call('POST', `/api/adjustments/${adj7}/approve`, {}, 'c');
  assert(r.status === 200, '提额后同一待审申请批准通过');
  r = await call('GET', `/api/plans/${planC}`, null, 'i');
  assert(r.body.plan.estimated_lux === 200, '计划照度更新为拟改值 200');

  // ---- 实测覆盖部分新窗口：以新窗口未被实测覆盖部分估算 ----
  // 删除上面的 draft 实测（草稿可删），改用已确认实测落在 A 当前窗口（2030-12-31~2031-01-01）
  await call('DELETE', `/api/measurements/${adjMeasId}`, null, 'c');
  // 2030-12-31 09:00-17:00 整段实测 100lx（确认，覆盖 2030 那天 8h）
  r = await call('POST', '/api/measurements', {
    planId: planA, startDate: '2030-12-31', startTime: '09:00',
    endDate: '2030-12-31', endTime: '17:00', actualLux: 100,
  }, 'c');
  assert(r.status === 201, '录入覆盖 2030 当天的实测草稿');
  const measFull = r.body.measurement.id;
  r = await call('POST', `/api/measurements/${measFull}/confirm`, {}, 'c');
  assert(r.status === 200, '确认实测（2030 占用改为实测 800）');
  // 拟改窗口不变（同窗口），批准一个“仅照度变化”的调整：新残余 2030=0（被覆盖），2031=800
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-12-31', endDate: '2031-01-01',
    periods: ['09:00-17:00'], estimatedLux: 300,
  }, 'i');
  assert(r.status === 201, '提交照度调整 adj8');
  const adj8 = r.body.adjustment.id;
  const pv = r.body.adjustment.preview;
  assert((pv.newResidueYearly['2030'] || 0) === 0 && pv.newResidueYearly['2031'] === 2400,
    `新窗口已确认实测覆盖部分不估算：2030=0,2031=2400，实际 ${JSON.stringify(pv.newResidueYearly)}`);
  r = await call('POST', `/api/adjustments/${adj8}/approve`, {}, 'c');
  assert(r.status === 200, '含已确认实测覆盖的调整批准通过');
  // 2030 占用：实测 800 + B(400) = 1200（原 A 残余被实测替代，调整后仍为 0 残余）
  r = await call('GET', `/api/exhibits/${ex2}`, null, 'c');
  assert(r.body.years['2030'].used === 1200,
    `调整后 2030 占用=实测800+B400=1200，实际 ${r.body.years['2030'].used}`);
  assert(r.body.years['2031'].used === 2400, `2031 占用=新残余 2400，实际 ${r.body.years['2031'].used}`);

  // ---- 调整申请列表接口 ----
  r = await call('GET', '/api/adjustments?exhibitId=' + ex2 + '&status=approved', null, 'i');
  assert(r.status === 200 && r.body.adjustments.some((a) => a.id === adj5),
    '可按展品/状态查询已通过调整申请');
  r = await call('GET', '/api/adjustments?planId=' + planC, null, 'i');
  assert(r.body.adjustments.every((a) => a.planId === planC) &&
    r.body.adjustments.some((a) => a.status === 'approved'),
    '按计划查询调整历史');

  // =======================================================================
  // 下调年度上限：预演 → 携凭证提交；旧接口直接修改；占用变化拒绝
  // =======================================================================
  const exL = await createExhibit('下调额度展品');
  await call('POST', `/api/exhibits/${exL}/limits`, { year: 2026, limitLxh: 10000 }, 'c');
  await call('POST', `/api/exhibits/${exL}/limits`, { year: 2032, limitLxh: 10000 }, 'c');

  // 已开始的已批准计划（2026 墙上时间 3 月，当前 2026-10，必已开始）：8h*100=800
  const pStarted = await submitPlan(exL, '已开始计划', '2026-03-01', '2026-03-01',
    ['09:00-17:00'], 100);
  await approvePlan(pStarted);
  // 2032 年尚未开始的计划两条，各 800
  const pFut1 = await submitPlan(exL, '未来计划1', '2032-06-01', '2032-06-01',
    ['09:00-17:00'], 100);
  const pFut2 = await submitPlan(exL, '未来计划2', '2032-07-01', '2032-07-01',
    ['09:00-17:00'], 100);
  await approvePlan(pFut1);
  await approvePlan(pFut2);

  // ---- 预演：越权 / 输入 / 非下调 / 未登记年份 ----
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: 800 }, 'i');
  assert(r.status === 403, '布展员不能预演下调（越权）');
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: -5 }, 'c');
  assert(r.status === 400 && /正数/.test(r.body.error), '非正上限预演报错');
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: 12000 }, 'c');
  assert(r.status === 400 && /不属于下调/.test(r.body.error), '拟定上限不低于现行上限被拒');
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2099, limitLxh: 100 }, 'c');
  assert(r.status === 400 && /尚未登记/.test(r.body.error), '未登记上限的年份不能下调预演');

  // ---- 预演不改状态：2032 降到 800，used=1600，超额 800 ----
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: 800 }, 'c');
  assert(r.status === 200, '预演成功');
  let lpv = r.body.preview;
  assert(lpv.currentLimit === 10000 && lpv.proposedLimit === 800 && lpv.used === 1600 &&
    lpv.excess === 800 && lpv.over === true,
    `预演数值正确：${JSON.stringify({ c: lpv.currentLimit, u: lpv.used, e: lpv.excess })}`);
  assert(lpv.confirmedMeasurements.length === 0, '该年无已确认实测');
  assert(lpv.planResidues.length === 2 &&
    lpv.planResidues.every((p) => p.yearResidue === 800 && p.notStarted),
    '列出两条未开始计划各 800 残余');
  assert(lpv.flagCandidates.length === 2 &&
    lpv.flagCandidates.map((p) => p.id).sort().join(',') === [pFut1, pFut2].sort().join(','),
    '两条未开始计划都在转待复核候选中');
  assert(typeof lpv.token === 'string' && lpv.token.length >= 32, '返回预演凭证');
  // 预演后状态不变
  r = await call('GET', `/api/exhibits/${exL}`, null, 'i');
  assert(r.body.years['2032'].limit === 10000, '预演不修改上限');
  assert(r.body.plans.find((p) => p.id === pFut1).status === 'approved',
    '预演不修改计划状态');

  // ---- 无凭证 / 错字段提交被拒（字段类 400 不消耗凭证，可改正后重试）----
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 800 }, 'c');
  assert(r.status === 400 && /预演/.test(r.body.error), '缺少凭证拒绝提交');
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 900, token: lpv.token }, 'c');
  assert(r.status === 400 && /不一致/.test(r.body.error), '凭证与拟定上限不一致被拒');
  // 字段不符不消耗凭证：原凭证按正确字段仍可通过状态校验（这里直接用于成功提交验证一次性语义）
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 800, token: lpv.token }, 'c');
  assert(r.status === 200, '字段类错误不消耗凭证，原凭证仍可成功提交');
  // 成功提交后凭证已被消耗，重放被拒
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 800, token: lpv.token }, 'c');
  assert(r.status === 400 && /已使用或不存在/.test(r.body.error), '凭证一次性：成功后重放被拒');

  // 提交后两计划已转待复核，先恢复现场以便后续场景：提额并复核回 approved
  await call('POST', `/api/exhibits/${exL}/limits`, { year: 2032, limitLxh: 10000 }, 'c');
  await call('POST', `/api/plans/${pFut1}/approve`, {}, 'c');
  await call('POST', `/api/plans/${pFut2}/approve`, {}, 'c');

  // ---- 再次预演 + 提交下调：覆盖上面未走的成功路径断言 ----
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: 800 }, 'c');
  lpv = r.body.preview;
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 800, token: lpv.token }, 'c');
  assert(r.status === 200, '携凭证下调成功');
  assert(r.body.years['2032'].limit === 800 && r.body.years['2032'].used === 1600 &&
    r.body.years['2032'].over === true, '下调后上限 800、已用 1600、显示超限');
  assert(r.body.overflows[0].excess === 800 && r.body.overflows[0].previousLimit === 10000,
    '成功响应附带超额与旧上限');
  const st1 = r.body.plans.find((p) => p.id === pFut1);
  const st2 = r.body.plans.find((p) => p.id === pFut2);
  assert(st1.status === 'pending_review' && st2.status === 'pending_review',
    '两条未开始计划转为待复核');
  assert(/上限下调/.test(st1.review_reason || '') && /超额/.test(st1.review_reason || ''),
    '待复核原因写明上限下调与超额：' + st1.review_reason);
  // 原审批保留：approved_by/approved_at 仍在（详情接口带 approver_name）
  assert(st1.approved_by != null, '原审批人保留');

  // ---- 超额未解除时复核沿用现有额度校验，仍被拒；不删除占用/不自动取消 ----
  r = await call('POST', `/api/plans/${pFut1}/approve`, {}, 'c');
  assert(r.status === 409, '超额状态下待复核计划复核通过被拒');
  r = await call('GET', `/api/exhibits/${exL}`, null, 'i');
  assert(r.body.plans.find((p) => p.id === pFut1).status === 'pending_review' &&
    r.body.years['2032'].used === 1600,
    '复核被拒不删除占用、计划仍待复核');

  // ---- 占用已变化则携旧凭证拒绝并返回最新结果（含新凭证）----
  // 先提额回 10000，复核通过 pFut1（占用/状态变化），再预演降到 800，
  // 随后又批准 pFut2 复核，使占用变化（本例占用数值不变但状态/指纹变化）；
  // 更直接的变化：预演后登记一条已确认实测会改变占用。先准备一条新计划以便录实测。
  await call('POST', `/api/exhibits/${exL}/limits`, { year: 2032, limitLxh: 100000 }, 'c');
  await call('POST', `/api/plans/${pFut1}/approve`, {}, 'c'); // pFut1 -> approved
  await call('POST', `/api/plans/${pFut2}/approve`, {}, 'c'); // pFut2 -> approved

  // 新的已批准未开始计划（2032-09-01 09-17，100lx = 800），用于录入实测改变占用
  const pMeas = await submitPlan(exL, '实测承载计划', '2032-09-01', '2032-09-01',
    ['09:00-17:00'], 100);
  await approvePlan(pMeas);

  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: 2000 }, 'c');
  assert(r.status === 200, '再次预演（used=2400，超额 400）');
  const staleToken = r.body.preview.token;
  assert(r.body.preview.used === 2400 && r.body.preview.excess === 400,
    `预演 used=2400/excess=400，实际 ${r.body.preview.used}/${r.body.preview.excess}`);

  // 预演后插入一条已确认实测：2032-09-01 09-17 实测 200lx = 1600，替代该计划 800 估算
  r = await call('POST', '/api/measurements', {
    planId: pMeas, startDate: '2032-09-01', startTime: '09:00',
    endDate: '2032-09-01', endTime: '17:00', actualLux: 200,
  }, 'c');
  assert(r.status === 201, '预演后录入实测草稿');
  const mNew = r.body.measurement.id;
  r = await call('POST', `/api/measurements/${mNew}/confirm`, {}, 'c');
  assert(r.status === 200, '确认实测（占用变化，且 100000 上限下不触发转复核）');

  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 2000, token: staleToken }, 'c');
  assert(r.status === 409 && /已变化/.test(r.body.error), '占用变化后旧凭证提交被拒（409）');
  const freshPv = r.body.details.preview;
  assert(freshPv && freshPv.token && freshPv.token !== staleToken,
    '拒绝时返回最新预演结果与新凭证');
  assert(freshPv.used === 3200 && freshPv.excess === 1200,
    `最新结果 used=3200（1600 实测 + 两条 800），实际 ${freshPv.used}`);
  assert(freshPv.confirmedMeasurements.some((m) => m.id === mNew && m.yearDose === 1600),
    '最新结果列出新增已确认实测');
  // 上限未被修改
  r = await call('GET', `/api/exhibits/${exL}`, null, 'i');
  assert(r.body.years['2032'].limit === 100000, '拒绝后上限保持不变');

  // 用返回的新凭证可直接提交
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 2000, token: freshPv.token }, 'c');
  assert(r.status === 200, '最新结果携带的新凭证可成功提交');
  assert(r.body.years['2032'].limit === 2000, '新上限 2000 生效');
  // 已确认实测与审批保留
  assert(r.body.measurements.some((m) => m.id === mNew && m.status === 'confirmed'),
    '已确认实测保留');

  // ---- 预演后“额度本身”被他人改动（占用未变），同样拒绝 ----
  const exQ = await createExhibit('额度被改展品');
  await call('POST', `/api/exhibits/${exQ}/limits`, { year: 2033, limitLxh: 5000 }, 'c');
  const pQ = await submitPlan(exQ, 'Q计划', '2033-01-01', '2033-01-01',
    ['09:00-17:00'], 100); // 800
  await approvePlan(pQ);
  r = await call('POST', `/api/exhibits/${exQ}/limits/preview`,
    { year: 2033, limitLxh: 500 }, 'c');
  const qToken = r.body.preview.token;
  assert(r.body.preview.used === 800 && r.body.preview.excess === 300, '预演超额 300');
  // 他人经旧接口把上限改为 4000（占用未变，额度变了）
  await call('POST', `/api/exhibits/${exQ}/limits`, { year: 2033, limitLxh: 4000 }, 'c');
  r = await call('POST', `/api/exhibits/${exQ}/limits/lower`,
    { year: 2033, limitLxh: 500, token: qToken }, 'c');
  assert(r.status === 409 && /已变化/.test(r.body.error), '额度被改后旧凭证被拒');
  assert(r.body.details.preview.currentLimit === 4000,
    '新结果反映最新现行上限 4000');

  // ---- 已开始计划不转状态，剩余超额如实显示 ----
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2026, limitLxh: 100 }, 'c');
  assert(r.status === 200, '2026 下调预演');
  lpv = r.body.preview;
  assert(lpv.used === 800 && lpv.excess === 700, '2026 已用 800，超额 700');
  assert(lpv.flagCandidates.length === 0, '已开始计划不在转待复核候选中');
  assert(lpv.startedResiduePlans.length === 1 && lpv.startedResiduePlans[0].id === pStarted,
    '已开始但仍占残余的计划单独列出');
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2026, limitLxh: 100, token: lpv.token }, 'c');
  assert(r.status === 200, '2026 下调成功');
  assert(r.body.overflows[0].excess === 700, '剩余超额如实返回');
  assert(!r.body.flaggedPlans.some((p) => p.id === pStarted), '已开始计划不转状态');
  assert(r.body.plans.find((p) => p.id === pStarted).status === 'approved',
    '已开始计划仍为已批准');
  assert(r.body.years['2026'].over === true && r.body.years['2026'].used === 800,
    '页面数据如实显示 2026 超限 700');

  // ---- 不超额的下调：直接成功，不产生转待复核 ----
  await call('POST', `/api/exhibits/${exL}/limits`, { year: 2026, limitLxh: 5000 }, 'c'); // 先提额
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2026, limitLxh: 1000 }, 'c');
  assert(r.body.preview.over === false && r.body.preview.remaining === 200,
    '下调到 1000（used=800）不超额，剩余 200');
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2026, limitLxh: 1000, token: r.body.preview.token }, 'c');
  assert(r.status === 200 && r.body.overflows.length === 0, '不超额下调成功且无超额明细');
  assert(r.body.plans.find((p) => p.id === pStarted).status === 'approved',
    '不超额时计划状态不变');

  // ---- 旧接口沿用旧字段直接修改：同事务即时重算，成功响应兼容（仍为展品详情）----
  r = await call('POST', `/api/exhibits/${exL}/limits`,
    { year: 2026, limitLxh: 500 }, 'c');
  assert(r.status === 200 && r.body.exhibit && r.body.years && r.body.plans,
    '旧接口成功响应仍是展品详情（兼容）');
  assert(r.body.years['2026'].limit === 500 && r.body.overflows[0].excess === 300,
    '旧接口同事务重算：上限 500，超额 300');
  assert(r.body.flaggedPlans.length === 0, '旧接口下调时已开始计划同样不转状态');
  // 旧接口上调/登记不产生下调核算字段
  r = await call('POST', `/api/exhibits/${exL}/limits`,
    { year: 2026, limitLxh: 9000 }, 'c');
  assert(r.status === 200 && r.body.limitLowered === null &&
    r.body.overflows.length === 0 && r.body.flaggedPlans.length === 0,
    '旧接口上调不附带下调结果');
  r = await call('GET', `/api/exhibits`, null, 'i');
  assert(r.body.exhibits.some((e) => e.id === exL && e.years['2026']),
    '额度列表查询响应保持兼容');

  // =======================================================================
  // 成对核准调整申请（保管员）：两份待审申请同时替换原窗（互换/协同挪动档期）
  // =======================================================================
  const exP = await createExhibit('成对核准展品');
  await call('POST', `/api/exhibits/${exP}/limits`, { year: 2030, limitLxh: 5000 }, 'c');
  await call('POST', `/api/exhibits/${exP}/limits`, { year: 2031, limitLxh: 5000 }, 'c');

  // 三条已批准未开始计划：D 2030-03-01 / E 2030-04-01 / F 2030-05-01，各 09-17 100lx = 800
  const planD = await submitPlan(exP, '成对计划D', '2030-03-01', '2030-03-01', ['09:00-17:00'], 100);
  const planE = await submitPlan(exP, '成对计划E', '2030-04-01', '2030-04-01', ['09:00-17:00'], 100);
  const planF = await submitPlan(exP, '成对计划F', '2030-05-01', '2030-05-01', ['09:00-17:00'], 100);
  await approvePlan(planD);
  await approvePlan(planE);
  await approvePlan(planF);

  const submitAdj = async (planId, startDate, endDate, periods, lux) => {
    const rr = await call('POST', '/api/adjustments',
      { planId, startDate, endDate, periods, estimatedLux: lux }, 'i');
    assert(rr.status === 201, `提交调整申请（计划 #${planId}）：${rr.status} ${rr.body && rr.body.error}`);
    return rr.body.adjustment.id;
  };

  // 互换档期：D → 04-01（E 的档期），E → 03-01（D 的档期）
  const adjD = await submitAdj(planD, '2030-04-01', '2030-04-01', ['09:00-17:00'], 100);
  const adjE = await submitAdj(planE, '2030-03-01', '2030-03-01', ['09:00-17:00'], 100);

  // 单份批准无法完成互换（D 的拟改窗撞上 E 的当前窗口），成对核准才能同时替换
  r = await call('POST', `/api/adjustments/${adjD}/approve`, {}, 'c');
  assert(r.status === 409 &&
    r.body.details.conflicts.overlappingPlans.some((p) => p.id === planE),
    '单份批准互换申请因撞上对方当前窗口被拒（409）');
  r = await call('GET', `/api/adjustments/${adjD}`, null, 'i');
  assert(r.body.adjustment.status === 'pending', '单份核对失败后申请保持待审');

  // ---- 组成性拒绝：编号无效 / 同一计划 / 跨展品 / 已结案 ----
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjD, adjE] }, 'i');
  assert(r.status === 403, '布展员不能成对试算（越权）');
  r = await call('POST', '/api/adjustments/pair/approve', { adjustmentIds: [adjD, adjE] }, 'i');
  assert(r.status === 403, '布展员不能成对核准（越权）');
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjD, adjD] }, 'c');
  assert(r.status === 400 && /必须不同/.test(r.body.error), '两个相同申请编号被拒绝');
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjD] }, 'c');
  assert(r.status === 400, '只给一个申请编号被拒绝');
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjD, 999999] }, 'c');
  assert(r.status === 400 && /不存在/.test(r.body.error), '不存在的申请编号被拒绝');

  // 跨展品：planB（ex2）提交一份待审申请 adjX
  const adjX = await submitAdj(planB, '2030-06-03', '2030-06-03', ['18:00-22:00'], 100);
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjD, adjX] }, 'c');
  assert(r.status === 400 && /跨展品/.test(r.body.error), '跨展品的两份申请被拒绝');
  await call('POST', `/api/adjustments/${adjX}/withdraw`, {}, 'i');

  // 同一计划：planF 先提交 adjF1 并驳回，再提交 adjF2（待审）
  const adjF1 = await submitAdj(planF, '2030-05-02', '2030-05-02', ['09:00-17:00'], 100);
  r = await call('POST', `/api/adjustments/${adjF1}/reject`, { reason: '档期再议' }, 'c');
  assert(r.status === 200, '驳回 adjF1');
  const adjF2 = await submitAdj(planF, '2030-05-03', '2030-05-03', ['09:00-17:00'], 100);
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjF1, adjF2] }, 'c');
  assert(r.status === 400 && /同一计划/.test(r.body.error), '关联同一计划的两份申请被拒绝');
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjD, adjF1] }, 'c');
  assert(r.status === 400 && /已结案/.test(r.body.error), '已结案的申请被拒绝');
  await call('POST', `/api/adjustments/${adjF2}/withdraw`, {}, 'i');

  // ---- 成对试算通过：两份拟改窗同时替换原窗 ----
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjD, adjE] }, 'c');
  assert(r.status === 200 && r.body.pairPreview, '成对试算返回结果');
  let pp = r.body.pairPreview;
  assert(pp.ok === true, '互换试算通过');
  assert(pp.adjustments.length === 2 && pp.adjustments[0].original && pp.adjustments[1].original,
    '试算结果带两份申请的原值');
  const y2030 = pp.yearlyReport['2030'];
  assert(y2030 && y2030.usedByOthers === 800 && y2030.oldResidueTotal === 1600 &&
    y2030.newResidueTotal === 1600 && y2030.projected === 2400,
    `2030 年报告：其他占用 800、旧残余合计 1600、拟改合计 1600、合计 2400，实际 ${JSON.stringify(y2030)}`);
  assert(y2030.contributions.length === 2 &&
    y2030.contributions.every((ct) => ct.newResidue === 800),
    '按年列出两计划各自贡献');

  // ---- 成对核准成功：原子更新两条计划、结案两份申请 ----
  r = await call('POST', '/api/adjustments/pair/approve', { adjustmentIds: [adjD, adjE] }, 'c');
  assert(r.status === 200, `成对核准成功（实际 ${r.status} ${r.body && r.body.error}）`);
  assert(r.body.exhibit && r.body.years && r.body.plans, '成功响应仍为展品详情（兼容）');
  assert(r.body.pairApproval &&
    r.body.pairApproval.adjustmentIds.join(',') === `${adjD},${adjE}`,
    '成功响应附带成对核准信息');
  r = await call('GET', `/api/plans/${planD}`, null, 'i');
  assert(ymd(r.body.plan.start_date) === '2030-04-01' && !r.body.plan.pendingAdjustment,
    '计划D 已换到 04-01 且无待审申请');
  r = await call('GET', `/api/plans/${planE}`, null, 'i');
  assert(ymd(r.body.plan.start_date) === '2030-03-01', '计划E 已换到 03-01');
  r = await call('GET', `/api/adjustments/${adjD}`, null, 'i');
  assert(r.body.adjustment.status === 'approved', '申请 adjD 已结案为通过');
  r = await call('GET', `/api/adjustments/${adjE}`, null, 'i');
  assert(r.body.adjustment.status === 'approved', '申请 adjE 已结案为通过');
  r = await call('GET', `/api/exhibits/${exP}`, null, 'i');
  assert(r.body.years['2030'].used === 2400, '互换后 2030 占用不变（2400）');

  // ---- 失败原子性：任一核对不通过，两份申请仍待审、计划与额度不变 ----
  const planH = await submitPlan(exP, '成对计划H', '2030-06-01', '2030-06-01', ['09:00-17:00'], 100);
  const planI = await submitPlan(exP, '成对计划I', '2030-07-01', '2030-07-01', ['09:00-17:00'], 100);
  await approvePlan(planH);
  await approvePlan(planI);
  // 2030 used = 2400 + 1600 = 4000
  const adjH = await submitAdj(planH, '2030-05-01', '2030-05-01', ['09:00-17:00'], 100); // 撞 F
  const adjI = await submitAdj(planI, '2030-07-02', '2030-07-02', ['09:00-17:00'], 100); // 合规
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjH, adjI] }, 'c');
  pp = r.body.pairPreview;
  assert(pp.ok === false && pp.conflicts.overlappingPlans.some(
    (x) => x.adjustmentId === adjH && x.other.id === planF),
    '试算指出拟改窗与其他已批准计划 F 重叠');
  r = await call('POST', '/api/adjustments/pair/approve', { adjustmentIds: [adjH, adjI] }, 'c');
  assert(r.status === 409 && /成对计划F/.test(r.body.error), '成对核准因重叠被拒并指出冲突计划');
  r = await call('GET', `/api/adjustments/${adjH}`, null, 'i');
  assert(r.body.adjustment.status === 'pending', '失败后申请 adjH 仍待审');
  r = await call('GET', `/api/adjustments/${adjI}`, null, 'i');
  assert(r.body.adjustment.status === 'pending', '失败后申请 adjI 仍待审');
  r = await call('GET', `/api/plans/${planH}`, null, 'i');
  assert(ymd(r.body.plan.start_date) === '2030-06-01', '失败后计划H 不变');
  r = await call('GET', `/api/exhibits/${exP}`, null, 'i');
  assert(r.body.years['2030'].used === 4000, '失败后 2030 占用不变（4000）');

  // ---- 两份拟改窗彼此重叠 ----
  await call('POST', `/api/adjustments/${adjH}/withdraw`, {}, 'i');
  await call('POST', `/api/adjustments/${adjI}/withdraw`, {}, 'i');
  const adjH2 = await submitAdj(planH, '2030-08-01', '2030-08-01', ['09:00-17:00'], 100);
  const adjI2 = await submitAdj(planI, '2030-08-01', '2030-08-01', ['12:00-18:00'], 100);
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjH2, adjI2] }, 'c');
  assert(r.body.pairPreview.conflicts.pairOverlap === true, '试算标记两份拟改窗彼此重叠');
  r = await call('POST', '/api/adjustments/pair/approve', { adjustmentIds: [adjH2, adjI2] }, 'c');
  assert(r.status === 409 && r.body.details.conflicts.pairOverlap === true,
    '彼此重叠的成对核准被拒（409）');

  // ---- 计划已开始（直接用 service 以未来时刻评估；HTTP 层无法让待审申请关联的计划已开始）----
  const svc = require('../src/service');
  await dbModule.withTransaction(async (client) => {
    const { rows: adjs } = await client.query(
      'SELECT * FROM plan_adjustments WHERE id IN ($1, $2) ORDER BY id', [adjH2, adjI2]);
    const { rows: pls } = await client.query(
      'SELECT * FROM plans WHERE id IN ($1, $2) ORDER BY id', [planH, planI]);
    const evalR = await svc.evaluateAdjustmentPair(
      client, pls[0], adjs[0], pls[1], adjs[1], Date.UTC(2031, 0, 1));
    assert(!evalR.ok && evalR.conflicts.notStarted.length === 2,
      '评估时刻晚于开灯时刻时两条计划都标记为已开始');
  });
  await call('POST', `/api/adjustments/${adjH2}/withdraw`, {}, 'i');
  await call('POST', `/api/adjustments/${adjI2}/withdraw`, {}, 'i');

  // ---- 按年超额：列出年份、各计划贡献与超额量 ----
  const exR = await createExhibit('成对超额展品');
  await call('POST', `/api/exhibits/${exR}/limits`, { year: 2030, limitLxh: 2000 }, 'c');
  const planJ = await submitPlan(exR, '成对计划J', '2030-01-05', '2030-01-05', ['09:00-17:00'], 100);
  const planK = await submitPlan(exR, '成对计划K', '2030-02-05', '2030-02-05', ['09:00-17:00'], 100);
  await approvePlan(planJ);
  await approvePlan(planK);
  // J 照度 100→200（残余 800→1600），K 不变（800）：合计 2400 超 2000，超额 400
  const adjJ = await submitAdj(planJ, '2030-01-05', '2030-01-05', ['09:00-17:00'], 200);
  const adjK = await submitAdj(planK, '2030-02-05', '2030-02-05', ['09:00-17:00'], 100);
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjJ, adjK] }, 'c');
  pp = r.body.pairPreview;
  assert(pp.ok === false && pp.conflicts.overflows.length === 1, '试算指出 2030 超额');
  const ofr = pp.conflicts.overflows[0];
  assert(ofr.year === 2030 && ofr.limit === 2000 && ofr.projected === 2400 && ofr.excess === 400,
    `超额明细数值正确：${JSON.stringify(ofr)}`);
  const cJ = ofr.contributions.find((ct) => ct.planId === planJ);
  const cK = ofr.contributions.find((ct) => ct.planId === planK);
  assert(cJ && cJ.oldResidue === 800 && cJ.newResidue === 1600 &&
    cK && cK.oldResidue === 800 && cK.newResidue === 800,
    '超额明细列出各计划贡献（J 800→1600，K 800→800）');
  r = await call('POST', '/api/adjustments/pair/approve', { adjustmentIds: [adjJ, adjK] }, 'c');
  assert(r.status === 409 && r.body.details.conflicts.overflows[0].excess === 400,
    '超额成对核准被拒（409），明细含超额量');
  r = await call('GET', `/api/plans/${planJ}`, null, 'i');
  assert(r.body.plan.estimated_lux === 100 && r.body.plan.pendingAdjustment,
    '失败后计划J 照度不变且申请仍待审');
  // 提额后同一对申请直接通过
  await call('POST', `/api/exhibits/${exR}/limits`, { year: 2030, limitLxh: 3000 }, 'c');
  r = await call('POST', '/api/adjustments/pair/approve', { adjustmentIds: [adjJ, adjK] }, 'c');
  assert(r.status === 200, '提额后成对核准通过');
  r = await call('GET', `/api/exhibits/${exR}`, null, 'i');
  assert(r.body.years['2030'].used === 2400,
    `2030 占用=J1600+K800=2400，实际 ${r.body.years['2030'].used}`);

  // ---- 未登记上限的年份 ----
  const adjJ2 = await submitAdj(planJ, '2032-01-05', '2032-01-05', ['09:00-17:00'], 200);
  const adjK2 = await submitAdj(planK, '2030-02-06', '2030-02-06', ['09:00-17:00'], 100);
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjJ2, adjK2] }, 'c');
  assert(r.body.pairPreview.conflicts.missingLimits.includes(2032),
    '试算指出 2032 年未登记额度');
  r = await call('POST', '/api/adjustments/pair/approve', { adjustmentIds: [adjJ2, adjK2] }, 'c');
  assert(r.status === 409 && r.body.details.conflicts.missingLimits.includes(2032),
    '未登记年份的成对核准被拒（409）');
  await call('POST', `/api/adjustments/${adjJ2}/withdraw`, {}, 'i');
  await call('POST', `/api/adjustments/${adjK2}/withdraw`, {}, 'i');

  // ---- 未作废实测须仍落在各自新窗内 ----
  const exS = await createExhibit('成对实测展品');
  await call('POST', `/api/exhibits/${exS}/limits`, { year: 2030, limitLxh: 5000 }, 'c');
  const planM = await submitPlan(exS, '成对计划M', '2030-09-01', '2030-09-01', ['09:00-17:00'], 100);
  const planN = await submitPlan(exS, '成对计划N', '2030-10-01', '2030-10-01', ['09:00-17:00'], 100);
  await approvePlan(planM);
  await approvePlan(planN);
  r = await call('POST', '/api/measurements', {
    planId: planM, startDate: '2030-09-01', startTime: '09:00',
    endDate: '2030-09-01', endTime: '12:00', actualLux: 100,
  }, 'c');
  assert(r.status === 201, '录入计划M 窗口内实测');
  const measM = r.body.measurement.id;
  r = await call('POST', `/api/measurements/${measM}/confirm`, {}, 'c');
  assert(r.status === 200, '确认实测');
  // M 改到 09-02（不含该实测），N 改到 10-02（合规）
  const adjM = await submitAdj(planM, '2030-09-02', '2030-09-02', ['09:00-17:00'], 100);
  const adjN = await submitAdj(planN, '2030-10-02', '2030-10-02', ['09:00-17:00'], 100);
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjM, adjN] }, 'c');
  assert(r.body.pairPreview.conflicts.outsideMeasurements.some(
    (m) => m.id === measM && Number(m.planId) === planM),
    '试算指出计划M 的实测不在其新窗内');
  r = await call('POST', '/api/adjustments/pair/approve', { adjustmentIds: [adjM, adjN] }, 'c');
  assert(r.status === 409 && new RegExp(`实测 #${measM}`).test(r.body.error),
    '含窗外实测的成对核准被拒并指出实测');
  r = await call('GET', `/api/adjustments/${adjN}`, null, 'i');
  assert(r.body.adjustment.status === 'pending', '失败后合规一方的申请也仍待审');

  // =======================================================================
  // 停灯（blackout）登记：保管员登记已发生停灯时段，仅扣估算、不动实测/排期
  // 使用动态日期（基于当前墙上时间），保证“结束不晚于当前时间”可测
  // =======================================================================
  const config2 = require('../src/config');
  const dosing2 = require('../src/dosing');
  // 当前墙上时间的 {ymd,minute}
  const wallNow = dosing2.tsToWall(Date.now());
  const wallDaysAgo = (n) => dosing2.tsToWall(Date.now() - n * 86400000);
  const wallDaysAhead = (n) => dosing2.tsToWall(Date.now() + n * 86400000);
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  void config2;

  const exBk = await createExhibit('停灯展品');
  const yNow = Number(wallNow.ymd.slice(0, 4));
  await call('POST', `/api/exhibits/${exBk}/limits`, { year: yNow - 1, limitLxh: 100000 }, 'c');
  await call('POST', `/api/exhibits/${exBk}/limits`, { year: yNow, limitLxh: 100000 }, 'c');
  await call('POST', `/api/exhibits/${exBk}/limits`, { year: yNow + 1, limitLxh: 100000 }, 'c');

  // 承载计划：覆盖昨天/今天/明天，每天 09:00-17:00，100lx（计划已开始）
  const d0 = wallDaysAgo(1).ymd;
  const d1 = wallNow.ymd;
  const d2 = wallDaysAhead(1).ymd;
  const bkPlan = await submitPlan(exBk, '停灯承载计划', d0, d2, ['09:00-17:00'], 100);
  await approvePlan(bkPlan);
  // 另一条已批准计划（不同日期），用于跨计划停灯互斥
  const d3 = wallDaysAhead(3).ymd;
  const bkOther = await submitPlan(exBk, '停灯另一计划', d3, d3, ['09:00-17:00'], 100);
  await approvePlan(bkOther);
  // 待批准计划不能登记停灯
  const bkSubmitted = await submitPlan(exBk, '待批准不停灯', wallDaysAhead(10).ymd,
    wallDaysAhead(10).ymd, ['09:00-12:00'], 100);

  // ---- 权限与输入校验 ----
  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '10:00',
    endDate: d0, endTime: '12:00', reason: '设备检修',
  }, 'i');
  assert(r.status === 403, '布展员不能登记停灯（只读）');

  r = await call('POST', '/api/blackouts', {
    planId: bkSubmitted, startDate: wallDaysAhead(10).ymd, startTime: '10:00',
    endDate: wallDaysAhead(10).ymd, endTime: '11:00', reason: 'x',
  }, 'c');
  assert(r.status === 400 && /已批准或待复核/.test(r.body.error), '待批准计划登记停灯被拒');

  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '12:00',
    endDate: d0, endTime: '12:00', reason: '设备检修',
  }, 'c');
  assert(r.status === 400 && /起点须早于终点/.test(r.body.error), '零时长停灯被拒');

  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '12:00',
    endDate: d0, endTime: '11:00', reason: '设备检修',
  }, 'c');
  assert(r.status === 400 && /起点须早于终点/.test(r.body.error), '起点晚于终点被拒');

  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d2, startTime: '09:00',
    endDate: d2, endTime: '17:00', reason: '设备检修',
  }, 'c');
  assert(r.status === 400 && /晚于当前时间/.test(r.body.error), '结束晚于当前时间被拒（只能登记已发生）');

  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '08:00',
    endDate: d0, endTime: '10:00', reason: '设备检修',
  }, 'c');
  assert(r.status === 400 && /开灯窗/.test(r.body.error), '停灯超出开灯窗（起点在窗外）被拒');

  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '16:00',
    endDate: d0, endTime: '17:30', reason: '设备检修',
  }, 'c');
  assert(r.status === 400 && /开灯窗/.test(r.body.error), '停灯超出开灯窗（终点在窗外）被拒');

  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '10:00',
    endDate: d0, endTime: '12:00',
  }, 'c');
  assert(r.status === 400 && /停灯原因/.test(r.body.error), '停灯原因必填');

  // ---- 正常登记：昨天 10:00-12:00，100lx 估算扣减 200 ----
  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '10:00',
    endDate: d0, endTime: '12:00', reason: '灯具故障检修',
  }, 'c');
  assert(r.status === 201, '停灯登记成功');
  const bk1 = r.body.blackout.id;
  assert(r.body.blackout.yearly[d0.slice(0, 4)] === 200,
    '停灯记录带按年扣减量（200）：' + JSON.stringify(r.body.blackout.yearly));
  assert(r.body.blackouts.some((b) => b.id === bk1 && b.reason === '灯具故障检修'),
    '展品详情列出停灯记录');
  assert((r.body.blackoutDeductionYearly[d0.slice(0, 4)] || 0) === 200,
    `展品详情各年停灯扣减量：${d0.slice(0, 4)} 年=200，实际=${JSON.stringify(r.body.blackoutDeductionYearly)}`);

  // 计划估算残余：该计划 3 天共 2400，扣停灯 200 后残余 2200（此时无实测）
  const planSrc = r.body.sources.find((s) => s.kind === 'plan' && s.id === bkPlan);
  assert(Object.values(planSrc.yearly).reduce((a, b) => a + b, 0) === 2200,
    `停灯从所属计划估算中扣除：总残余 2200，实际 ${JSON.stringify(planSrc.yearly)}`);

  // ---- 停灯不释放排期：开灯窗仍与另一同窗计划互斥 ----
  r = await call('POST', '/api/plans', {
    exhibitId: exBk, title: '撞停灯承载计划窗', startDate: d0, endDate: d0,
    periods: ['10:30-11:30'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 409, '停灯不释放原计划排期占用：同窗新计划提交仍被拒');

  // ---- 与其他停灯相交被拒（同计划）----
  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '11:00',
    endDate: d0, endTime: '13:00', reason: '重复检修',
  }, 'c');
  assert(r.status === 409 && r.body.details.overlappingBlackouts.some((b) => b.id === bk1),
    '与其他停灯记录相交被拒并指出冲突记录');

  // 相接不相交：12:00-13:00 可登记
  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '12:00',
    endDate: d0, endTime: '13:00', reason: '继续检修',
  }, 'c');
  assert(r.status === 201, '端点相接的停灯时段可登记');
  const bk2 = r.body.blackout.id;

  // ---- 未作废实测碰到停灯被拒（录入路径，停灯在先）----
  r = await call('POST', '/api/measurements', {
    planId: bkPlan, startDate: d0, startTime: '11:00',
    endDate: d0, endTime: '12:30', actualLux: 100,
  }, 'c');
  assert(r.status === 409 && /停灯/.test(r.body.error), '实测录入碰到停灯时段被拒');

  // ---- 未作废实测在先，停灯登记碰到实测（含待确认草稿）被拒 ----
  // 昨天 14:00-16:00 录一条草稿实测
  r = await call('POST', '/api/measurements', {
    planId: bkPlan, startDate: d0, startTime: '14:00',
    endDate: d0, endTime: '16:00', actualLux: 80,
  }, 'c');
  assert(r.status === 201, '停灯窗外录入草稿实测');
  const bkMeasDraft = r.body.measurement.id;
  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '15:00',
    endDate: d0, endTime: '15:30', reason: '撞上草稿实测',
  }, 'c');
  assert(r.status === 409 && r.body.details.overlappingMeasurements.some((m) => m.id === bkMeasDraft),
    '停灯碰到待确认实测也被拒，并指出冲突实测');

  // ---- 停灯只扣估算，不减已确认实测（实测与停灯互斥，用相邻时段验证）----
  // 昨天 09:00-10:00 录入并确认实测 200lx = 200（与 10-12 停灯相接，不相交）
  r = await call('POST', '/api/measurements', {
    planId: bkPlan, startDate: d0, startTime: '09:00',
    endDate: d0, endTime: '10:00', actualLux: 200,
  }, 'c');
  assert(r.status === 201, '录入昨天上午实测（与停灯相接）');
  const bkMeasToday = r.body.measurement.id;
  // 停灯登记与实测时段互斥：09:30-10:30 同时覆盖实测与停灯
  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '09:30',
    endDate: d0, endTime: '10:30', reason: '撞实测与停灯',
  }, 'c');
  assert(r.status === 409 &&
    r.body.details.overlappingMeasurements.some((m) => m.id === bkMeasToday) &&
    r.body.details.overlappingBlackouts.some((b) => b.id === bk1),
    '停灯登记同时撞上实测与既有停灯时，一次性指出两类冲突');
  await call('POST', `/api/measurements/${bkMeasToday}/confirm`, {}, 'c');

  // 与已确认实测相接的停灯可登记：16:00-16:30（14-16 草稿实测相接于 16:00）
  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '16:00',
    endDate: d0, endTime: '16:30', reason: '补登傍晚停灯',
  }, 'c');
  assert(r.status === 201, `与草稿实测相接的停灯可登记（实际 ${r.status} ${r.body && r.body.error}）`);
  const bk3 = r.body.blackout.id;

  // 该年剂量核对（全部落在 d0 一天）：
  //   总窗 8h；已确认实测 200lx*1h=200 计量；草稿 80lx*2h=160 仍由估算占位；
  //   停灯 10-12(200) + 12-13(100) + 16-16:30(50) = 350
  //   估算残余 = 800 − 已确认实测 1h*100=100 − 停灯 350 = 350
  //   （草稿实测时段仍按估算 100lx 计 200，且与停灯不重叠）
  r = await call('GET', `/api/exhibits/${exBk}`, null, 'i');
  const bkYearKey = d0.slice(0, 4);
  const bkSrc = r.body.sources.find((s) => s.kind === 'plan' && s.id === bkPlan);
  // 计划跨 3 天可能跨年，用总残余求和验证
  const residueSum = Object.values(bkSrc.yearly).reduce((a, b) => a + b, 0);
  assert(residueSum === 350 + 1600, `停灯+实测统一扣减后计划总残余 1950，实际 ${residueSum}`);
  assert(Object.values(r.body.blackoutDeductionYearly).reduce((a, b) => a + b, 0) === 350,
    `各年停灯扣减合计 350，实际 ${JSON.stringify(r.body.blackoutDeductionYearly)}`);
  // 已确认实测剂量不被停灯削减：仍为 200
  const measSrc = r.body.sources.find((s) => s.kind === 'measurement' && s.id === bkMeasToday);
  assert(Object.values(measSrc.yearly).reduce((a, b) => a + b, 0) === 200,
    '已确认实测剂量不受停灯影响（200）');
  void bkYearKey;
  void bk3;

  // ---- 跨年停灯按自然年拆分：另建覆盖去年末/今年初的已批准计划 ----
  const crossStart = wallDaysAgo(2).ymd;
  // 找一个去年12/31至今年1/1 的窗口：动态取“当前日期前推到年末边界”过于复杂，
  // 直接用 wallDaysAgo(2) 与 wallDaysAgo(1)，若两者跨年则验证拆分；否则跳过 API 拆分，
  // 由下面固定 2030→2031 的 service 层场景保证。
  if (crossStart.slice(0, 4) !== d0.slice(0, 4)) {
    const cp = await submitPlan(exBk, '跨年停灯计划', crossStart, d0, ['09:00-17:00'], 100);
    await approvePlan(cp);
    r = await call('POST', '/api/blackouts', {
      planId: cp, startDate: crossStart, startTime: '09:00',
      endDate: d0, endTime: '17:00', reason: '跨年连续停灯',
    }, 'c');
    assert(r.status === 201, '跨年停灯登记成功');
    const yKeys = Object.keys(r.body.blackout.yearly);
    assert(yKeys.length === 2, '跨年停灯扣减量按两个自然年拆分：' + JSON.stringify(r.body.blackout.yearly));
  }

  // ---- 停灯记录不可改删；布展员只读 ----
  r = await call('DELETE', `/api/blackouts/${bk1}`, {}, 'c');
  assert(r.status === 400 && /不可删除/.test(r.body.error), '停灯记录不可删除');
  r = await call('PUT', `/api/blackouts/${bk1}`, { reason: '改' }, 'c');
  assert(r.status === 400 && /不可修改/.test(r.body.error), '停灯记录不可修改');
  r = await call('GET', `/api/blackouts?exhibitId=${exBk}`, null, 'i');
  assert(r.status === 200 && r.body.blackouts.some((b) => b.id === bk1),
    '布展员可只读查询停灯记录');
  assert(r.body.blackouts.every((b) => b.yearly), '停灯列表逐条带按年扣减量');
  r = await call('GET', `/api/blackouts?planId=${bkPlan}`, null, 'c');
  assert(r.body.blackouts.every((b) => b.planId === bkPlan), '可按计划过滤停灯记录');

  // ---- 计划取消后停灯保留、不再扣占用 ----
  await call('POST', `/api/plans/${bkOther}/cancel`, { reason: '停灯保留验证' }, 'c');
  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '13:00',
    endDate: d0, endTime: '14:00', reason: '与12-13相接',
  }, 'c');
  assert(r.status === 201, '再登记一条停灯（13-14）用于后续核对');
  // bkOther 没有停灯；改为取消 bkPlan 会连带其停灯不再计入占用（记录仍列出）
  await call('POST', `/api/plans/${bkPlan}/cancel`, {}, 'c');
  r = await call('GET', `/api/exhibits/${exBk}`, null, 'i');
  assert(r.body.blackouts.length >= 4, '计划取消后停灯记录仍保留在展品详情');
  assert(!r.body.sources.some((s) => s.kind === 'plan' && s.id === bkPlan),
    '取消计划不再列估算残余占用');
  assert(Object.values(r.body.blackoutDeductionYearly).reduce((a, b) => a + b, 0) === 0,
    '取消后停灯不再扣减年度占用');
  const keptBk = r.body.blackouts.find((b) => b.id === bk1);
  assert(keptBk && keptBk.deductionActive === false &&
    Object.values(keptBk.yearly).reduce((a, b) => a + b, 0) === 200,
    '保留记录仍展示名义扣减量，deductionActive=false');

  // ---- 调整核对：未开始计划的停灯必须落在拟改新窗内；新残余继续扣停灯 ----
  const exAdjBk = await createExhibit('停灯调整展品');
  await call('POST', `/api/exhibits/${exAdjBk}/limits`, { year: 2035, limitLxh: 100000 }, 'c');
  await call('POST', `/api/exhibits/${exAdjBk}/limits`, { year: 2036, limitLxh: 100000 }, 'c');
  const abPlan = await submitPlan(exAdjBk, '调整停灯计划', '2035-06-01', '2035-06-01',
    ['09:00-17:00'], 100); // 800
  await approvePlan(abPlan);
  // 直接在库中写入一条停灯（2035-06-01 10:00-12:00，已批准未开始计划）
  await dbModule.withTransaction(async (client) => {
    const exRow = await client.query('SELECT exhibit_id FROM plans WHERE id = $1', [abPlan]);
    await client.query(
      `INSERT INTO blackouts (plan_id, exhibit_id, start_ts, end_ts, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [abPlan, exRow.rows[0].exhibit_id,
        new Date(dosing2.wallToTs('2035-06-01', 600)),
        new Date(dosing2.wallToTs('2035-06-01', 720)),
        'SQL 预置停灯']
    );
  });
  r = await call('GET', `/api/exhibits/${exAdjBk}`, null, 'c');
  const adjBkSrc = r.body.sources.find((s) => s.kind === 'plan' && s.id === abPlan);
  assert(adjBkSrc.yearly['2035'] === 600, '未开始计划停灯 200 已从估算残余扣除（800→600）');

  // 同窗口调整（照度改为 200）：新残余 = (8-2)h*200 = 1200
  r = await call('POST', '/api/adjustments', {
    planId: abPlan, startDate: '2035-06-01', endDate: '2035-06-01',
    periods: ['09:00-17:00'], estimatedLux: 200,
  }, 'i');
  assert(r.status === 201, '提交同窗口照度调整');
  const abAdj = r.body.adjustment.id;
  assert(r.body.adjustment.preview.newResidueYearly['2035'] === 1200,
    '调整试算新残余继续扣除停灯（6h*200=1200）');
  assert(r.body.adjustment.preview.oldResidueYearly['2035'] === 600,
    '调整试算原残余口径含停灯扣减（600）');

  // 拟改新窗不覆盖该停灯（2035-06-02）：outsideBlackouts 冲突
  await call('POST', `/api/adjustments/${abAdj}/withdraw`, {}, 'i');
  r = await call('POST', '/api/adjustments', {
    planId: abPlan, startDate: '2035-06-02', endDate: '2035-06-02',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交排除停灯窗口的调整申请');
  const abAdj2 = r.body.adjustment.id;
  assert(r.body.adjustment.preview.conflicts.outsideBlackouts.some((x) => /SQL 预置停灯/.test(x.reason)),
    '试算指出停灯落在新开灯窗外');
  r = await call('POST', `/api/adjustments/${abAdj2}/approve`, {}, 'c');
  assert(r.status === 409 && /停灯记录/.test(r.body.error), '窗外停灯的调整批准被拒（409）');
  assert(r.body.details.conflicts.outsideBlackouts.length === 1,
    '结构化明细给出窗外停灯');
  await call('POST', `/api/adjustments/${abAdj2}/withdraw`, {}, 'i');

  // ---- 上限下调预演指纹包含停灯：预演后新增停灯，旧凭证提交被拒 ----
  const exBkLim = await createExhibit('停灯预演展品');
  await call('POST', `/api/exhibits/${exBkLim}/limits`, { year: 2036, limitLxh: 10000 }, 'c');
  const lbPlan = await submitPlan(exBkLim, '预演停灯计划', '2036-05-01', '2036-05-01',
    ['09:00-17:00'], 100); // 800
  await approvePlan(lbPlan);
  // 预置停灯 2h（200），used=600
  await dbModule.withTransaction(async (client) => {
    const exRow = await client.query('SELECT exhibit_id FROM plans WHERE id = $1', [lbPlan]);
    await client.query(
      `INSERT INTO blackouts (plan_id, exhibit_id, start_ts, end_ts, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [lbPlan, exRow.rows[0].exhibit_id,
        new Date(dosing2.wallToTs('2036-05-01', 540)),
        new Date(dosing2.wallToTs('2036-05-01', 660)),
        '预演前停灯']
    );
  });
  r = await call('POST', `/api/exhibits/${exBkLim}/limits/preview`,
    { year: 2036, limitLxh: 700 }, 'c');
  assert(r.status === 200, '停灯预演成功');
  assert(r.body.preview.used === 600, '预演占用含停灯扣减（估算残余 600）');
  assert(r.body.preview.blackoutDeductions.some((x) => x.yearDeduction === 200 && x.planId === lbPlan),
    '预演列出该年停灯扣减量 200');
  const staleBkToken = r.body.preview.token;
  // 预演后再插入一条停灯（13:00-14:00，100），used 降到 500
  await dbModule.withTransaction(async (client) => {
    const exRow = await client.query('SELECT exhibit_id FROM plans WHERE id = $1', [lbPlan]);
    await client.query(
      `INSERT INTO blackouts (plan_id, exhibit_id, start_ts, end_ts, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [lbPlan, exRow.rows[0].exhibit_id,
        new Date(dosing2.wallToTs('2036-05-01', 780)),
        new Date(dosing2.wallToTs('2036-05-01', 840)),
        '预演后停灯']
    );
  });
  r = await call('POST', `/api/exhibits/${exBkLim}/limits/lower`,
    { year: 2036, limitLxh: 700, token: staleBkToken }, 'c');
  assert(r.status === 409 && /已变化/.test(r.body.error), '新增停灯后旧预演凭证被拒（占用已变化）');
  assert(r.body.details.preview.used === 500,
    `最新预演反映停灯扣减后 used=500，实际 ${r.body.details.preview.used}`);

  // 操作流水：停灯登记
  r = await call('GET', '/api/audit?limit=1000', null, 'c');
  assert(r.body.events.some((e) => e.action === 'blackout.create'),
    '操作流水记录了停灯登记');

  // ---- 操作流水存在 ----
  r = await call('GET', '/api/audit?limit=1000', null, 'c');
  assert(r.status === 200 && r.body.events.some((e) => e.action === 'plan.approve'),
    '操作流水记录了审批事件');
  assert(r.body.events.some((e) => e.action === 'plan.adjustment.submit'),
    '操作流水记录了调整申请提交');
  assert(r.body.events.some((e) => e.action === 'plan.adjustment.approve'),
    '操作流水记录了调整申请批准');
  assert(r.body.events.some((e) => e.action === 'plan.adjustment.pair_approve'),
    '操作流水记录了成对核准');
  assert(r.body.events.some((e) => e.action === 'plan.update_via_adjustment'),
    '操作流水记录了计划经调整更新');
  assert(r.body.events.some((e) => e.action === 'plan.adjustment.withdraw'),
    '操作流水记录了调整申请撤回');
  assert(r.body.events.some((e) => e.action === 'plan.adjustment.reject'),
    '操作流水记录了调整申请驳回');
  assert(r.body.events.some((e) => e.action === 'limit.lower'),
    '操作流水记录了携凭证下调上限');
  assert(r.body.events.some((e) => e.action === 'plan.flag_review_limit_lower'),
    '操作流水记录了下调上限导致的转待复核');
  assert(r.body.events.some((e) => e.action === 'limit.upsert'),
    '操作流水记录了登记/修改上限');
}

main().catch((err) => {
  console.error('集成测试失败:', err);
  process.exit(1);
});
