'use strict';

const config = require('./config');
const { createApp } = require('./app');
const { initializeDatabase } = require('./init');
const { pool } = require('./db');

async function main() {
  console.log('[start] 正在初始化数据库（建表、初始账号、演示数据）...');
  await initializeDatabase();
  console.log('[start] 数据库初始化完成');

  const app = createApp();
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[start] 纸质展品光照额度管理已启动: http://localhost:${config.port}`);
  });

  const shutdown = async (signal) => {
    console.log(`[stop] 收到 ${signal}，正在关闭...`);
    server.close(() => process.exit(0));
    await pool.end().catch(() => {});
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[fatal] 启动失败:', err);
  process.exit(1);
});
