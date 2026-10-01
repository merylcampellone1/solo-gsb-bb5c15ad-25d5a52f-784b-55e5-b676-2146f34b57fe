'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { loadUser } = require('./auth');
const { ValidationError, ConflictError, AuthError } = require('./validation');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const exhibitRoutes = require('./routes/exhibits');
const planRoutes = require('./routes/plans');
const adjustmentRoutes = require('./routes/adjustments');
const measurementRoutes = require('./routes/measurements');
const blackoutRoutes = require('./routes/blackouts');
const auditRoutes = require('./routes/audit');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(loadUser);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/exhibits', exhibitRoutes.router);
  app.use('/api/plans', planRoutes);
  app.use('/api/adjustments', adjustmentRoutes);
  app.use('/api/measurements', measurementRoutes);
  app.use('/api/blackouts', blackoutRoutes.router);
  app.use('/api/audit', auditRoutes);

  // JSON 解析错误
  app.use('/api', (err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: '请求体不是合法 JSON' });
    }
    next(err);
  });

  // 统一错误响应
  // eslint-disable-next-line no-unused-vars
  app.use('/api', (err, req, res, next) => {
    const status = err.statusCode || 500;
    if (status >= 500) console.error('[error]', err);
    res.status(status).json({
      error: err.message || '服务器内部错误',
      ...(err.details ? { details: err.details } : {}),
    });
  });

  // 前端静态资源
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  return app;
}

module.exports = { createApp };
