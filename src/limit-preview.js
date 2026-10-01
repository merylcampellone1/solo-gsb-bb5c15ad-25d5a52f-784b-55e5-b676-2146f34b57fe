'use strict';

/*
 * 下调年度上限的「预演凭证」存储：
 *  - 预演（POST /api/exhibits/:id/limits/preview）不改任何状态，只发放一次性凭证；
 *  - 携凭证提交（POST /api/exhibits/:id/limits/lower）时，在同一展品锁事务内重算，
 *    若重算指纹与凭证签发时不一致（上限/实测/占用计划等已变化），拒绝并返回最新结果（含新凭证）。
 * 单实例部署使用进程内 Map（与会话表同样的口径）；凭证默认 10 分钟有效、一次性。
 */

const crypto = require('crypto');
const { ValidationError } = require('./validation');

const TOKEN_TTL_MS = 10 * 60 * 1000;

// token -> { userId, exhibitId, year, proposedLimit, fingerprint, expiresAt }
const vouchers = new Map();

function purgeExpired(nowMs = Date.now()) {
  for (const [token, v] of vouchers) {
    if (v.expiresAt <= nowMs) vouchers.delete(token);
  }
}

/** 稳定序列化（对象键排序），保证同一内容指纹一致。 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

/**
 * 根据当前占用快照生成指纹。指纹覆盖：该年既有上限、全部未作废实测（含草稿，
 * 草稿会影响重叠校验）、全部已批准/待复核计划的状态/计划字段/在该年的估算残余、
 * 全部停灯记录及其按年扣减量。
 * 计划是否“已开始”只在跨越各自首次开灯时刻时才变化，调用方把此刻已开始的计划 id
 * 列表（startedPlanIds）放入快照即可完整表达该时间相关状态，避免直接比较毫秒时间戳。
 */
function fingerprintSnapshot(snapshot) {
  const payload = {
    currentLimit: snapshot.currentLimit,
    measurements: snapshot.measurements,
    plans: snapshot.plans,
    blackouts: snapshot.blackouts || [],
    startedPlanIds: snapshot.startedPlanIds,
  };
  return crypto.createHash('sha256').update(canonicalize(payload)).digest('hex');
}

/** 签发预演凭证，返回 token。 */
function issueVoucher({ userId, exhibitId, year, proposedLimit, fingerprint }, nowMs = Date.now()) {
  purgeExpired(nowMs);
  const token = crypto.randomBytes(24).toString('hex');
  vouchers.set(token, {
    userId: userId || null,
    exhibitId,
    year,
    proposedLimit,
    fingerprint,
    expiresAt: nowMs + TOKEN_TTL_MS,
  });
  return token;
}

/**
 * 取出并消耗（删除）凭证。不存在/过期返回 null；
 * 字段（展品/年份/拟改上限/用户）不匹配抛 400，避免张冠李戴。
 */
function consumeVoucher(token, { userId, exhibitId, year, proposedLimit }, nowMs = Date.now()) {
  const v = peekVoucher(token, { userId, exhibitId, year, proposedLimit }, nowMs);
  vouchers.delete(token);
  return v;
}

/**
 * 只读校验凭证（不消耗）。与 consumeVoucher 同样的字段/归属/过期校验。
 * 用于先判定“状态是否变化”再决定消耗，避免把一次性凭证浪费在必然被拒的提交上。
 */
function peekVoucher(token, { userId, exhibitId, year, proposedLimit }, nowMs = Date.now()) {
  if (typeof token !== 'string' || !token) {
    throw new ValidationError('缺少预演凭证：请先对该展品该年度的下调进行预演');
  }
  const v = vouchers.get(token);
  if (!v) {
    throw new ValidationError('预演凭证已使用或不存在，请重新预演后再提交');
  }
  if (v.expiresAt <= nowMs) {
    vouchers.delete(token);
    throw new ValidationError('预演凭证已过期，请重新预演后再提交');
  }
  if (
    v.exhibitId !== exhibitId ||
    v.year !== year ||
    Number(v.proposedLimit) !== Number(proposedLimit)
  ) {
    throw new ValidationError('预演凭证与本次提交的展品/年份/拟定上限不一致，请重新预演');
  }
  if (v.userId !== null && userId !== null && Number(v.userId) !== Number(userId)) {
    throw new ValidationError('预演凭证不属于当前登录账号，请用本账号重新预演');
  }
  return v;
}

/** 仅供测试：清空凭证。 */
function clearVouchers() {
  vouchers.clear();
}

module.exports = {
  TOKEN_TTL_MS,
  canonicalize,
  fingerprintSnapshot,
  issueVoucher,
  peekVoucher,
  consumeVoucher,
  clearVouchers,
};
