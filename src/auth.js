'use strict';
// Phiên đăng nhập (cookie httpOnly + bảng sessions) và các hàm kiểm tra quyền
const crypto = require('crypto');
const { TEAMS } = require('./db');

const COOKIE = 'sid';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 giờ

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(db, res, userId, secure) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, Date.now() + SESSION_TTL_MS);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: !!secure, maxAge: SESSION_TTL_MS, path: '/' });
}

function destroySession(db, req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie(COOKIE, { path: '/' });
}

/** Gắn req.user nếu phiên hợp lệ và tài khoản đang hoạt động */
function loadUser(db) {
  const q = db.prepare(
    `SELECT u.id, u.username, u.full_name, u.role, u.team, u.status, u.manager_teams
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?`
  );
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.user = null;
    if (token) {
      const u = q.get(token, Date.now());
      if (u && u.status === 'active') req.user = { ...u };
    }
    next();
  };
}

function requireLogin(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Bạn cần đăng nhập.'));
  next();
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Bạn cần đăng nhập.'));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, 'Bạn không có quyền thực hiện thao tác này.'));
    next();
  };
}

/** Danh sách nhóm mà user được xem báo cáo tổng hợp */
function viewableTeams(user) {
  if (!user) return [];
  if (user.role === 'admin') return [...TEAMS];
  if (user.role !== 'manager') return [];
  if (user.manager_teams === 'ALL') return [...TEAMS];
  return String(user.manager_teams || '')
    .split('|')
    .filter((t) => TEAMS.includes(t));
}

function canManageTeam(user, team) {
  return viewableTeams(user).includes(team);
}

module.exports = {
  HttpError,
  createSession,
  destroySession,
  loadUser,
  requireLogin,
  requireRole,
  viewableTeams,
  canManageTeam,
  SESSION_TTL_MS,
};
