'use strict';
const { openDb } = require('./db');
const { seed } = require('./seed');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const db = openDb();
seed(db); // đảm bảo luôn có tài khoản gốc
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

const app = createApp(db, {
  secureCookie: process.env.COOKIE_SECURE === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
});

app.listen(PORT, HOST, () => {
  console.log(`Máy chủ báo cáo đang chạy: http://localhost:${PORT}`);
});
