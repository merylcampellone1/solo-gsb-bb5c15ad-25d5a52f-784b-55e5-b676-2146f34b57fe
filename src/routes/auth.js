'use strict';

const express = require('express');
const { query } = require('../db');
const {
  COOKIE_NAME,
  sessionCookieOptions,
  createSession,
  destroySession,
  verifyLogin,
  requireAuth,
} = require('../auth');
const { recordAudit } = require('../audit');
const { nonEmptyString, ValidationError } = require('../validation');

const router = express.Router();

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, displayName: u.display_name || u.displayName };
}

router.post('/login', async (req, res, next) => {
  try {
    const username = nonEmptyString(req.body && req.body.username, '用户名', 100);
    const password = req.body && req.body.password;
    if (typeof password !== 'string' || password === '') {
      throw new ValidationError('密码不能为空');
    }
    const user = await verifyLogin(username, password);
    const token = createSession(user);
    res.cookie(COOKIE_NAME, token, sessionCookieOptions);
    await recordAudit({ query }, { userId: user.id, username: user.username }, 'login', 'user', user.id, {});
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAuth, (req, res) => {
  destroySession(req.sessionToken);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.sessionUser) return res.json({ user: null });
  res.json({ user: req.sessionUser });
});

module.exports = router;
