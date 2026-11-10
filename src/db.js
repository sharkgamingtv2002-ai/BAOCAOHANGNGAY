'use strict';
// Kết nối SQLite (module tích hợp node:sqlite, không cần biên dịch native)
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const TEAMS = ['Điện', 'Cơ Khí', 'PM'];
const ROLES = ['admin', 'manager', 'staff'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','manager','staff')),
  team          TEXT CHECK (team IS NULL OR team IN ('Điện','Cơ Khí','PM')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected','locked')),
  manager_teams TEXT NOT NULL DEFAULT '',          -- 'ALL' hoặc danh sách nhóm cách nhau bởi dấu |
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL,                       -- YYYY-MM-DD
  team        TEXT NOT NULL CHECK (team IN ('Điện','Cơ Khí','PM')),
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  UNIQUE (report_date, team)
);

CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id   INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  machine     TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_at    TEXT,                                -- YYYY-MM-DDTHH:mm
  end_at      TEXT,
  completion  INTEGER NOT NULL DEFAULT 100 CHECK (completion BETWEEN 0 AND 100), -- 100 = OK
  note        TEXT NOT NULL DEFAULT '',            -- Tình trạng máy / Ghi chú
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_entries_report ON entries(report_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id      INTEGER NOT NULL,
  entry_id       INTEGER,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  action         TEXT NOT NULL,                    -- create | update | delete | approve | unapprove
  after_approval INTEGER NOT NULL DEFAULT 0,
  old_value      TEXT,
  new_value      TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_audit_report ON audit_log(report_id);
`;

function openDb(file) {
  const dbFile = file || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db');
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** Chạy fn trong 1 transaction */
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDb, tx, TEAMS, ROLES };
