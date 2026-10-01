'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('./db');
const { AuthError } = require('./validation');

const COOKIE_NAME = 'lqsession';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 小时

// 进程内会话表（单实例部署足够；重启需重新登录）。
const sessions = new Map();

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    userId: user.id,
    username: user.username,
    role: user.role,
    displayName: user.display_name,
    createdAt: Date.now(),
  });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return s;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_TTL_MS,
};

function loadUser(req, _res, next) {
  const token = req.cookies[COOKIE_NAME];
  req.sessionUser = getSession(token) || null;
  req.sessionToken = token || null;
  next();
}

function requireAuth(req, _res, next) {
  if (!req.sessionUser) return next(new AuthError('未登录或会话已过期'));
  next();
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.sessionUser) return next(new AuthError('未登录或会话已过期'));
    if (!roles.includes(req.sessionUser.role)) {
      return next(new AuthError('当前账号无权执行此操作', 403));
    }
    next();
  };
}

async function verifyLogin(username, password) {
  const { rows } = await query(
    'SELECT id, username, password_hash, role, display_name, active FROM users WHERE username = $1',
    [username]
  );
  const user = rows[0];
  if (!user || !user.active) throw new AuthError('用户名或密码错误');
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw new AuthError('用户名或密码错误');
  return user;
}

module.exports = {
  COOKIE_NAME,
  sessionCookieOptions,
  createSession,
  getSession,
  destroySession,
  loadUser,
  requireAuth,
  requireRole,
  verifyLogin,
};
