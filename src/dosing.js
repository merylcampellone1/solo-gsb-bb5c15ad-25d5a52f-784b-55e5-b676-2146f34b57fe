'use strict';

const config = require('./config');
const { ValidationError } = require('./validation');

/** 剂量统一保留 3 位小数（lx·h）。 */
function round3(n) {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

/** 墙上时间（本地日历日 + 当日分钟数）-> UTC 毫秒时间戳。 */
function wallToTs(ymd, minuteOfDay) {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  return Date.UTC(y, m - 1, d) + minuteOfDay * 60000 - config.tzOffsetMs;
}

/** UTC 毫秒时间戳 -> 墙上时间 { ymd, minute }。 */
function tsToWall(ms) {
  const shifted = new Date(ms + config.tzOffsetMs);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  const ymd = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { ymd, minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

function yearOfTs(ms) {
  return new Date(ms + config.tzOffsetMs).getUTCFullYear();
}

/** 墙上时间戳 -> 'YYYY-MM-DD HH:MM'（供页面展示）。 */
function tsToWallString(ms) {
  const { ymd, minute } = tsToWall(ms);
  const hh = String(Math.floor(minute / 60)).padStart(2, '0');
  const mm = String(minute % 60).padStart(2, '0');
  return `${ymd} ${hh}:${mm}`;
}

/** 枚举起止日内的所有日期（含首尾）。 */
function enumerateDates(startYmd, endYmd) {
  const sy = Number(startYmd.slice(0, 4));
  const sm = Number(startYmd.slice(5, 7));
  const sd = Number(startYmd.slice(8, 10));
  const ey = Number(endYmd.slice(0, 4));
  const em = Number(endYmd.slice(5, 7));
  const ed = Number(endYmd.slice(8, 10));
  const out = [];
  let cur = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  if (end < cur) throw new ValidationError('结束日期不能早于开始日期');
  while (cur <= end) {
    const dt = new Date(cur);
    out.push(
      `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(
        dt.getUTCDate()
      ).padStart(2, '0')}`
    );
    cur += 24 * 3600 * 1000;
  }
  return out;
}

/**
 * 生成计划的开灯时间窗（毫秒区间，左闭右开），并合并相交区间。
 * periods: parsePeriods 的结果 [{ startMin, durationMin }]
 */
function buildWindows(startYmd, endYmd, periods) {
  const dates = enumerateDates(startYmd, endYmd);
  const windows = [];
  for (const ymd of dates) {
    for (const p of periods) {
      const start = wallToTs(ymd, p.startMin);
      windows.push({ start, end: start + p.durationMin * 60000 });
    }
  }
  windows.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
    } else {
      merged.push({ start: w.start, end: w.end });
    }
  }
  return merged;
}

/** 两个 [start,end) 区间是否相交。 */
function intersects(a, b) {
  return a.start < b.end && b.start < a.end;
}

/** outer 是否完整包含 inner（端点可重合）。 */
function containsInterval(outer, inner) {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** 任一区间对是否相交。 */
function anyIntersect(windowsA, windowsB) {
  for (const a of windowsA) {
    for (const b of windowsB) {
      if (intersects(a, b)) return true;
    }
  }
  return false;
}

/**
 * 取 hole 与一组外层区间 windows 的相交部分（已合并，左闭右开）。
 * 用于计算停灯时段落在计划开灯窗内（且未被已确认实测覆盖）的有效部分。
 */
function clipIntervalToWindows(hole, windows) {
  const parts = [];
  for (const w of windows) {
    if (!intersects(w, hole)) continue;
    parts.push({ start: Math.max(w.start, hole.start), end: Math.min(w.end, hole.end) });
  }
  parts.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (last && p.start <= last.end) last.end = Math.max(last.end, p.end);
    else merged.push(p);
  }
  return merged.filter((p) => p.end > p.start);
}

/**
 * 把时间窗按墙上自然年切分，返回 Map<year, 分钟数>。
 * 年界（本地 1 月 1 日 00:00）= Date.UTC(y,0,1) - offset。
 */
function splitMinutesByYear(windows) {
  const byYear = new Map();
  const add = (year, minutes) => byYear.set(year, (byYear.get(year) || 0) + minutes);

  for (const w of windows) {
    let cur = w.start;
    while (cur < w.end) {
      const year = yearOfTs(cur);
      const boundary = Date.UTC(year + 1, 0, 1) - config.tzOffsetMs;
      const segEnd = Math.min(w.end, boundary);
      add(year, (segEnd - cur) / 60000);
      cur = segEnd;
    }
  }
  return byYear;
}

/**
 * 按自然年拆分预计/实测剂量（单位 lx·h）。
 * windows: [{start,end}]；lux: 照度（lx）
 * 返回 Map<year, dose>（已 round3）
 */
function doseByYear(windows, lux) {
  const minutes = splitMinutesByYear(windows);
  const out = new Map();
  for (const [year, mins] of minutes) {
    out.set(year, round3((mins / 60) * lux));
  }
  return out;
}

/** 从时间轴 base 中扣除 covered 列表覆盖的部分，返回剩余区间（已合并）。 */
function subtractIntervals(base, covered) {
  let pieces = Array.isArray(base) ? base.map((w) => ({ ...w })) : [{ ...base }];
  for (const hole of covered) {
    const next = [];
    for (const p of pieces) {
      if (!intersects(p, hole)) {
        next.push(p);
      } else {
        if (p.start < hole.start) next.push({ start: p.start, end: hole.start });
        if (hole.end < p.end) next.push({ start: hole.end, end: p.end });
      }
    }
    pieces = next;
  }
  pieces.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const w of pieces) {
    if (w.end <= w.start) continue;
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else merged.push(w);
  }
  return merged;
}

/** 把 Map<year,n> 转成普通对象（JSON 友好），键为字符串年份。 */
function yearMapToObject(map) {
  const obj = {};
  for (const [year, v] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
    obj[String(year)] = round3(v);
  }
  return obj;
}

/** 两个年度剂量对象相加。 */
function addYearDose(acc, other) {
  for (const [year, dose] of Object.entries(other || {})) {
    acc[year] = round3((acc[year] || 0) + Number(dose));
  }
  return acc;
}

module.exports = {
  round3,
  wallToTs,
  tsToWall,
  tsToWallString,
  yearOfTs,
  enumerateDates,
  buildWindows,
  intersects,
  containsInterval,
  anyIntersect,
  clipIntervalToWindows,
  splitMinutesByYear,
  doseByYear,
  subtractIntervals,
  yearMapToObject,
  addYearDose,
};
