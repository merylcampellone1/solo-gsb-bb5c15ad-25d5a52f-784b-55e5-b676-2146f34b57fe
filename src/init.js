'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const config = require('./config');
const { buildWindows, doseByYear, yearMapToObject } = require('./dosing');
const { parsePeriods } = require('./validation');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDatabase(retries = 30) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      console.log(`[init] 等待数据库就绪（${attempt}/${retries}）: ${err.message}`);
      if (attempt === retries) throw err;
      await sleep(2000);
    }
  }
}

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

async function ensureUser(username, password, role, displayName, client = pool) {
  const { rows } = await client.query('SELECT id FROM users WHERE username = $1', [username]);
  if (rows.length > 0) return rows[0].id;
  const passwordHash = await bcrypt.hash(password, 10);
  const inserted = await client.query(
    `INSERT INTO users (username, password_hash, role, display_name)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [username, passwordHash, role, displayName]
  );
  console.log(`[init] 已创建${role === 'conservator' ? '保管员' : '布展员'}账号: ${username}`);
  return inserted.rows[0].id;
}

async function ensureDemo(conservatorId) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM exhibits');
  if (rows[0].n > 0) return;

  const { id: exhibitId } = (
    await pool.query(
      `INSERT INTO exhibits (name, accession_no, medium, note, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      ['宋拓《兰亭序》册页', 'DEMO-001', '纸本墨拓', '演示数据：对光敏感的纸质拓本', conservatorId]
    )
  ).rows[0];

  for (const [year, limitLxh] of [
    [2025, 50000],
    [2026, 50000],
    [2027, 50000],
  ]) {
    await pool.query(
      `INSERT INTO annual_limits (exhibit_id, year, limit_lxh, created_by)
       VALUES ($1, $2, $3, $4)`,
      [exhibitId, year, limitLxh, conservatorId]
    );
  }

  // 一个跨年演示计划：2026-12-28 至 2027-01-05，每天 09:00-17:00，120 lx
  const periods = ['09:00-17:00'];
  const windows = buildWindows('2026-12-28', '2027-01-05', parsePeriods(periods));
  const yearly = yearMapToObject(doseByYear(windows, 120));
  await pool.query(
    `INSERT INTO plans
       (exhibit_id, title, start_date, end_date, light_periods, estimated_lux,
        status, created_by, approved_by, approved_at, review_reason)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'approved', $7, $7, now(), $8)`,
    [
      exhibitId,
      '跨年特展（演示）',
      '2026-12-28',
      '2027-01-05',
      JSON.stringify(periods),
      120,
      conservatorId,
      `演示计划，批准时预计剂量：${JSON.stringify(yearly)} lx·h`,
    ]
  );
  console.log('[init] 已写入演示展品与一条已批准跨年计划');
}

async function initializeDatabase() {
  await waitForDatabase();
  await ensureSchema();
  await ensureUser(config.seed.conservatorUsername, config.seed.conservatorPassword,
    'conservator', '保管员（默认）');
  await ensureUser(config.seed.installerUsername, config.seed.installerPassword,
    'installer', '布展员（默认）');
  if (config.seed.demo) {
    const custodianRow = await pool.query('SELECT id FROM users WHERE username = $1',
      [config.seed.conservatorUsername]);
    await ensureDemo(custodianRow.rows[0].id);
  }
}

module.exports = { initializeDatabase };
