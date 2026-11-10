'use strict';
const express = require('express');
const v = require('../validate');
const { tx } = require('../db');
const { HttpError, requireLogin, requireRole, viewableTeams, canManageTeam } = require('../auth');
const { buildWorkbook, findMissing, exportFileName } = require('../excel');

module.exports = function reportRoutes(db) {
  const r = express.Router();
  r.use(requireLogin);

  const q = {
    report: db.prepare(
      `SELECT r.*, u.full_name AS approved_by_name FROM reports r
         LEFT JOIN users u ON u.id = r.approved_by
        WHERE r.report_date = ? AND r.team = ?`
    ),
    reportById: db.prepare('SELECT * FROM reports WHERE id = ?'),
    insertReport: db.prepare(`INSERT INTO reports (report_date, team) VALUES (?, ?) ON CONFLICT DO NOTHING`),
    entry: db.prepare(
      `SELECT e.*, r.report_date, r.team, r.status AS report_status
         FROM entries e JOIN reports r ON r.id = e.report_id WHERE e.id = ?`
    ),
    entriesOfReport: db.prepare(
      `SELECT e.*, u.full_name AS user_name FROM entries e JOIN users u ON u.id = e.user_id
        WHERE e.report_id = ? ORDER BY COALESCE(e.start_at, '9999'), e.id`
    ),
    myEntries: db.prepare(
      `SELECT e.*, r.team, r.report_date, r.status AS report_status, u.full_name AS user_name
         FROM entries e JOIN reports r ON r.id = e.report_id JOIN users u ON u.id = e.user_id
        WHERE e.user_id = ? AND r.report_date = ?
        ORDER BY COALESCE(e.start_at, '9999'), e.id`
    ),
    insertEntry: db.prepare(
      `INSERT INTO entries (report_id, user_id, machine, description, start_at, end_at, completion, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    log: db.prepare(
      `INSERT INTO audit_log (report_id, entry_id, user_id, action, after_approval, old_value, new_value)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ),
    history: db.prepare(
      `SELECT a.*, u.full_name AS user_name FROM audit_log a JOIN users u ON u.id = a.user_id
        WHERE a.report_id = ? ORDER BY a.id DESC`
    ),
  };

  const ENTRY_FIELDS = ['machine', 'description', 'start_at', 'end_at', 'completion', 'note'];
  const pick = (e) => Object.fromEntries(ENTRY_FIELDS.map((k) => [k, e[k]]));

  function getOrCreateReport(date, team) {
    q.insertReport.run(date, team);
    return q.report.get(date, team);
  }

  /** Quyền sửa/xóa 1 dòng: chủ dòng khi báo cáo chưa duyệt, hoặc quản lý/admin của nhóm */
  function canEdit(user, entry, reportStatus) {
    if (canManageTeam(user, entry.team)) return true;
    return entry.user_id === user.id && reportStatus === 'draft';
  }

  function serializeEntry(user, e) {
    return {
      id: e.id,
      user_id: e.user_id,
      user_name: e.user_name,
      machine: e.machine,
      description: e.description,
      start_at: e.start_at,
      end_at: e.end_at,
      completion: e.completion,
      note: e.note,
      updated_at: e.updated_at,
      can_edit: canEdit(user, e, e.report_status),
    };
  }

  function requireTeamAccess(user, team) {
    if (!canManageTeam(user, team)) throw new HttpError(403, 'Bạn không có quyền với báo cáo của nhóm này.');
  }

  // ---------- Nhân viên: dòng của chính mình ----------
  r.get('/entries/mine', (req, res) => {
    const date = v.date(req.query.date);
    const rows = q.myEntries.all(req.user.id, date);
    const statuses = {};
    for (const t of ['Điện', 'Cơ Khí', 'PM']) {
      const rep = q.report.get(date, t);
      statuses[t] = rep ? rep.status : 'draft';
    }
    res.json({
      date,
      report_status: statuses,
      entries: rows.map((e) => ({ ...serializeEntry(req.user, e), team: e.team })),
    });
  });

  r.post('/entries', (req, res) => {
    const b = req.body || {};
    const date = v.date(b.date);
    const team = v.team(b.team);
    const data = v.entryInput(b);
    v.checkTimeOrder(data.start_at, data.end_at);
    const id = tx(db, () => {
      const rep = getOrCreateReport(date, team);
      const manager = canManageTeam(req.user, team);
      if (rep.status === 'approved' && !manager)
        throw new HttpError(403, 'Báo cáo ngày này của nhóm đã được phê duyệt, không thể thêm dòng mới.');
      const result = q.insertEntry.run(rep.id, req.user.id, data.machine, data.description, data.start_at, data.end_at, data.completion, data.note);
      const entryId = Number(result.lastInsertRowid);
      q.log.run(rep.id, entryId, req.user.id, 'create', rep.status === 'approved' ? 1 : 0, null, JSON.stringify(data));
      return entryId;
    });
    res.status(201).json({ ok: true, id });
  });

  function loadEditable(req) {
    const e = q.entry.get(Number(req.params.id));
    if (!e) throw new HttpError(404, 'Không tìm thấy dòng công việc.');
    const manager = canManageTeam(req.user, e.team);
    if (!manager) {
      if (e.user_id !== req.user.id) throw new HttpError(403, 'Bạn chỉ được sửa dòng do chính mình nhập.');
      if (e.report_status === 'approved')
        throw new HttpError(403, 'Báo cáo đã được phê duyệt, bạn không thể sửa hoặc xóa nữa.');
    }
    return e;
  }

  r.put('/entries/:id', (req, res) => {
    tx(db, () => {
      const e = loadEditable(req);
      const data = v.entryInput(req.body, true);
      const next = { ...pick(e), ...data };
      v.checkTimeOrder(next.start_at, next.end_at);
      const old = pick(e);
      const changed = ENTRY_FIELDS.filter((k) => old[k] !== next[k]);
      if (!changed.length) return;
      db.prepare(
        `UPDATE entries SET machine = ?, description = ?, start_at = ?, end_at = ?, completion = ?, note = ?,
                updated_at = datetime('now','localtime') WHERE id = ?`
      ).run(next.machine, next.description, next.start_at, next.end_at, next.completion, next.note, e.id);
      const oldDiff = Object.fromEntries(changed.map((k) => [k, old[k]]));
      const newDiff = Object.fromEntries(changed.map((k) => [k, next[k]]));
      q.log.run(e.report_id, e.id, req.user.id, 'update', e.report_status === 'approved' ? 1 : 0, JSON.stringify(oldDiff), JSON.stringify(newDiff));
    });
    res.json({ ok: true });
  });

  r.delete('/entries/:id', (req, res) => {
    tx(db, () => {
      const e = loadEditable(req);
      db.prepare('DELETE FROM entries WHERE id = ?').run(e.id);
      q.log.run(e.report_id, e.id, req.user.id, 'delete', e.report_status === 'approved' ? 1 : 0, JSON.stringify(pick(e)), null);
    });
    res.json({ ok: true });
  });

  // ---------- Quản lý / Admin: báo cáo tổng hợp ----------
  const managerOnly = requireRole('admin', 'manager');

  function reportPayload(user, date, team) {
    const rep = q.report.get(date, team);
    const entries = rep ? q.entriesOfReport.all(rep.id).map((e) => serializeEntry(user, { ...e, team, report_status: rep.status })) : [];
    return {
      date,
      team,
      status: rep ? rep.status : 'draft',
      approved_by_name: rep ? rep.approved_by_name : null,
      approved_at: rep ? rep.approved_at : null,
      entries,
      missing: findMissing(entries),
    };
  }

  // 3 báo cáo của 1 ngày (chỉ các nhóm được phép)
  r.get('/reports', managerOnly, (req, res) => {
    const date = v.date(req.query.date);
    const teams = viewableTeams(req.user);
    res.json({ date, reports: teams.map((t) => reportPayload(req.user, date, t)) });
  });

  // Tóm tắt theo tháng cho lịch: { 'YYYY-MM-DD': { team: {status, count} } }
  r.get('/reports/month', managerOnly, (req, res) => {
    const month = String(req.query.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'Tháng không hợp lệ (YYYY-MM).');
    const teams = viewableTeams(req.user);
    const rows = db
      .prepare(
        `SELECT r.report_date, r.team, r.status, COUNT(e.id) AS cnt FROM reports r
           LEFT JOIN entries e ON e.report_id = r.id
          WHERE r.report_date LIKE ? GROUP BY r.id`
      )
      .all(`${month}-%`);
    const out = {};
    for (const row of rows) {
      if (!teams.includes(row.team) || !row.cnt) continue;
      (out[row.report_date] ||= {})[row.team] = { status: row.status, count: row.cnt };
    }
    res.json({ month, days: out });
  });

  r.get('/report', managerOnly, (req, res) => {
    const date = v.date(req.query.date);
    const team = v.team(req.query.team);
    requireTeamAccess(req.user, team);
    res.json(reportPayload(req.user, date, team));
  });

  r.get('/report/history', managerOnly, (req, res) => {
    const date = v.date(req.query.date);
    const team = v.team(req.query.team);
    requireTeamAccess(req.user, team);
    const rep = q.report.get(date, team);
    const items = rep
      ? q.history.all(rep.id).map((h) => ({
          ...h,
          old_value: h.old_value ? JSON.parse(h.old_value) : null,
          new_value: h.new_value ? JSON.parse(h.new_value) : null,
        }))
      : [];
    res.json({ items });
  });

  r.post('/report/approve', managerOnly, (req, res) => {
    const date = v.date((req.body || {}).date);
    const team = v.team((req.body || {}).team);
    requireTeamAccess(req.user, team);
    tx(db, () => {
      const rep = q.report.get(date, team);
      if (!rep || !q.entriesOfReport.all(rep.id).length) throw new HttpError(400, 'Báo cáo chưa có dòng công việc nào.');
      if (rep.status === 'approved') throw new HttpError(400, 'Báo cáo đã được phê duyệt trước đó.');
      db.prepare(`UPDATE reports SET status = 'approved', approved_by = ?, approved_at = datetime('now','localtime') WHERE id = ?`).run(req.user.id, rep.id);
      q.log.run(rep.id, null, req.user.id, 'approve', 0, null, null);
    });
    res.json({ ok: true, message: `Đã phê duyệt báo cáo nhóm ${team}.` });
  });

  r.post('/report/unapprove', requireRole('admin'), (req, res) => {
    const date = v.date((req.body || {}).date);
    const team = v.team((req.body || {}).team);
    tx(db, () => {
      const rep = q.report.get(date, team);
      if (!rep || rep.status !== 'approved') throw new HttpError(400, 'Báo cáo chưa được phê duyệt.');
      db.prepare(`UPDATE reports SET status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = ?`).run(rep.id);
      q.log.run(rep.id, null, req.user.id, 'unapprove', 1, null, null);
    });
    res.json({ ok: true, message: `Đã hủy phê duyệt, nhân viên nhóm ${team} có thể sửa lại.` });
  });

  r.get('/report/export', managerOnly, async (req, res, next) => {
    try {
      const date = v.date(req.query.date);
      const team = v.team(req.query.team);
      requireTeamAccess(req.user, team);
      const data = reportPayload(req.user, date, team);
      if (!data.entries.length) throw new HttpError(400, 'Báo cáo chưa có dòng công việc nào để xuất.');
      if (data.missing.length)
        throw new HttpError(400, 'Báo cáo chưa đầy đủ, chưa thể xuất Excel.', data.missing);
      const wb = await buildWorkbook(data);
      const name = exportFileName(team, date);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) {
      next(e);
    }
  });

  return r;
};
