'use strict';

require('dotenv').config();

function intEnv(name, def, { min, max } = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? def : Number(raw);
  if (!Number.isInteger(value)) throw new Error(`环境变量 ${name} 必须是整数`);
  if (min !== undefined && value < min) throw new Error(`环境变量 ${name} 不能小于 ${min}`);
  if (max !== undefined && value > max) throw new Error(`环境变量 ${name} 不能大于 ${max}`);
  return value;
}

const config = {
  port: intEnv('PORT', 3000, { min: 1, max: 65535 }),
  pg: {
    host: process.env.PGHOST || 'db',
    port: intEnv('PGPORT', 5432, { min: 1, max: 65535 }),
    database: process.env.PGDATABASE || 'lightquota',
    user: process.env.PGUSER || 'lightquota',
    password: process.env.PGPASSWORD || 'lightquota_secret',
  },
  // 固定 UTC 偏移（分钟）。默认 +08:00；不处理夏令时，符合国内布展场景。
  tzOffsetMinutes: intEnv('TZ_OFFSET_MINUTES', 480, { min: -720, max: 840 }),
  seed: {
    conservatorUsername: process.env.SEED_CONSERVATOR_USERNAME || 'custodian',
    conservatorPassword: process.env.SEED_CONSERVATOR_PASSWORD || 'guard123',
    installerUsername: process.env.SEED_INSTALLER_USERNAME || 'installer',
    installerPassword: process.env.SEED_INSTALLER_PASSWORD || 'setup123',
    demo: (process.env.SEED_DEMO || 'true').toLowerCase() !== 'false',
  },
};

config.tzOffsetMs = config.tzOffsetMinutes * 60 * 1000;

module.exports = config;
