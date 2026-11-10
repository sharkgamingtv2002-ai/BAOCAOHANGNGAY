'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const v = require('../validate');
const { HttpError, createSession, destroySession, requireLogin, viewableTeams } = require('../auth');

// Bcrypt giả để so sánh khi tài khoản không tồn tại (tránh đoán tài khoản qua thời gian phản hồi)
const DUMMY_HASH = bcrypt.hashSync('khong-ton-tai', 10);

// Giới hạn đăng nhập sai: 10 lần / 15 phút cho mỗi (IP + tên đăng nhập)
const failures = new Map();
const WINDOW = 15 * 60 * 1000;
function tooMany(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW) {
    failures.delete(key);
    return false;
  }
  return f.count >= 10;
}
function recordFail(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    full_name: u.full_name,
    role: u.role,
    team: u.team,
    manager_teams: u.manager_teams,
    viewable_teams: viewableTeams(u),
  };
}

module.exports = function authRoutes(db, opts) {
  const r = express.Router();

  r.post('/register', (req, res) => {
    const b = req.body || {};
    const username = v.username(b.username);
    const full_name = v.fullName(b.full_name);
    const password = v.password(b.password);
    const team = v.team(b.team);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username))
      throw new HttpError(409, 'Tên đăng nhập đã tồn tại.');
    const hash = bcrypt.hashSync(password, 12);
    db.prepare(
      `INSERT INTO users (username, full_name, password_hash, role, team, status) VALUES (?, ?, ?, 'staff', ?, 'pending')`
    ).run(username, full_name, hash, team);
    res.status(201).json({ ok: true, message: 'Đăng ký thành công. Vui lòng chờ Admin duyệt tài khoản.' });
  });

  r.post('/login', (req, res) => {
    const b = req.body || {};
    const username = typeof b.username === 'string' ? b.username.trim() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    if (!username || !password) throw new HttpError(400, 'Vui lòng nhập tên đăng nhập và mật khẩu.');
    const key = `${req.ip}|${username.toLowerCase()}`;
    if (tooMany(key)) throw new HttpError(429, 'Bạn đã nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.');

    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const ok = bcrypt.compareSync(password, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok) {
      recordFail(key);
      throw new HttpError(401, 'Tên đăng nhập hoặc mật khẩu không đúng.');
    }
    if (u.status === 'pending') throw new HttpError(403, 'Tài khoản đang chờ Admin duyệt.');
    if (u.status === 'rejected') throw new HttpError(403, 'Tài khoản đã bị từ chối.');
    if (u.status === 'locked') throw new HttpError(403, 'Tài khoản đã bị khóa. Vui lòng liên hệ Admin.');
    failures.delete(key);
    createSession(db, res, u.id, opts.secureCookie);
    res.json({ ok: true, user: publicUser(u) });
  });

  r.post('/logout', (req, res) => {
    destroySession(db, req, res);
    res.json({ ok: true });
  });

  r.get('/me', requireLogin, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  r.post('/change-password', requireLogin, (req, res) => {
    const b = req.body || {};
    const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (typeof b.old_password !== 'string' || !bcrypt.compareSync(b.old_password, u.password_hash))
      throw new HttpError(400, 'Mật khẩu hiện tại không đúng.');
    const pw = v.password(b.new_password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(pw, 12), req.user.id);
    res.json({ ok: true, message: 'Đã đổi mật khẩu.' });
  });

  r.post('/profile', requireLogin, (req, res) => {
    const full_name = v.fullName((req.body || {}).full_name);
    db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(full_name, req.user.id);
    res.json({ ok: true, message: 'Đã cập nhật họ tên.' });
  });

  return r;
};
