'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../db');
const { requireRole } = require('../auth');
const { recordAudit } = require('../audit');
const { ValidationError, ConflictError, nonEmptyString } = require('../validation');

const router = express.Router();

// 仅保管员可管理本地账号
router.use(requireRole('conservator'));

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, username, role, display_name, active, created_at
         FROM users ORDER BY id`
    );
    res.json({ users: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const username = nonEmptyString(req.body.username, '用户名', 100);
    const password = nonEmptyString(req.body.password, '密码', 200);
    if (password.length < 6) throw new ValidationError('密码长度至少 6 位');
    const role = req.body.role;
    if (!['conservator', 'installer'].includes(role)) {
      throw new ValidationError('角色必须是 conservator 或 installer');
    }
    const displayName = nonEmptyString(req.body.displayName || username, '显示名称', 100);

    try {
      const { rows } = await withTransaction(async (client) => {
        const inserted = await client.query(
          `INSERT INTO users (username, password_hash, role, display_name)
           VALUES ($1, $2, $3, $4) RETURNING id, username, role, display_name, active, created_at`,
          [username, await bcrypt.hash(password, 10), role, displayName]
        );
        await recordAudit(client, req.sessionUser, 'user.create', 'user', inserted.rows[0].id, {
          username,
          role,
        });
        return inserted;
      });
      res.status(201).json({ user: rows[0] });
    } catch (err) {
      if (err.code === '23505') throw new ConflictError('用户名已存在');
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reset-password', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const password = nonEmptyString(req.body.password, '新密码', 200);
    if (password.length < 6) throw new ValidationError('密码长度至少 6 位');
    const { rowCount } = await query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [await bcrypt.hash(password, 10), id]
    );
    if (rowCount === 0) throw new ValidationError('用户不存在');
    await recordAudit({ query }, req.sessionUser, 'user.reset_password', 'user', id, {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/active', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const active = Boolean(req.body.active);
    if (id === req.sessionUser.userId && !active) {
      throw new ValidationError('不能停用当前登录账号');
    }
    const { rows } = await query(
      'UPDATE users SET active = $1 WHERE id = $2 RETURNING id, username, role, display_name, active, created_at',
      [active, id]
    );
    if (rows.length === 0) throw new ValidationError('用户不存在');
    await recordAudit({ query }, req.sessionUser, 'user.set_active', 'user', id, { active });
    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
