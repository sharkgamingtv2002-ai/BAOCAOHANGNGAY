'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const v = require('../validate');
const { TEAMS } = require('../db');
const { HttpError, requireRole } = require('../auth');

module.exports = function adminRoutes(db) {
  const r = express.Router();
  r.use(requireRole('admin'));

  r.get('/users', (_req, res) => {
    const users = db
      .prepare(
        `SELECT id, username, full_name, role, team, status, manager_teams, created_at
           FROM users ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`
      )
      .all();
    res.json({ users });
  });

  function target(id) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
    if (!u) throw new HttpError(404, 'Không tìm thấy tài khoản.');
    if (u.role === 'admin') throw new HttpError(403, 'Không thể thay đổi tài khoản Admin từ trang này.');
    return u;
  }
  const kill = db.prepare('DELETE FROM sessions WHERE user_id = ?');

  r.post('/users/:id/approve', (req, res) => {
    const u = target(req.params.id);
    if (u.status !== 'pending' && u.status !== 'rejected') throw new HttpError(400, 'Tài khoản không ở trạng thái chờ duyệt.');
    db.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).run(u.id);
    res.json({ ok: true, message: `Đã duyệt tài khoản ${u.username}.` });
  });

  r.post('/users/:id/reject', (req, res) => {
    const u = target(req.params.id);
    if (u.status !== 'pending') throw new HttpError(400, 'Chỉ từ chối được tài khoản đang chờ duyệt.');
    db.prepare(`UPDATE users SET status = 'rejected' WHERE id = ?`).run(u.id);
    res.json({ ok: true, message: `Đã từ chối tài khoản ${u.username}.` });
  });

  r.post('/users/:id/lock', (req, res) => {
    const u = target(req.params.id);
    if (u.status !== 'active') throw new HttpError(400, 'Chỉ khóa được tài khoản đang hoạt động.');
    db.prepare(`UPDATE users SET status = 'locked' WHERE id = ?`).run(u.id);
    kill.run(u.id);
    res.json({ ok: true, message: `Đã khóa tài khoản ${u.username}.` });
  });

  r.post('/users/:id/unlock', (req, res) => {
    const u = target(req.params.id);
    if (u.status !== 'locked') throw new HttpError(400, 'Tài khoản không bị khóa.');
    db.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).run(u.id);
    res.json({ ok: true, message: `Đã mở khóa tài khoản ${u.username}.` });
  });

  // Gán vai trò, nhóm, phạm vi quản lý
  r.put('/users/:id', (req, res) => {
    const u = target(req.params.id);
    const b = req.body || {};
    const role = b.role === undefined ? u.role : b.role;
    if (!['staff', 'manager'].includes(role)) throw new HttpError(400, 'Vai trò chỉ được là Nhân viên hoặc Quản lý.');
    const team = b.team === undefined ? u.team : v.team(b.team);
    let manager_teams = u.manager_teams;
    if (b.manager_teams !== undefined) {
      if (b.manager_teams === 'ALL') manager_teams = 'ALL';
      else if (Array.isArray(b.manager_teams)) {
        for (const t of b.manager_teams) v.team(t);
        manager_teams = [...new Set(b.manager_teams)].join('|');
      } else throw new HttpError(400, 'Phạm vi quản lý không hợp lệ.');
    }
    if (role === 'staff') manager_teams = '';
    if (role === 'manager' && !manager_teams) manager_teams = team && TEAMS.includes(team) ? team : 'ALL';
    db.prepare('UPDATE users SET role = ?, team = ?, manager_teams = ? WHERE id = ?').run(role, team, manager_teams, u.id);
    res.json({ ok: true, message: `Đã cập nhật tài khoản ${u.username}.` });
  });

  r.post('/users/:id/reset-password', (req, res) => {
    const u = target(req.params.id);
    const pw = v.password((req.body || {}).new_password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(pw, 12), u.id);
    kill.run(u.id);
    res.json({ ok: true, message: `Đã đặt lại mật khẩu cho ${u.username}.` });
  });

  return r;
};
