'use strict';
// Test cơ bản: đăng ký chờ duyệt, khóa sửa sau phê duyệt, quyền xem báo cáo, xuất Excel
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { openDb } = require('../src/db');
const { seed } = require('../src/seed');
const { createApp } = require('../src/app');

let server, base, db;
const DATE = '2026-11-10';

/** Client đơn giản giữ cookie phiên */
function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (u) => call('GET', u),
    post: (u, b = {}) => call('POST', u, b),
    put: (u, b) => call('PUT', u, b),
    del: (u) => call('DELETE', u),
    login: (username, password) => call('POST', '/api/auth/login', { username, password }),
  };
}

let admin;
async function makeUser(username, team, role = 'staff', manager_teams) {
  const c = client();
  await c.post('/api/auth/register', { username, full_name: `NV ${username}`, password: 'Matkhau123', team });
  const { data } = await admin.get('/api/admin/users');
  const u = data.users.find((x) => x.username === username);
  await admin.post(`/api/admin/users/${u.id}/approve`);
  if (role !== 'staff') await admin.put(`/api/admin/users/${u.id}`, { role, manager_teams });
  const r = await c.login(username, 'Matkhau123');
  assert.equal(r.status, 200);
  return c;
}

before(async () => {
  db = openDb(':memory:');
  seed(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = client();
  const r = await admin.login('k.huy', 'Khanhhuy@2002');
  assert.equal(r.status, 200);
});

after(() => {
  server.close();
  db.close();
});

test('mật khẩu tài khoản gốc được băm bcrypt', () => {
  const u = db.prepare("SELECT password_hash FROM users WHERE username = 'k.huy'").get();
  assert.match(u.password_hash, /^\$2[aby]\$12\$/);
  assert.ok(!u.password_hash.includes('Khanhhuy'));
});

test('đăng ký mới ở trạng thái chờ duyệt, chưa đăng nhập được cho tới khi Admin duyệt', async () => {
  const c = client();
  const reg = await c.post('/api/auth/register', { username: 'nv.cho', full_name: 'Nhân viên chờ', password: 'Matkhau123', team: 'Điện' });
  assert.equal(reg.status, 201);
  const dup = await c.post('/api/auth/register', { username: 'nv.cho', full_name: 'Trùng', password: 'Matkhau123', team: 'Điện' });
  assert.equal(dup.status, 409);

  let r = await c.login('nv.cho', 'Matkhau123');
  assert.equal(r.status, 403);
  assert.match(r.data.error, /chờ Admin duyệt/);

  const { data } = await admin.get('/api/admin/users');
  const u = data.users.find((x) => x.username === 'nv.cho');
  assert.equal(u.status, 'pending');

  // nhân viên thường không gọi được API quản trị
  const staff = await makeUser('nv.khac', 'PM');
  assert.equal((await staff.post(`/api/admin/users/${u.id}/approve`)).status, 403);

  await admin.post(`/api/admin/users/${u.id}/approve`);
  r = await c.login('nv.cho', 'Matkhau123');
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'staff');

  // khóa tài khoản → phiên bị hủy
  await admin.post(`/api/admin/users/${u.id}/lock`);
  assert.equal((await c.get('/api/auth/me')).status, 401);
  assert.equal((await c.login('nv.cho', 'Matkhau123')).status, 403);
});

test('kiểm tra dữ liệu: tên máy bắt buộc, phần trăm 0–99 hoặc OK', async () => {
  const c = await makeUser('nv.valid', 'Điện');
  const base = { date: DATE, team: 'Điện', description: 'x' };
  assert.equal((await c.post('/api/entries', { ...base, machine: '' })).status, 400);
  assert.equal((await c.post('/api/entries', { ...base, machine: 'M1', completion: '150%' })).status, 400);
  assert.equal((await c.post('/api/entries', { ...base, machine: 'M1', completion: 'abc' })).status, 400);
  assert.equal((await c.post('/api/entries', { ...base, machine: 'M1', start_at: `${DATE}T10:00`, end_at: `${DATE}T09:00` })).status, 400);
  assert.equal((await c.post('/api/entries', { ...base, machine: 'M1', completion: '75%' })).status, 201);
  const qua = await c.post('/api/entries', { ...base, machine: 'M2', start_at: `${DATE}T22:00`, end_at: '2026-11-11T02:30' });
  assert.equal(qua.status, 201, 'cho phép làm qua ngày hôm sau');
});

test('khóa sửa sau phê duyệt và ghi lịch sử chỉnh sửa', async () => {
  const D = '2026-11-12';
  const nv = await makeUser('nv.co1', 'Cơ Khí');
  const nv2 = await makeUser('nv.co2', 'Cơ Khí');
  const ql = await makeUser('ql.co', 'Cơ Khí', 'manager', ['Cơ Khí']);
  const qlDien = await makeUser('ql.dien', 'Điện', 'manager', ['Điện']);

  const add = await nv.post('/api/entries', { date: D, team: 'Cơ Khí', machine: 'Máy ép 1', description: 'Thay bạc đạn', start_at: `${D}T08:00`, end_at: `${D}T10:00` });
  const id = add.data.id;
  await nv2.post('/api/entries', { date: D, team: 'Cơ Khí', machine: 'Băng tải', description: 'Căng băng tải' });

  // nhân viên chỉ sửa được dòng của mình
  assert.equal((await nv2.put(`/api/entries/${id}`, { machine: 'X' })).status, 403);
  assert.equal((await nv.put(`/api/entries/${id}`, { completion: '50' })).status, 200);

  // quản lý nhóm khác không duyệt được
  assert.equal((await qlDien.post('/api/report/approve', { date: D, team: 'Cơ Khí' })).status, 403);
  assert.equal((await nv.post('/api/report/approve', { date: D, team: 'Cơ Khí' })).status, 403);
  assert.equal((await ql.post('/api/report/approve', { date: D, team: 'Cơ Khí' })).status, 200);

  // sau duyệt: nhân viên không sửa/xóa/thêm được (kiểm tra ở backend)
  let r = await nv.put(`/api/entries/${id}`, { machine: 'Sửa lén' });
  assert.equal(r.status, 403);
  assert.equal((await nv.del(`/api/entries/${id}`)).status, 403);
  assert.equal((await nv.post('/api/entries', { date: D, team: 'Cơ Khí', machine: 'Mới' })).status, 403);
  const mine = await nv.get(`/api/entries/mine?date=${D}`);
  assert.equal(mine.data.entries[0].can_edit, false);

  // quản lý của nhóm sửa được, có ghi lịch sử
  assert.equal((await ql.put(`/api/entries/${id}`, { completion: 'OK', note: 'Đã chạy thử' })).status, 200);
  const h = await ql.get(`/api/report/history?date=${D}&team=${encodeURIComponent('Cơ Khí')}`);
  const upd = h.data.items.find((x) => x.action === 'update' && x.after_approval === 1);
  assert.ok(upd, 'phải có lịch sử sửa sau phê duyệt');
  assert.equal(upd.user_name, 'NV ql.co');
  assert.equal(upd.old_value.completion, 50);
  assert.equal(upd.new_value.completion, 100);
  assert.equal(upd.new_value.note, 'Đã chạy thử');

  // chỉ admin được hủy phê duyệt
  assert.equal((await ql.post('/api/report/unapprove', { date: D, team: 'Cơ Khí' })).status, 403);
  assert.equal((await admin.post('/api/report/unapprove', { date: D, team: 'Cơ Khí' })).status, 200);
  assert.equal((await nv.put(`/api/entries/${id}`, { machine: 'Máy ép 1A' })).status, 200);
});

test('quyền xem báo cáo tổng hợp', async () => {
  const D = '2026-11-13';
  const a = await makeUser('nv.pm1', 'PM');
  const b = await makeUser('nv.pm2', 'PM');
  const qlPM = await makeUser('ql.pm', 'PM', 'manager', ['PM']);
  const qlAll = await makeUser('ql.all', 'Điện', 'manager', 'ALL');
  await a.post('/api/entries', { date: D, team: 'PM', machine: 'Máy A', description: 'a' });
  await b.post('/api/entries', { date: D, team: 'PM', machine: 'Máy B', description: 'b' });

  // nhân viên: không xem được báo cáo tổng hợp, chỉ thấy dòng của mình
  assert.equal((await a.get(`/api/report?date=${D}&team=PM`)).status, 403);
  assert.equal((await a.get(`/api/reports?date=${D}`)).status, 403);
  const mine = await a.get(`/api/entries/mine?date=${D}`);
  assert.deepEqual(mine.data.entries.map((e) => e.machine), ['Máy A']);

  // quản lý giới hạn nhóm PM
  const rp = await qlPM.get(`/api/report?date=${D}&team=PM`);
  assert.equal(rp.status, 200);
  assert.equal(rp.data.entries.length, 2);
  assert.equal((await qlPM.get(`/api/report?date=${D}&team=${encodeURIComponent('Điện')}`)).status, 403);
  const list = await qlPM.get(`/api/reports?date=${D}`);
  assert.deepEqual(list.data.reports.map((r) => r.team), ['PM']);

  // quản lý xem tất cả và admin thấy cả 3 nhóm
  assert.equal((await qlAll.get(`/api/reports?date=${D}`)).data.reports.length, 3);
  assert.equal((await admin.get(`/api/reports?date=${D}`)).data.reports.length, 3);

  // chưa đăng nhập
  assert.equal((await client().get(`/api/reports?date=${D}`)).status, 401);
});

test('xuất Excel: chặn khi thiếu dữ liệu, xuất đúng mẫu khi đầy đủ', async () => {
  const D = '2026-11-10';
  const nv = await makeUser('nv.dien1', 'Điện');
  const ql = await makeUser('ql.dien2', 'Điện', 'manager', ['Điện']);
  // dữ liệu từ test trước (nv.valid) thiếu giờ → xóa sạch để test độc lập
  db.prepare("DELETE FROM entries WHERE report_id IN (SELECT id FROM reports WHERE report_date = ? AND team = 'Điện')").run(D);

  const r1 = await nv.post('/api/entries', { date: D, team: 'Điện', machine: 'Tủ điện MCC1', description: 'Thay contactor', start_at: `${D}T07:30`, end_at: `${D}T09:00`, note: 'Hoạt động bình thường' });
  const r2 = await nv.post('/api/entries', { date: D, team: 'Điện', machine: 'Motor quạt', description: '', start_at: `${D}T22:00` });

  assert.equal((await nv.get(`/api/report/export?date=${D}&team=${encodeURIComponent('Điện')}`)).status, 403);
  let ex = await ql.get(`/api/report/export?date=${D}&team=${encodeURIComponent('Điện')}`);
  assert.equal(ex.status, 400);
  assert.equal(ex.data.details.length, 1);
  assert.equal(ex.data.details[0].row, 2);
  assert.deepEqual(ex.data.details[0].fields, ['Diễn giải công việc', 'Thời gian kết thúc']);

  await nv.put(`/api/entries/${r2.data.id}`, { description: 'Quấn lại motor\nKiểm tra cách điện', end_at: '2026-11-11T02:15', completion: '80' });
  // thêm nhiều dòng để kiểm tra trường hợp vượt 20 dòng của mẫu
  for (let i = 0; i < 21; i++)
    await nv.post('/api/entries', { date: D, team: 'Điện', machine: `Máy ${i + 3}`, description: 'Bảo trì', start_at: `${D}T${String(10 + (i % 10)).padStart(2, '0')}:00`, end_at: `${D}T20:00` });
  await ql.post('/api/report/approve', { date: D, team: 'Điện' });

  ex = await ql.get(`/api/report/export?date=${D}&team=${encodeURIComponent('Điện')}`);
  assert.equal(ex.status, 200);
  assert.match(ex.headers.get('content-disposition'), /BaoCao_Dien_10-11-2026\.xlsx/);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(ex.data);
  const ws = wb.worksheets[0];
  assert.equal(ws.name, 'sua chua hang ngay');
  assert.equal(ws.getCell('B4').value, 'BÁO CÁO SỬA CHỮA HÀNG NGÀY');
  assert.match(ws.getCell('B5').value, /Bộ phận: Điện.*Ngày 10\s+Tháng 11\s+Năm 2026/);
  assert.equal(ws.getCell('B6').value, 'Tên máy');
  // dòng 1 sắp theo giờ bắt đầu
  assert.equal(ws.getCell('B7').value, 'Tủ điện MCC1');
  assert.equal(ws.getCell('C7').value, 'Thay contactor');
  assert.equal(ws.getCell('D7').value, '07:30');
  assert.equal(ws.getCell('E7').value, '09:00');
  assert.equal(ws.getCell('F7').value, 'Hoạt động bình thường');
  assert.equal(ws.getCell('G7').value, 'NV nv.dien1');
  assert.equal(ws.getCell('H7').value, 'OK');
  assert.equal(ws.getCell('B7').font.name, 'Times New Roman');
  assert.equal(ws.getCell('B7').border.top.style, 'thin');
  // dòng làm qua đêm nằm cuối (22:00)
  const total = 23;
  const last = 7 + total - 1; // dòng 29
  assert.equal(ws.getCell(`B${last}`).value, 'Motor quạt');
  assert.equal(ws.getCell(`E${last}`).value, '02:15 (11/11)');
  assert.equal(ws.getCell(`H${last}`).value, 0.8);
  assert.equal(ws.getCell(`H${last}`).numFmt, '0%');
  assert.equal(ws.getCell(`B${last}`).border.bottom.style, 'thin');
  // chân trang dời xuống 3 dòng, ô gộp vẫn đúng
  const shift = total - 20;
  assert.equal(ws.getCell(`F${28 + shift}`).value.trim(), 'Người duyệt');
  assert.equal(ws.getCell(`B${29 + shift}`).value, 'Mã hiệu: QT-03/BM07');
  assert.equal(ws.getCell(`F${31 + shift}`).value, 'NV ql.dien2');
  assert.ok(ws.model.merges.includes(`F${28 + shift}:H${28 + shift}`));
  assert.ok(ws.model.merges.includes(`F${31 + shift}:H${31 + shift}`));
  assert.equal(ws.pageSetup.printArea, `B1:H${31 + shift}`);
  assert.equal(ws.pageSetup.orientation, 'landscape');
});
