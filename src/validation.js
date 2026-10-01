'use strict';

/** 400 类业务校验错误，message 直接展示给用户。 */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

/** 409 冲突（重叠、超限等），details 可携带结构化超额信息。 */
class ConflictError extends Error {
  constructor(message, details = null) {
    super(message);
    this.statusCode = 409;
    this.details = details;
  }
}

/** 401/403 */
class AuthError extends Error {
  constructor(message, statusCode = 401) {
    super(message);
    this.statusCode = statusCode;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(?::00)?$/;

function isValidYmd(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1900 || y > 2999) return false;
  const days = new Date(Date.UTC(y, m - 1, d)).getUTCDate();
  return days === d;
}

/** 将 HH:MM 或 HH:MM:00 解析为当日分钟数（0..1439）。 */
function parseTimeToMinutes(s) {
  if (typeof s !== 'string' || !TIME_RE.test(s)) {
    throw new ValidationError(`时间格式无效：${s}（应为 HH:MM）`);
  }
  const h = Number(s.slice(0, 2));
  const min = Number(s.slice(3, 5));
  if (h > 23 || min > 59) throw new ValidationError(`时间超出范围：${s}`);
  return h * 60 + min;
}

/**
 * 解析一个开灯时段（HH:MM-HH:MM）。
 * 支持跨午夜（如 09:00-21:00、20:00-02:00）；
 * 起止相同视为零时长，拒绝（非正开灯时间）。
 * 返回 { startMin, durationMin }，跨午夜时 duration 可能 > 1440-...（最大 1439）。
 */
function parsePeriod(spec) {
  if (typeof spec !== 'string') throw new ValidationError('开灯时段格式无效');
  const parts = spec.trim().split('-');
  if (parts.length !== 2) {
    throw new ValidationError(`开灯时段格式无效：${spec}（应为 HH:MM-HH:MM）`);
  }
  const startMin = parseTimeToMinutes(parts[0].trim());
  const endMin = parseTimeToMinutes(parts[1].trim());
  if (startMin === endMin) {
    throw new ValidationError(`开灯时段时长为零：${spec}`);
  }
  let durationMin = endMin - startMin;
  if (durationMin < 0) durationMin += 24 * 60; // 跨午夜
  return { startMin, durationMin };
}

/** 校验每日开灯时段列表：格式、时长、同日时段互不重叠。 */
function parsePeriods(rawPeriods) {
  if (!Array.isArray(rawPeriods) || rawPeriods.length === 0) {
    throw new ValidationError('每日开灯时段不能为空');
  }
  const parsed = rawPeriods.map((p) => parsePeriod(p));

  // 展开到一条 48 小时时间轴上检查同日重叠：
  // 每个时段放两份（次日偏移 1440），凡有重叠即非法（跨午夜时段会与同日早晚时段相撞）。
  const intervals = [];
  for (const p of parsed) {
    intervals.push([p.startMin, p.startMin + p.durationMin]);
    intervals.push([p.startMin + 1440, p.startMin + p.durationMin + 1440]);
  }
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i][0] < intervals[i - 1][1] && intervals[i][1] > intervals[i - 1][0]) {
      throw new ValidationError('同一日的开灯时段相互重叠');
    }
  }
  return parsed;
}

function positiveNumber(value, field, { integer = false, max } = {}) {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) {
    throw new ValidationError(`${field}必须是数字`);
  }
  if (integer && !Number.isInteger(n)) throw new ValidationError(`${field}必须是整数`);
  if (n <= 0) throw new ValidationError(`${field}必须为正数`);
  if (max !== undefined && n > max) throw new ValidationError(`${field}不能大于 ${max}`);
  return n;
}

function nonEmptyString(value, field, max = 200) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field}不能为空`);
  }
  const v = value.trim();
  if (v.length > max) throw new ValidationError(`${field}长度不能超过 ${max} 个字符`);
  return v;
}

function assertDate(s, field) {
  if (!isValidYmd(s)) throw new ValidationError(`${field}无效：${s}（应为 YYYY-MM-DD）`);
  return s;
}

module.exports = {
  ValidationError,
  ConflictError,
  AuthError,
  isValidYmd,
  parseTimeToMinutes,
  parsePeriod,
  parsePeriods,
  positiveNumber,
  nonEmptyString,
  assertDate,
};
