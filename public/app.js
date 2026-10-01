'use strict';

const state = {
  user: null,
  tab: 'exhibits',
  exhibits: [],
  detail: null,
  plans: [],
  measurements: [],
  users: [],
  adjustments: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------- API ----------
async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    /* 非 JSON */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data || {};
}

// ---------- 通用渲染辅助 ----------
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
const fmtN = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 3 }));
// 日期列兼容 'YYYY-MM-DD' 与 ISO 字符串两种形态，只取日期部分
const ymdText = (v) => (v === null || v === undefined ? '—' : String(v).slice(0, 10));
const STATUS_TEXT = {
  submitted: '待批准', approved: '已批准', rejected: '已驳回',
  cancelled: '已取消', pending_review: '待复核',
  draft: '待确认', confirmed: '已确认', annulled: '已作废',
  pending: '待审', withdrawn: '已撤回',
};
function badge(status) {
  return `<span class="badge ${esc(status)}">${STATUS_TEXT[status] || esc(status)}</span>`;
}
function yearlyText(yearly) {
  const entries = Object.entries(yearly || {});
  if (!entries.length) return '无剂量';
  return entries.map(([y, d]) => `${y}年：${fmtN(d)} lx·h`).join('，');
}
function flash(kind, message, extrasHtml) {
  const el = $('#global-message');
  el.innerHTML = `<div class="flash ${kind}">${esc(message)}${extrasHtml || ''}</div>`;
  if (kind === 'success') setTimeout(() => { el.innerHTML = ''; }, 4000);
}
function clearFlash() { $('#global-message').innerHTML = ''; }

// ---------- 登录 / 会话 ----------
async function boot() {
  const { user } = await api('GET', '/api/auth/me');
  if (user) {
    state.user = user;
    showApp();
  } else {
    showLogin();
  }
}
function showLogin() {
  $('#login-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
}
function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  applyRoleVisibility();
  $('#user-info').textContent = `${state.user.displayName}（${state.user.role === 'conservator' ? '保管员' : '布展员'}）`;
  switchTab(state.user.role === 'installer' ? 'plans' : 'exhibits');
}
function applyRoleVisibility() {
  const isConservator = state.user.role === 'conservator';
  $$('.conservator-only').forEach((el) => el.classList.toggle('hidden', !isConservator));
  $$('.installer-only').forEach((el) => el.classList.toggle('hidden', isConservator));
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const fd = new FormData(e.target);
  try {
    const { user } = await api('POST', '/api/auth/login', {
      username: fd.get('username'),
      password: fd.get('password'),
    });
    state.user = user;
    showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});
$('#logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout').catch(() => {});
  state.user = null;
  location.reload();
});

// ---------- Tabs ----------
$$('.tab').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
async function switchTab(tab) {
  state.tab = tab;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-panel').forEach((p) => p.classList.add('hidden'));
  $(`#tab-${tab}`).classList.remove('hidden');
  clearFlash();
  if (tab === 'exhibits') await loadExhibits();
  if (tab === 'plans') await loadPlans();
  if (tab === 'measurements') await loadMeasurementsTab();
  if (tab === 'users') await loadUsers();
  if (tab === 'audit') await loadAudit();
}

// ---------- 展品与额度 ----------
async function loadExhibits() {
  const { exhibits } = await api('GET', '/api/exhibits');
  state.exhibits = exhibits;
  const list = $('#exhibit-list');
  if (!exhibits.length) {
    list.innerHTML = '<p class="muted">暂无展品。保管员可点击右上角“登记展品”。</p>';
  } else {
    list.innerHTML = exhibits.map((e) => {
      const years = Object.values(e.years || {});
      const chips = years.map((y) => {
        const cls = y.over ? 'over' : y.remaining !== null && y.remaining < y.limit * 0.1 ? 'warn' : '';
        return `<div class="chip ${cls}"><span>${y.year} 年剩余</span>
          <span class="mono">${y.limit === null ? '未设上限' : `${fmtN(y.remaining)} / ${fmtN(y.limit)} lx·h`}</span></div>`;
      }).join('');
      return `<div class="card exhibit-card" data-id="${e.id}">
        <h3>${esc(e.name)}</h3>
        <div class="acc">${esc(e.accession_no || '—')}${e.medium ? ' · ' + esc(e.medium) : ''}</div>
        <div class="year-chips">${chips || '<span class="muted small">尚未登记年度额度</span>'}</div>
      </div>`;
    }).join('');
    $$('.exhibit-card').forEach((card) =>
      card.addEventListener('click', () => openDetail(Number(card.dataset.id)))
    );
  }
  if (state.detail) $('#exhibit-detail').classList.add('hidden');
}

$('#new-exhibit-btn').addEventListener('click', async () => {
  const name = prompt('展品名称');
  if (!name) return;
  const accessionNo = prompt('藏品编号（可留空）') || null;
  const medium = prompt('材质（可留空）') || null;
  try {
    await api('POST', '/api/exhibits', { name: name.trim(), accessionNo, medium });
    await loadExhibits();
    flash('success', '展品已登记');
  } catch (err) { flash('error', err.message); }
});

async function openDetail(id) {
  const detail = await api('GET', `/api/exhibits/${id}`);
  state.detail = detail;
  $('#exhibit-list').classList.add('hidden');
  $('#new-exhibit-btn').classList.add('hidden');
  $('#exhibit-detail').classList.remove('hidden');
  hideLimitPreview();
  $('#pair-result').innerHTML = '';
  renderDetail();
}
$('#close-detail').addEventListener('click', () => {
  state.detail = null;
  $('#exhibit-detail').classList.add('hidden');
  $('#exhibit-list').classList.remove('hidden');
  $('#new-exhibit-btn').classList.remove('hidden');
});

function renderDetail() {
  const d = state.detail;
  $('#detail-title').textContent = d.exhibit.name;
  $('#detail-meta').textContent =
    `编号：${d.exhibit.accession_no || '—'}　材质：${d.exhibit.medium || '—'}${d.exhibit.note ? '　备注：' + d.exhibit.note : ''}`;

  const years = Object.values(d.years);
  $('#year-tbody').innerHTML = years.length ? years.map((y) => `<tr class="${y.over ? 'over-row' : ''}">
      <td>${y.year}</td>
      <td class="mono">${y.limit === null ? '未登记' : fmtN(y.limit)}</td>
      <td class="mono">${fmtN(y.used)}</td>
      <td class="mono">${y.remaining === null ? '—' : fmtN(y.remaining)}</td>
      <td>${y.limit === null ? '<span class="muted">无法核算</span>'
        : y.over ? `<b style="color:#b42318">超限 ${fmtN(y.used - y.limit)}</b>` : '正常'}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="muted">暂无数据</td></tr>';

  $('#sources-list').innerHTML = (d.sources || []).map((s) => {
    if (s.kind === 'measurement') {
      return `<div class="source-item measurement">
        实测 #${s.id}（计划 #${s.planId}）：${esc(s.start)} ~ ${esc(s.end)}，${s.lux} lx
        <div class="source-doses">已确认实测剂量：${yearlyText(s.yearly)}</div></div>`;
    }
    return `<div class="source-item plan ${s.status}">
      估算残余 · 计划 #${s.id}「${esc(s.title)}」${badge(s.status)}
      ：${esc(s.startDate)} ~ ${esc(s.endDate)}，每日 ${(s.periods || []).map(esc).join('、')}，${s.lux} lx
      <div class="source-doses">占用额度：${yearlyText(s.yearly)}（已扣除被实测覆盖与停灯部分）</div></div>`;
  }).join('') || '<p class="muted">暂无占用</p>';

  $('#detail-plan-tbody').innerHTML = d.plans.map(planRow).join('') ||
    '<tr><td colspan="7" class="muted">暂无计划</td></tr>';
  $('#detail-meas-tbody').innerHTML = d.measurements.map(measRow).join('') ||
    '<tr><td colspan="7" class="muted">暂无实测</td></tr>';
  renderBlackouts(d);

  $$('.plan-action').forEach((btn) => btn.addEventListener('click', () => planAction(btn)));
  $$('.meas-action').forEach((btn) => btn.addEventListener('click', () => measAction(btn)));
  $$('.adj-action').forEach((btn) => btn.addEventListener('click', () => adjustmentAction(btn)));
  $$('.adj-open').forEach((btn) => btn.addEventListener('click', () => openAdjustmentForm(Number(btn.dataset.id))));
  renderPairBox();
}

/** 渲染停灯记录与各年扣减量，并填充登记表单的计划下拉（仅已批准/待复核）。 */
function renderBlackouts(d) {
  const tbody = $('#detail-blackout-tbody');
  if (!tbody) return;
  const blackouts = d.blackouts || [];
  tbody.innerHTML = blackouts.length ? blackouts.map((b) => {
    const inactive = b.deductionActive === false;
    return `<tr${inactive ? ' class="over-row"' : ''}>
      <td>${b.id}</td>
      <td>#${b.planId} ${esc(b.planTitle || '')}
        ${b.planStatus ? `<div class="small muted">${badge(b.planStatus)}</div>` : ''}
        ${inactive ? '<div class="small muted">计划已不占用，记录保留（名义扣减量）</div>' : ''}</td>
      <td>${esc(b.start)}</td><td>${esc(b.end)}</td>
      <td>${esc(b.reason)}</td>
      <td class="mono">${yearlyText(b.yearly)}</td>
      <td class="small">${esc(b.creatorName || '—')}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" class="muted">暂无停灯记录</td></tr>';

  const sel = $('#blackout-plan-select');
  if (sel) {
    const active = (d.plans || []).filter((p) => ['approved', 'pending_review'].includes(p.status));
    sel.innerHTML = active.length
      ? active.map((p) => `<option value="${p.id}">#${p.id} ${esc(p.title)}（${ymdText(p.start_date)}~${ymdText(p.end_date)}）</option>`).join('')
      : '<option value="">（暂无已批准/待复核计划）</option>';
  }
}

$('#blackout-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.detail) return;
  const fd = new FormData(e.target);
  const planId = Number(fd.get('planId'));
  if (!planId) { flash('error', '请选择已批准或待复核计划'); return; }
  try {
    const detail = await api('POST', '/api/blackouts', {
      planId,
      startDate: fd.get('startDate'),
      startTime: fd.get('startTime'),
      endDate: fd.get('endDate') || fd.get('startDate'),
      endTime: fd.get('endTime'),
      reason: fd.get('reason'),
    });
    state.detail = detail;
    e.target.reset();
    renderDetail();
    const ded = Object.entries(detail.blackout.yearly || {})
      .map(([y, v]) => `${y} 年 ${fmtN(v)} lx·h`).join('，');
    flash('success', `停灯已登记并从估算中扣减（${ded}）；记录保留、不可改删`);
  } catch (err) {
    if (err.status === 409 && err.data && err.data.details) {
      const det = err.data.details;
      const items = [];
      (det.overlappingMeasurements || []).forEach((m) =>
        items.push(`与${m.status === 'draft' ? '待确认' : '已确认'}实测 #${m.id}（${esc(m.start)} ~ ${esc(m.end)}）相交`));
      (det.overlappingBlackouts || []).forEach((b) =>
        items.push(`与停灯记录 #${b.id}（${esc(b.start)} ~ ${esc(b.end)}）相交`));
      flash('error', err.message, items.length ? '<ul>' + items.map((x) => `<li>${x}</li>`).join('') + '</ul>' : '');
    } else {
      flash('error', err.message);
    }
  }
});

function planRow(p) {
  return `<tr>
    <td>${p.id}</td>
    <td>${esc(p.title)}</td>
    <td>${ymdText(p.start_date)} ~ ${ymdText(p.end_date)}</td>
    <td>${(p.light_periods || []).map(esc).join('<br>')}</td>
    <td class="mono">${fmtN(p.estimated_lux)}</td>
    <td>${badge(p.status)}${p.review_reason ? `<div class="small muted">${esc(p.review_reason)}</div>` : ''}
        ${p.status === 'approved' && p.notStarted ? '<div class="small ok">尚未开始</div>' : ''}
        ${pendingAdjustmentBlock(p)}</td>
    <td>${planActionButtons(p)}</td>
  </tr>`;
}
function planActionButtons(p) {
  const isCustodian = state.user.role === 'conservator';
  const btns = [];
  if (isCustodian && (p.status === 'submitted' || p.status === 'pending_review')) {
    btns.push(`<button class="primary small-btn plan-action" data-action="approve" data-id="${p.id}">${p.status === 'pending_review' ? '复核通过' : '批准'}</button>`);
  }
  if (isCustodian && p.status === 'submitted') {
    btns.push(`<button class="small-btn plan-action" data-action="reject" data-id="${p.id}">驳回</button>`);
  }
  if (['submitted', 'approved', 'pending_review'].includes(p.status)) {
    btns.push(`<button class="danger small-btn plan-action" data-action="cancel" data-id="${p.id}">取消</button>`);
  }
  // 已批准且尚未开始的计划：布展员可提交调整申请
  if (!isCustodian && p.status === 'approved' && p.notStarted && !p.pendingAdjustment) {
    btns.push(`<button class="small-btn plan-action adj-open" data-id="${p.id}">申请调整</button>`);
  }
  return btns.join(' ') || '<span class="muted">—</span>';
}

/** 原计划 vs 拟改值的对照行。 */
function scheduleDiff(orig, next) {
  const span = (s, e) => `${s} ~ ${e}`;
  const periods = (arr) => (arr || []).map(esc).join('、');
  const changed = (a, b) => (String(a) !== String(b) ? ' class="changed"' : '');
  return `<table class="diff-table"><tbody>
    <tr><th>展期</th>
      <td${changed(span(orig.startDate, orig.endDate), span(next.startDate, next.endDate))}>${esc(span(orig.startDate, orig.endDate))}</td>
      <td${changed(span(orig.startDate, orig.endDate), span(next.startDate, next.endDate))}>${esc(span(next.startDate, next.endDate))}</td></tr>
    <tr><th>每日开灯</th>
      <td${changed(periods(orig.periods), periods(next.periods))}>${periods(orig.periods)}</td>
      <td${changed(periods(orig.periods), periods(next.periods))}>${periods(next.periods)}</td></tr>
    <tr><th>预计照度</th>
      <td${changed(orig.estimatedLux, next.estimatedLux)}>${fmtN(orig.estimatedLux)} lx</td>
      <td${changed(orig.estimatedLux, next.estimatedLux)}>${fmtN(next.estimatedLux)} lx</td></tr>
  </tbody></table>`;
}

/** 调整试算冲突明细（批准前核对结果）。 */
function adjustmentConflictsHtml(pv) {
  if (!pv) return '';
  const c = pv.conflicts || {};
  const items = [];
  if (c.notApproved) items.push('计划已不是「已批准」状态');
  if (c.notStarted) items.push('计划已经开始');
  (c.outsideMeasurements || []).forEach((m) =>
    items.push(`未作废实测 #${m.id}（${esc(m.start)} ~ ${esc(m.end)}，${STATUS_TEXT[m.status] || m.status}）不在新开灯窗内`));
  (c.overlappingPlans || []).forEach((p2) =>
    items.push(`与同展品${p2.status === 'pending_review' ? '待复核' : '已批准'}计划「${esc(p2.title)}」(#${p2.id}) 开灯时间重叠`));
  (c.missingLimits || []).forEach((y) => items.push(`${y} 年尚未登记年度额度`));
  (c.overflows || []).forEach((o) =>
    items.push(`${o.year} 年超额 <b>${fmtN(o.excess)} lx·h</b>（上限 ${fmtN(o.limit)}，其他占用 ${fmtN(o.usedByOthers)}，原残余 ${fmtN(o.oldResidue)}，拟改残余 ${fmtN(o.newResidue)}，合计 ${fmtN(o.projected)}）`));
  if (items.length === 0) {
    return `<div class="adj-ok">核对通过：拟改残余按年 ${yearlyText(pv.newResidueYearly)}</div>`;
  }
  return `<div class="adj-conflict"><b>当前核对未通过：</b><ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul></div>`;
}

/** 计划行下的待审调整申请区块（展品详情 + 计划列表共用）。 */
function pendingAdjustmentBlock(p) {
  const a = p.pendingAdjustment;
  if (!a) return '';
  const isCustodian = state.user.role === 'conservator';
  const isOwner = !isCustodian; // 布展员视图只处理自己提交的（后端再次鉴权）
  const orig = a.original || {
    startDate: p.start_date, endDate: p.end_date,
    periods: p.light_periods, estimatedLux: p.estimated_lux,
  };
  const next = { startDate: a.startDate, endDate: a.endDate, periods: a.periods, estimatedLux: a.estimatedLux };
  const btns = [];
  if (isCustodian) {
    btns.push(`<button class="primary small-btn adj-action" data-action="approve" data-id="${a.id}">批准调整</button>`);
    btns.push(`<button class="small-btn adj-action" data-action="reject" data-id="${a.id}">驳回</button>`);
  } else if (isOwner) {
    btns.push(`<button class="danger small-btn adj-action" data-action="withdraw" data-id="${a.id}">撤回申请</button>`);
  }
  return `<div class="adj-box">
    <div class="adj-head">${badge(a.status)}调整申请 #${a.id}
      <span class="muted small">申请人 ${esc(a.creatorName || '')}${a.reason ? '；' + esc(a.reason) : ''}</span></div>
    ${scheduleDiff(orig, next)}
    ${a.preview ? adjustmentConflictsHtml(a.preview) : ''}
    <div class="adj-btns">${btns.join(' ')}</div>
  </div>`;
}
function measRow(m) {
  const plan = (state.detail.plans || []).find((p) => p.id === m.planId);
  return `<tr>
    <td>${m.id}</td>
    <td>#${m.planId} ${esc(plan ? plan.title : '')}</td>
    <td>${esc(m.start)}</td><td>${esc(m.end)}</td>
    <td class="mono">${fmtN(m.actualLux)}</td>
    <td>${badge(m.status)}</td>
    <td>${m.status === 'draft' && state.user.role === 'conservator'
      ? `<button class="primary small-btn meas-action" data-action="confirm" data-id="${m.id}">确认</button>
         <button class="danger small-btn meas-action" data-action="delete" data-id="${m.id}">删除</button>`
      : '<span class="muted">—</span>'}</td>
  </tr>`;
}

$('#limit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const detail = await api('POST', `/api/exhibits/${state.detail.exhibit.id}/limits`, {
      year: Number(fd.get('year')),
      limitLxh: Number(fd.get('limitLxh')),
    });
    state.detail = detail;
    hideLimitPreview();
    renderDetail();
    if (detail.limitLowered) {
      const lv = detail.limitLowered;
      flash('warn',
        `年度上限已下调（${lv.year} 年：${fmtN(lv.previousLimit)} → ${fmtN(lv.newLimit)} lx·h），预计超额 ${fmtN(lv.excess)} lx·h`,
        limitLoweredExtrasHtml(detail));
    } else {
      flash('success', '年度上限已保存');
    }
  } catch (err) { flash('error', err.message); }
});

// ---------- 下调年度上限：预演 + 携凭证提交 ----------
function hideLimitPreview() {
  const box = $('#limit-preview-box');
  box.classList.add('hidden');
  box.innerHTML = '';
}

function limitLoweredExtrasHtml(detail) {
  const flagged = detail.flaggedPlans || [];
  return (flagged.length
    ? '<div>已转为待复核的未开始计划：' +
      flagged.map((p) => `#${p.id}《${esc(p.title)}》`).join('、') + '</div>'
    : '<div>该年没有仍在占用估算残余且尚未开始的已批准计划（已开始计划不转状态，剩余超额仍如实显示）。</div>');
}

/** 渲染一次预演结果（含提交按钮；stale=true 表示这是提交被拒后的最新结果）。 */
function renderLimitPreview(pv, { stale = false } = {}) {
  const box = $('#limit-preview-box');
  box.classList.remove('hidden');
  const measRows = (pv.confirmedMeasurements || []).map((m) =>
    `<tr><td>#${m.id}（计划 #${m.planId}）</td><td>${esc(m.start)} ~ ${esc(m.end)}</td>
      <td class="mono">${fmtN(m.lux)}</td><td class="mono">${fmtN(m.yearDose)}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">该年暂无已确认实测</td></tr>';
  const planRows = (pv.planResidues || []).map((p) =>
    `<tr class="${p.status === 'pending_review' ? 'over-row' : ''}">
      <td>#${p.id} ${esc(p.title)} ${badge(p.status)}</td>
      <td>${esc(p.startDate)} ~ ${esc(p.endDate)}</td>
      <td class="mono">${fmtN(p.yearResidue)}</td>
      <td>${p.notStarted ? '<span class="ok">尚未开始</span>' : '<span class="muted">已开始（不转状态）</span>'}</td>
     </tr>`).join('')
    || '<tr><td colspan="4" class="muted">该年暂无已批准/待复核计划的估算残余</td></tr>';
  const flagged = pv.flagCandidates || [];
  const started = pv.startedResiduePlans || [];
  const head = pv.over
    ? `<div class="adj-conflict"><b>预计 ${pv.year} 年超额 ${fmtN(pv.excess)} lx·h</b>
        （上限 ${fmtN(pv.proposedLimit)}，已确认实测 + 各计划估算残余合计 ${fmtN(pv.used)}）</div>`
    : `<div class="adj-ok">下调后 ${pv.year} 年仍有 ${fmtN(pv.remaining)} lx·h 剩余额度，不超额。</div>`;
  const flaggedHtml = pv.over
    ? `<div class="small" style="margin:6px 0">
        ${flagged.length
          ? '提交后以下 <b>' + flagged.length + '</b> 条仍有该年估算残余且尚未开始的已批准计划将转为「待复核」：'
            + flagged.map((p) => `#${p.id}《${esc(p.title)}》（残余 ${fmtN(p.yearResidue)}，首次开灯 ${esc(p.firstStart)}）`).join('、')
          : '没有可转待复核的未开始计划。'}
        ${started.length
          ? '<br>已开始、仍在占用该年估算残余的计划（不转状态，剩余超额仍显示）：'
            + started.map((p) => `#${p.id}《${esc(p.title)}》（残余 ${fmtN(p.yearResidue)}）`).join('、')
          : ''}
      </div>`
    : '';
  box.innerHTML = `
    <div class="panel-head">
      <h4>下调预演：${state.detail.exhibit.name} / ${pv.year} 年</h4>
      <button type="button" class="link" id="limit-preview-close">收起</button>
    </div>
    ${stale ? '<div class="adj-conflict">额度或相关占用自预演后已变化，以下为最新核算结果，请确认后重新提交。</div>' : ''}
    <div class="small muted">现行上限 <b>${fmtN(pv.currentLimit)}</b> → 拟定上限 <b>${fmtN(pv.proposedLimit)}</b> lx·h；预演不修改任何数据。</div>
    ${head}
    <table class="data" style="margin-top:8px">
      <thead><tr><th>该年已确认实测</th><th>时段</th><th>实测照度 lx</th><th>该年剂量 lx·h</th></tr></thead>
      <tbody>${measRows}</tbody>
    </table>
    <table class="data" style="margin-top:8px">
      <thead><tr><th>已批准/待复核计划</th><th>展期</th><th>该年估算残余 lx·h</th><th>是否尚未开始</th></tr></thead>
      <tbody>${planRows}</tbody>
    </table>
    ${flaggedHtml}
    <div class="adj-btns">
      <button type="button" class="primary" id="limit-lower-confirm">按 ${fmtN(pv.proposedLimit)} lx·h 提交下调</button>
    </div>`;
  $('#limit-preview-close').addEventListener('click', hideLimitPreview);
  $('#limit-lower-confirm').addEventListener('click', () => submitLower(pv));
}

$('#limit-preview-btn').addEventListener('click', async () => {
  const form = $('#limit-form');
  const year = Number(form.elements.year.value);
  const limitLxh = Number(form.elements.limitLxh.value);
  if (!Number.isInteger(year) || !(limitLxh > 0)) {
    flash('error', '请先填写 1900-2999 的年份与正数上限');
    return;
  }
  try {
    const { preview } = await api('POST',
      `/api/exhibits/${state.detail.exhibit.id}/limits/preview`, { year, limitLxh });
    renderLimitPreview(preview);
    flash('success', '预演完成：请核对核算结果后在下方确认提交（预演未改动任何数据）');
  } catch (err) { flash('error', err.message); }
});

/** 携预演凭证提交下调。 */
async function submitLower(pv) {
  try {
    const detail = await api('POST', `/api/exhibits/${state.detail.exhibit.id}/limits/lower`, {
      year: pv.year,
      limitLxh: pv.proposedLimit,
      token: pv.token,
    });
    state.detail = detail;
    hideLimitPreview();
    renderDetail();
    if (detail.overflows && detail.overflows.length) {
      const o = detail.overflows[0];
      flash('warn',
        `年度上限已下调（${o.year} 年：${fmtN(o.previousLimit)} → ${fmtN(o.limit)} lx·h），预计超额 ${fmtN(o.excess)} lx·h`,
        limitLoweredExtrasHtml(detail));
    } else {
      flash('success', '年度上限已下调');
    }
  } catch (err) {
    if (err.status === 409 && err.data && err.data.details && err.data.details.preview) {
      state.detail = await api('GET', `/api/exhibits/${state.detail.exhibit.id}`);
      renderDetail();
      renderLimitPreview(err.data.details.preview, { stale: true });
      flash('warn', '额度或相关占用已变化，下调未执行，已返回最新预演结果');
    } else {
      flash('error', err.message);
    }
  }
}

async function planAction(btn) {
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  try {
    if (action === 'approve') {
      // 批准成功返回展品详情
      const detail = await api('POST', `/api/plans/${id}/approve`);
      state.detail = detail;
      renderDetail();
      flash('success', `计划 #${id} 已批准`);
      return;
    }
    if (action === 'reject') {
      const reason = prompt('驳回原因（可留空）') || '';
      await api('POST', `/api/plans/${id}/reject`, { reason });
    }
    if (action === 'cancel') {
      if (!confirm(`确认取消计划 #${id}？`)) return;
      const reason = prompt('取消原因（可留空）') || '';
      await api('POST', `/api/plans/${id}/cancel`, { reason });
    }
    await refreshAfterChange();
    flash('success', '操作完成');
  } catch (err) {
    if (err.status === 409 && err.data && err.data.details && err.data.details.overflows) {
      const ofs = err.data.details.overflows;
      const html = '<ul>' + ofs.map((o) =>
        `<li>${o.year} 年：上限 ${fmtN(o.limit)}，当前已用 ${fmtN(o.usedBefore)}，本计划新增 ${fmtN(o.addedByThisPlan)}，合计 ${fmtN(o.projected)}，<b>超额 ${fmtN(o.excess)} lx·h</b></li>`
      ).join('') + '</ul>';
      flash('error', `计划 #${id} 未批准：存在超限年份`, html);
      await refreshAfterChange();
    } else {
      flash('error', err.message);
    }
  }
}

async function measAction(btn) {
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  try {
    if (action === 'delete') {
      if (!confirm(`删除待确认实测 #${id}？`)) return;
      await api('DELETE', `/api/measurements/${id}`);
    } else if (action === 'confirm') {
      try {
        const detail = await api('POST', `/api/measurements/${id}/confirm`);
        state.detail = detail;
        renderDetail();
        flash('success', `实测 #${id} 已确认，估算已被实测替代`);
        return;
      } catch (err) {
        if (err.status === 409 && err.data && err.data.overflows) {
          const html = '<ul>' + err.data.overflows.map((o) =>
            `<li>${o.year} 年：上限 ${fmtN(o.limit)}，确认后合计 ${fmtN(o.projected)}，<b>超额 ${fmtN(o.excess)} lx·h</b></li>`
          ).join('') + '</ul>'
            + (err.data.flaggedPlans && err.data.flaggedPlans.length
              ? '<div>已转为待复核的计划：' + err.data.flaggedPlans.map((p) => `#${p.id}《${esc(p.title)}》`).join('、') + '</div>'
              : '');
          if (err.data.detail) {
            state.detail = err.data.detail;
            renderDetail();
          }
          flash('warn', `实测 #${id} 已确认，但造成超限`, html);
          return;
        }
        throw err;
      }
    }
    await refreshAfterChange();
  } catch (err) {
    flash('error', err.message);
  }
}

async function refreshAfterChange() {
  if (state.tab === 'exhibits' && state.detail) {
    state.detail = await api('GET', `/api/exhibits/${state.detail.exhibit.id}`);
    renderDetail();
  } else if (state.tab === 'exhibits') {
    await loadExhibits();
  } else if (state.tab === 'plans') {
    await loadPlans();
  } else if (state.tab === 'measurements') {
    await loadMeasurementsTab();
  }
}

// ---------- 布展计划 ----------
async function loadPlans() {
  await populateExhibitSelects();
  const { plans } = await api('GET', '/api/plans');
  state.plans = plans;
  $('#plan-list').innerHTML = plans.length
    ? `<table class="data"><thead><tr>
        <th>#</th><th>展品</th><th>名称</th><th>展期</th><th>每日开灯</th><th>预计照度</th>
        <th>按年预计剂量</th><th>状态</th><th>操作</th></tr></thead><tbody>
      ${plans.map(planListRow).join('')}</tbody></table>`
    : '<p class="muted">暂无计划。</p>';
  $$('.plan-action').forEach((btn) => btn.addEventListener('click', () => planAction(btn)));
  $$('.adj-action').forEach((btn) => btn.addEventListener('click', () => adjustmentAction(btn)));
  $$('.adj-open').forEach((btn) => btn.addEventListener('click', () => openAdjustmentForm(Number(btn.dataset.id))));
}
function planListRow(p) {
  const yearly = (p.light_periods || []); // 仅用于显示行结构，按年剂量由详情接口展示
  void yearly;
  return `<tr>
    <td>${p.id}</td>
    <td>${esc(p.exhibit_name)}</td>
    <td>${esc(p.title)}</td>
    <td>${ymdText(p.start_date)}<br>~ ${ymdText(p.end_date)}</td>
    <td>${(p.light_periods || []).map(esc).join('<br>')}</td>
    <td class="mono">${fmtN(p.estimated_lux)} lx</td>
    <td><button class="link small-btn plan-action" data-action="view" data-id="${p.id}">查看拆分</button></td>
    <td>${badge(p.status)}${p.review_reason ? `<div class="small muted">${esc(p.review_reason)}</div>` : ''}
        ${p.status === 'approved' && p.notStarted ? '<div class="small ok">尚未开始</div>' : ''}
        ${pendingAdjustmentBlock(p)}</td>
    <td>${planActionButtons(p)}</td>
  </tr>`;
}

async function populateExhibitSelects() {
  if (!state.exhibits.length) {
    state.exhibits = (await api('GET', '/api/exhibits')).exhibits;
  }
  const opts = state.exhibits.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
  $('#plan-exhibit-select').innerHTML = opts || '<option value="">（请先登记展品）</option>';

  // 实测计划下拉：仅已批准/待复核
  const activePlans = [];
  for (const e of state.exhibits) {
    const detail = await api('GET', `/api/exhibits/${e.id}`);
    for (const p of detail.plans) {
      if (['approved', 'pending_review'].includes(p.status)) activePlans.push({ e, p });
    }
  }
  $('#meas-plan-select').innerHTML = activePlans.length
    ? activePlans.map(({ e, p }) =>
        `<option value="${p.id}">#${p.id} ${esc(e.name)} / ${esc(p.title)}（${p.start_date}~${p.end_date}）</option>`).join('')
    : '<option value="">暂无已批准计划</option>';
}

$('#plan-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const periods = String(fd.get('periods')).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  try {
    await api('POST', '/api/plans', {
      exhibitId: Number(fd.get('exhibitId')),
      title: fd.get('title'),
      startDate: fd.get('startDate'),
      endDate: fd.get('endDate'),
      periods,
      estimatedLux: Number(fd.get('estimatedLux')),
    });
    e.target.reset();
    await loadPlans();
    flash('success', '计划已提交，等待保管员批准');
  } catch (err) { flash('error', err.message); }
});

// “查看拆分”按钮：拉计划详情展示按年剂量
document.addEventListener('click', async (e) => {
  const btn = e.target.closest && e.target.closest('button.plan-action[data-action="view"]');
  if (!btn || state.tab !== 'plans') return;
  try {
    const { plan, estimatedYearly } = await api('GET', `/api/plans/${btn.dataset.id}`);
    flash('success',
      `计划 #${plan.id}「${plan.title}」按自然年预计剂量`,
      `<div class="source-doses">${yearlyText(estimatedYearly)}</div>`);
  } catch (err) { flash('error', err.message); }
});

// ---------- 计划调整申请 ----------
/** 打开发起调整申请的表单（预填原值）。 */
async function openAdjustmentForm(planId) {
  let plan;
  try {
    ({ plan } = await api('GET', `/api/plans/${planId}`));
  } catch (err) {
    flash('error', err.message);
    return;
  }
  if (plan.pendingAdjustment) {
    flash('error', `该计划已有待审调整申请 #${plan.pendingAdjustment.id}，请先撤回后再重新提交`);
    return;
  }
  const box = $('#adjustment-form-box');
  box.classList.remove('hidden');
  const form = $('#adjustment-form');
  form.dataset.planId = planId;
  form.elements.planLabel.value = `#${plan.id} ${plan.title}`;
  form.elements.startDate.value = ymdText(plan.start_date);
  form.elements.endDate.value = ymdText(plan.end_date);
  form.elements.periods.value = (plan.light_periods || []).join('\n');
  form.elements.estimatedLux.value = plan.estimated_lux;
  form.elements.reason.value = '';
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#adjustment-cancel').addEventListener('click', () => {
  $('#adjustment-form-box').classList.add('hidden');
});

$('#adjustment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const planId = Number(form.dataset.planId);
  const periods = String(form.elements.periods.value).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const payload = {
    planId,
    startDate: form.elements.startDate.value,
    endDate: form.elements.endDate.value,
    periods,
    estimatedLux: Number(form.elements.estimatedLux.value),
    reason: form.elements.reason.value || null,
  };
  try {
    const { adjustment } = await api('POST', '/api/adjustments', payload);
    $('#adjustment-form-box').classList.add('hidden');
    const pv = adjustment.preview;
    if (pv && !pv.ok) {
      flash('warn', `调整申请 #${adjustment.id} 已提交（待审），但保管员核对时将发现冲突`,
        adjustmentConflictsHtml(pv));
    } else {
      flash('success', `调整申请 #${adjustment.id} 已提交，等待保管员审核。待审期间原计划继续占用额度`);
    }
    await refreshAfterChange();
  } catch (err) {
    if (err.status === 409 && err.data && err.data.existingAdjustmentId) {
      flash('error', `${err.message}（既有待审申请 #${err.data.existingAdjustmentId}）`);
    } else {
      flash('error', err.message);
    }
  }
});

/** 保管员批准/驳回、布展员撤回调整申请。 */
async function adjustmentAction(btn) {
  const id = Number(btn.dataset.id);
  const action = btn.dataset.action;
  try {
    if (action === 'withdraw') {
      if (!confirm(`撤回调整申请 #${id}？撤回后可重新提交。`)) return;
      await api('POST', `/api/adjustments/${id}/withdraw`);
      flash('success', `调整申请 #${id} 已撤回，可重新提交`);
    } else if (action === 'reject') {
      const reason = prompt('驳回原因（可留空）') || '';
      await api('POST', `/api/adjustments/${id}/reject`, { reason });
      flash('success', `调整申请 #${id} 已驳回，计划不改变`);
    } else if (action === 'approve') {
      try {
        const detail = await api('POST', `/api/adjustments/${id}/approve`);
        if (state.tab === 'exhibits' && state.detail) {
          state.detail = detail;
          renderDetail();
        }
        flash('success', `调整申请 #${id} 已批准，计划已按拟改值更新`);
        await refreshAfterChange();
        return;
      } catch (err) {
        if (err.status === 409 && err.data && err.data.conflicts) {
          flash('error', `调整申请 #${id} 未通过核对（申请保持待审，可撤回后修改重提）`,
            adjustmentConflictsHtml({ conflicts: err.data.conflicts }));
          await refreshAfterChange();
          return;
        }
        throw err;
      }
    }
    await refreshAfterChange();
  } catch (err) {
    flash('error', err.message);
  }
}

// ---------- 成对核准调整申请（保管员，同一展品两份待审申请） ----------
/** 用本展品各计划的待审申请填充两个下拉框，并尽量保留已选项。 */
function renderPairBox() {
  const first = $('#pair-first');
  const second = $('#pair-second');
  if (!first || !second) return;
  const pendings = (state.detail.plans || [])
    .filter((p) => p.pendingAdjustment)
    .map((p) => ({ adj: p.pendingAdjustment, plan: p }))
    .sort((a, b) => a.adj.id - b.adj.id);
  const keep1 = first.value;
  const keep2 = second.value;
  const opts = pendings.map(({ adj, plan }) =>
    `<option value="${adj.id}">申请 #${adj.id} → 计划 #${plan.id}「${esc(plan.title)}」</option>`).join('');
  first.innerHTML = opts || '<option value="">（本展品暂无待审申请）</option>';
  second.innerHTML = opts || '<option value="">（本展品暂无待审申请）</option>';
  if (pendings.some((p) => String(p.adj.id) === keep1)) first.value = keep1;
  if (pendings.some((p) => String(p.adj.id) === keep2)) second.value = keep2;
  // 默认让两个下拉选中不同申请，便于直接试算
  if (first.value === second.value && pendings.length > 1) {
    const other = pendings.find((p) => String(p.adj.id) !== first.value);
    if (other) second.value = String(other.adj.id);
  }
}

/** 成对核对冲突明细（结构与单份不同：状态类为数组、含 pairOverlap、超额含各计划贡献）。 */
function pairConflictsHtml(conflicts) {
  const c = conflicts || {};
  const items = [];
  (c.notApproved || []).forEach((x) =>
    items.push(`计划 #${x.planId} 已不是「已批准」状态（当前：${STATUS_TEXT[x.status] || x.status}）`));
  (c.notStarted || []).forEach((x) => items.push(`计划 #${x.planId} 已经开始`));
  (c.outsideMeasurements || []).forEach((m) =>
    items.push(`计划 #${m.planId} 的未作废实测 #${m.id}（${esc(m.start)} ~ ${esc(m.end)}，${STATUS_TEXT[m.status] || m.status}）不在其新开灯窗内`));
  if (c.pairOverlap) items.push('两份拟改开灯窗彼此重叠');
  (c.overlappingPlans || []).forEach((p) =>
    items.push(`申请 #${p.adjustmentId} 的拟改窗与同展品${p.other.status === 'pending_review' ? '待复核' : '已批准'}计划「${esc(p.other.title)}」(#${p.other.id}) 开灯时间重叠`));
  (c.missingLimits || []).forEach((y) => items.push(`${y} 年尚未登记年度额度`));
  (c.overflows || []).forEach((o) =>
    items.push(`${o.year} 年超额 <b>${fmtN(o.excess)} lx·h</b>（上限 ${fmtN(o.limit)}，其他占用 ${fmtN(o.usedByOthers)}，` +
      `两份拟改残余合计 ${fmtN(o.newResidueTotal)}：${(o.contributions || []).map((ct) => `计划 #${ct.planId} 贡献 ${fmtN(ct.newResidue)}`).join('，')}，` +
      `合计 ${fmtN(o.projected)}）`));
  if (items.length === 0) {
    return '<div class="adj-ok">成对核对通过：两份拟改开灯窗可同时替换原窗。</div>';
  }
  return `<div class="adj-conflict"><b>成对核对未通过：</b><ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul></div>`;
}

/** 成对试算的按年报告表（两计划残余同时替换）。 */
function pairYearlyHtml(yearlyReport) {
  const rows = Object.values(yearlyReport || {});
  if (!rows.length) return '';
  const contrib = (list, key) => (list || []).map((ct) => `#${ct.planId}:${fmtN(ct[key])}`).join(' + ');
  return `<table class="data" style="margin-top:8px"><thead><tr>
      <th>年份</th><th>上限</th><th>其他占用</th><th>两计划原残余</th><th>两计划拟改残余</th><th>替换后合计</th><th>状态</th>
    </tr></thead><tbody>${rows.map((y) => `<tr class="${y.excess ? 'over-row' : ''}">
      <td>${y.year}</td>
      <td class="mono">${y.limit === null ? '未登记' : fmtN(y.limit)}</td>
      <td class="mono">${fmtN(y.usedByOthers)}</td>
      <td class="mono">${fmtN(y.oldResidueTotal)}<div class="small muted">${contrib(y.contributions, 'oldResidue')}</div></td>
      <td class="mono">${fmtN(y.newResidueTotal)}<div class="small muted">${contrib(y.contributions, 'newResidue')}</div></td>
      <td class="mono">${fmtN(y.projected)}</td>
      <td>${y.limit === null ? '<span class="muted">无法核算</span>'
        : y.excess ? `<b style="color:#b42318">超额 ${fmtN(y.excess)}</b>` : '正常'}</td>
    </tr>`).join('')}</tbody></table>`;
}

/** 渲染成对试算/核对结果（stale=true 表示提交被拒后的最新核对）。 */
function renderPairResult(payload, { stale = false } = {}) {
  const box = $('#pair-result');
  const adjHtml = (payload.adjustments || []).map((a) => `<div class="adj-box">
    <div class="adj-head">申请 #${a.id} → 计划 #${a.planId}「${esc((a.original && a.original.title) || '')}」</div>
    ${a.original ? scheduleDiff(a.original, {
      startDate: a.startDate, endDate: a.endDate, periods: a.periods, estimatedLux: a.estimatedLux,
    }) : ''}
  </div>`).join('');
  box.innerHTML =
    (stale ? '<div class="adj-conflict">提交未通过核对，以下为最新核对结果；两份申请仍待审、计划与额度不变。</div>' : '') +
    adjHtml + pairConflictsHtml(payload.conflicts) + pairYearlyHtml(payload.yearlyReport);
}

/** 读取两个下拉框选中的申请编号；无效时提示并返回 null。 */
function selectedPairIds() {
  const ids = [Number($('#pair-first').value), Number($('#pair-second').value)];
  if (!ids.every((x) => Number.isInteger(x) && x > 0)) {
    flash('error', '本展品暂无可选的待审调整申请');
    return null;
  }
  if (ids[0] === ids[1]) {
    flash('error', '请选择两份不同的待审调整申请');
    return null;
  }
  return ids;
}

$('#pair-preview-btn').addEventListener('click', async () => {
  const ids = selectedPairIds();
  if (!ids) return;
  try {
    const { pairPreview } = await api('POST', '/api/adjustments/pair/preview', { adjustmentIds: ids });
    renderPairResult(pairPreview);
    flash(pairPreview.ok ? 'success' : 'warn',
      pairPreview.ok ? '成对试算通过：可提交核准' : '成对试算存在冲突，见下方明细');
  } catch (err) { flash('error', err.message); }
});

$('#pair-approve-btn').addEventListener('click', async () => {
  const ids = selectedPairIds();
  if (!ids) return;
  if (!confirm(`确认成对核准申请 #${ids[0]} 与 #${ids[1]}？两条计划将同时按拟改值更新。`)) return;
  try {
    const detail = await api('POST', '/api/adjustments/pair/approve', { adjustmentIds: ids });
    state.detail = detail;
    renderDetail();
    $('#pair-result').innerHTML = '';
    flash('success', `成对核准完成：申请 #${ids[0]}、#${ids[1]} 已通过，两条计划已同时更新`);
  } catch (err) {
    if (err.status === 409 && err.data && err.data.details && err.data.details.conflicts) {
      renderPairResult({
        adjustments: [],
        conflicts: err.data.details.conflicts,
        yearlyReport: err.data.details.yearlyReport,
      }, { stale: true });
      flash('error', '成对核准未通过核对，两份申请仍待审、计划与额度不变');
      await refreshAfterChange();
    } else {
      flash('error', err.message);
    }
  }
});

// ---------- 实测 ----------
async function loadMeasurementsTab() {
  await populateExhibitSelects();
  const { measurements } = await api('GET', '/api/measurements');
  state.measurements = measurements;
  $('#meas-list').innerHTML = measurements.length
    ? `<table class="data"><thead><tr>
        <th>#</th><th>计划</th><th>开始</th><th>结束</th><th>实测照度</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>${measurements.map((m) => `
          <tr>
            <td>${m.id}</td><td>#${m.planId}</td>
            <td>${esc(m.start)}</td><td>${esc(m.end)}</td>
            <td class="mono">${fmtN(m.actualLux)} lx</td>
            <td>${badge(m.status)}</td>
            <td>${m.status === 'draft' && state.user.role === 'conservator'
              ? `<button class="primary small-btn meas-action" data-action="confirm" data-id="${m.id}">确认</button>
                 <button class="danger small-btn meas-action" data-action="delete" data-id="${m.id}">删除</button>`
              : '<span class="muted">—</span>'}</td>
          </tr>`).join('')}</tbody></table>`
    : '<p class="muted">暂无实测记录。</p>';
  $$('.meas-action').forEach((b) => b.addEventListener('click', () => measAction(b)));
}

$('#meas-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('POST', '/api/measurements', {
      planId: Number(fd.get('planId')),
      startDate: fd.get('startDate'),
      startTime: fd.get('startTime'),
      endDate: fd.get('endDate') || fd.get('startDate'),
      endTime: fd.get('endTime'),
      actualLux: Number(fd.get('actualLux')),
      note: fd.get('note'),
    });
    e.target.reset();
    await loadMeasurementsTab();
    flash('success', '实测已录入（待确认）');
  } catch (err) { flash('error', err.message); }
});

// ---------- 账号 ----------
async function loadUsers() {
  const { users } = await api('GET', '/api/users');
  state.users = users;
  $('#user-tbody').innerHTML = users.map((u) => `<tr>
    <td>${u.id}</td><td>${esc(u.username)}</td><td>${esc(u.display_name)}</td>
    <td>${u.role === 'conservator' ? '保管员' : '布展员'}</td>
    <td>${u.active ? '启用' : '<span style="color:#b42318">停用</span>'}</td>
    <td>
      <button class="small-btn user-action" data-action="password" data-id="${u.id}">重置密码</button>
      <button class="small-btn user-action" data-action="active" data-id="${u.id}" data-active="${!u.active}">${u.active ? '停用' : '启用'}</button>
    </td></tr>`).join('');
  $$('.user-action').forEach((b) => b.addEventListener('click', async () => {
    try {
      if (b.dataset.action === 'password') {
        const pw = prompt(`为 ${state.users.find((u) => u.id == b.dataset.id).username} 设置新密码（≥6位）`);
        if (!pw) return;
        await api('POST', `/api/users/${b.dataset.id}/reset-password`, { password: pw });
        flash('success', '密码已重置');
      } else {
        await api('POST', `/api/users/${b.dataset.id}/active`, { active: b.dataset.active === 'true' });
        await loadUsers();
      }
    } catch (err) { flash('error', err.message); }
  }));
}
$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('POST', '/api/users', {
      username: fd.get('username').trim(),
      displayName: fd.get('displayName') || fd.get('username'),
      role: fd.get('role'),
      password: fd.get('password'),
    });
    e.target.reset();
    await loadUsers();
    flash('success', '账号已创建');
  } catch (err) { flash('error', err.message); }
});

// ---------- 操作流水 ----------
async function loadAudit() {
  const { events } = await api('GET', '/api/audit?limit=300');
  $('#audit-tbody').innerHTML = events.map((ev) => `<tr>
    <td>${ev.id}</td>
    <td class="mono">${new Date(ev.created_at).toLocaleString('zh-CN')}</td>
    <td>${esc(ev.actor_name || '系统')}</td>
    <td>${esc(ev.action)}</td>
    <td>${esc(ev.target_type)}${ev.target_id ? ' #' + ev.target_id : ''}</td>
    <td class="small">${esc(JSON.stringify(ev.detail))}</td>
  </tr>`).join('');
}

boot().catch((err) => {
  document.body.innerHTML = `<pre style="padding:20px;color:#b42318">初始化失败: ${esc(err.message)}</pre>`;
});
