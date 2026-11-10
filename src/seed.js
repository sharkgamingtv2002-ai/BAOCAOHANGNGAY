'use strict';
// Tạo tài khoản Admin gốc. Chạy: npm run seed
const bcrypt = require('bcryptjs');
const { openDb } = require('./db');

const ROOT_USERNAME = 'k.huy';
const ROOT_PASSWORD = 'Khanhhuy@2002';

function seed(db) {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(ROOT_USERNAME);
  if (exists) return { created: false, id: exists.id };
  const hash = bcrypt.hashSync(ROOT_PASSWORD, 12);
  const r = db
    .prepare(
      `INSERT INTO users (username, full_name, password_hash, role, team, status, manager_teams)
       VALUES (?, ?, ?, 'admin', NULL, 'active', 'ALL')`
    )
    .run(ROOT_USERNAME, 'Quản trị viên', hash);
  return { created: true, id: Number(r.lastInsertRowid) };
}

if (require.main === module) {
  const db = openDb();
  const r = seed(db);
  console.log(r.created ? `Đã tạo tài khoản gốc "${ROOT_USERNAME}".` : `Tài khoản gốc "${ROOT_USERNAME}" đã tồn tại, bỏ qua.`);
  db.close();
}

module.exports = { seed, ROOT_USERNAME };
