'use strict';

const { Pool } = require('pg');
const pgTypes = require('pg').types;
const config = require('./config');

// DATE 列以 'YYYY-MM-DD' 字符串返回，避免被驱动按 UTC 转成 Date 后日期漂移。
pgTypes.setTypeParser(1082, (v) => v);
// NUMERIC 直接转为 JS number；本系统数值范围小，精度足够。
pgTypes.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const pool = new Pool({
  host: config.pg.host,
  port: config.pg.port,
  database: config.pg.database,
  user: config.pg.user,
  password: config.pg.password,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // 空闲连接出错，仅记录，避免进程崩溃。
  console.error('[pg] 空闲连接错误:', err.message);
});

/**
 * 进程内键级互斥队列：同一 key 的临界区严格串行。
 * 用途：与 PostgreSQL 的 SELECT ... FOR UPDATE 行锁互为双保险，
 * 保证单实例内对同一展品的并发批准/确认不会超配（无论底层驱动是否支持阻塞行锁）。
 * 实现：每个 key 维护一个 Promise 链尾，后来者先排队等待，结束后摘下自己。
 */
const lockTails = new Map();
async function withKeyLock(key, work) {
  const prev = lockTails.get(key);
  let release;
  const mine = new Promise((resolve) => {
    release = resolve;
  });
  // 新链尾：前序结束（无论成败）后再等 mine 释放
  const queued = (prev || Promise.resolve()).then(
    () => mine,
    () => mine
  );
  lockTails.set(key, queued);
  if (prev) {
    try {
      await prev;
    } catch (_) {
      /* 前序失败不阻塞队列 */
    }
  }
  try {
    return await work();
  } finally {
    release();
    // 微任务后若链尾没有变化（没有后来者替换它），回收该 key
    const current = queued;
    queueMicrotask(() => {
      if (lockTails.get(key) === current) lockTails.delete(key);
    });
  }
}

/**
 * 在事务中执行 work(client)；work 抛错则回滚，否则提交。
 * 行级锁（SELECT ... FOR UPDATE）必须在此处获取。
 */
async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[pg] 回滚失败:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** 以“展品行”为粒度的串行化事务：应用层互斥 + DB 行锁双保险。 */
async function withExhibitTransaction(exhibitId, work) {
  return withKeyLock(`exhibit:${exhibitId}`, () => withTransaction(work));
}

/**
 * 多展品串行化事务（联合核准等跨展品批量操作）：
 *  - 应用层：按展品 id 升序依次获取键级互斥锁，全部持有时才开启单一事务，
 *    避免与其他批量/单项事务形成等待环（后到者按相同顺序排队）；
 *  - 事务内：调用方同样按 id 升序执行 SELECT ... FOR UPDATE。
 * 同一请求内重复的展品 id 只取一次锁。
 */
function withMultiExhibitTransaction(exhibitIds, work) {
  const ids = [...new Set(exhibitIds.map(Number))].sort((a, b) => a - b);
  const run = (idx) => {
    if (idx >= ids.length) return withTransaction(work);
    return withKeyLock(`exhibit:${ids[idx]}`, () => run(idx + 1));
  };
  return run(0);
}

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query, withTransaction, withKeyLock, withExhibitTransaction, withMultiExhibitTransaction };
