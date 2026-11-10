'use strict';
/**
 * Máy chủ chạy thử trên máy: phát thư mục web/ (giống GitHub Pages) + giả lập Supabase.
 *   npm run dev      → http://localhost:3000
 * Dữ liệu thử lưu ở data/dev-db (xóa thư mục này để làm lại từ đầu).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createMockSupabase } = require('./supabase-mock');

const PORT = Number(process.env.PORT) || 3000;
const WEB = path.join(__dirname, '..', 'web');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

(async () => {
  const mock = await createMockSupabase({ dataDir: path.join(__dirname, '..', 'data', 'dev-db') });

  const admin = await mock.db.query("select 1 from private.users where role = 'admin'");
  if (!admin.rows.length) {
    const pw = process.env.DEV_ADMIN_PASSWORD || `Thu${crypto.randomBytes(4).toString('hex')}9`;
    await mock.createAdmin('k.huy', 'Quản trị viên', pw);
    console.log(`\n[chạy thử] Đã tạo Admin "k.huy" với mật khẩu: ${pw}\n`);
  }

  http.createServer(async (req, res) => {
    try {
      if (await mock.handle(req, res)) return;
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      // Cấu hình chạy thử: trỏ Supabase về chính máy chủ này
      if (p === '/config.js') {
        res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
        return res.end("window.APP_CONFIG = { SUPABASE_URL: location.origin, SUPABASE_KEY: 'dev-local' };\n");
      }
      const file = path.normalize(path.join(WEB, p));
      if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Không tìm thấy');
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      console.error(e);
      res.writeHead(500);
      res.end();
    }
  }).listen(PORT, () => console.log(`Chạy thử tại http://localhost:${PORT}`));
})();
