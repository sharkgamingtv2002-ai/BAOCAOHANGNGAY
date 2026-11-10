'use strict';
// Test chạy trên ĐÚNG file supabase/schema.sql (PostgreSQL nhúng – PGlite)
// Bao gồm: đăng ký chờ duyệt, khóa sửa sau phê duyệt, quyền xem báo cáo, xuất Excel, chặn truy cập trực tiếp.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { createMockSupabase } = require('../dev/supabase-mock');
const ExcelExport = require('../web/excel-export');

let mock;
let admin;
const PW = 'Matkhau123';

/** Client giữ token như trình duyệt */
function client(token = null) {
  const c = {
    token,
    async call(fn, args = {}, withToken = true) {
      return mock.rpc(fn, withToken ? { p_token: c.token, ...args } : args);
    },
    async login(username, password) {
      const r = await mock.rpc('login', { p_username: username, p_password: password });
      if (r.body.ok) c.token = r.body.token;
      return r;
    },
  };
  return c;
}

async function userId(username) {
  const { body } = await admin.call('admin_list_users');
  return body.users.find((x) => x.username === username).id;
}

async function makeUser(username, team, role = 'staff', scope = {}) {
  const c = client();
  const reg = await c.call('register', { p_username: username, p_full_name: `NV ${username}`, p_password: PW, p_team: team }, false);
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  const id = await userId(username);
  await admin.call('admin_set_status', { p_user_id: id, p_action: 'approve' });
  if (role !== 'staff') {
    const r = await admin.call('admin_update_user', {
      p_user_id: id, p_role: role, p_team: team, p_manager_all: !!scope.all, p_manager_teams: scope.teams || [],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const r = await c.login(username, PW);
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  return c;
}

const entry = (date, o = {}) => ({ machine: 'Máy', description: 'Việc', start_at: `${date}T08:00`, end_at: `${date}T09:00`, completion: 'OK', ...o });

before(async () => {
  mock = await createMockSupabase();
  await mock.createAdmin('k.huy', 'Quản trị viên', 'AdminTest123');
  admin = client();
  const r = await admin.login('k.huy', 'AdminTest123');
  assert.equal(r.body.ok, true);
});

after(async () => {
  await mock.close();
});

test('mật khẩu băm bcrypt, trình duyệt không đọc được bảng và hàm nội bộ', async () => {
  const { rows } = await mock.db.query("select password_hash from private.users where username = 'k.huy'");
  assert.match(rows[0].password_hash, /^\$2[aby]\$12\$/);

  // vai trò anon (khóa công khai của Supabase) không truy cập trực tiếp được
  for (const sql of ['select * from private.users', 'select * from private.sessions', "select private.create_admin('x.y','Hacker','Abcdefg123')"]) {
    await assert.rejects(
      mock.db.transaction(async (tx) => { await tx.exec('set local role anon'); await tx.query(sql); }),
      /permission denied/
    );
  }
  // hàm nội bộ không lộ ra API
  assert.equal((await mock.rpc('create_admin', {})).status, 404);
});

test('đăng ký mới ở trạng thái chờ duyệt, chưa đăng nhập được cho tới khi Admin duyệt', async () => {
  const c = client();
  const reg = await c.call('register', { p_username: 'nv.cho', p_full_name: 'Nhân viên chờ', p_password: PW, p_team: 'Điện' }, false);
  assert.equal(reg.status, 200);
  const dup = await c.call('register', { p_username: 'NV.CHO', p_full_name: 'Trùng', p_password: PW, p_team: 'Điện' }, false);
  assert.equal(dup.status, 409);
  assert.equal((await c.call('register', { p_username: 'nv.yeu', p_full_name: 'Yếu', p_password: '123', p_team: 'Điện' }, false)).status, 400);

  let r = await c.login('nv.cho', PW);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /chờ Admin duyệt/);
  assert.equal((await c.login('nv.cho', 'SaiMatKhau1')).body.error, 'Tên đăng nhập hoặc mật khẩu không đúng.');

  const id = await userId('nv.cho');
  const staff = await makeUser('nv.khac', 'PM');
  assert.equal((await staff.call('admin_set_status', { p_user_id: id, p_action: 'approve' })).status, 403);
  assert.equal((await staff.call('admin_list_users')).status, 403);

  assert.equal((await admin.call('admin_set_status', { p_user_id: id, p_action: 'approve' })).status, 200);
  r = await c.login('nv.cho', PW);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.user.role, 'staff');

  // khóa → phiên bị hủy ngay
  await admin.call('admin_set_status', { p_user_id: id, p_action: 'lock' });
  assert.equal((await c.call('me')).status, 401);
  assert.match((await c.login('nv.cho', PW)).body.error, /bị khóa/);

  // không sửa được tài khoản Admin
  const adminId = await userId('k.huy');
  assert.equal((await admin.call('admin_set_status', { p_user_id: adminId, p_action: 'lock' })).status, 403);
});

test('giới hạn đăng nhập sai 10 lần / 15 phút', async () => {
  await makeUser('nv.brute', 'PM');
  const c = client();
  for (let i = 0; i < 10; i++) await c.login('nv.brute', 'SaiMatKhau1');
  const r = await c.login('nv.brute', PW);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /quá nhiều lần/);
});

test('kiểm tra dữ liệu: tên máy bắt buộc, phần trăm 0–99 hoặc OK, giờ hợp lệ', async () => {
  const c = await makeUser('nv.valid', 'Điện');
  const D = '2026-11-09';
  const add = (o) => c.call('add_entry', { p_date: D, p_team: 'Điện', p_entry: entry(D, o) });
  assert.equal((await add({ machine: '  ' })).status, 400);
  assert.equal((await add({ completion: '150%' })).status, 400);
  assert.equal((await add({ completion: 'abc' })).status, 400);
  assert.equal((await add({ start_at: `${D}T25:00` })).status, 400);
  assert.equal((await add({ start_at: `${D}T10:00`, end_at: `${D}T09:00` })).status, 400);
  assert.equal((await c.call('add_entry', { p_date: '2026-02-30', p_team: 'Điện', p_entry: entry(D) })).status, 400);
  assert.equal((await c.call('add_entry', { p_date: D, p_team: 'Hóa', p_entry: entry(D) })).status, 400);
  assert.equal((await add({ completion: '75%' })).status, 200);
  assert.equal((await add({ completion: 0 })).status, 200);
  assert.equal((await add({ start_at: `${D}T22:00`, end_at: '2026-11-10T02:30' })).status, 200, 'cho phép qua ngày hôm sau');
  const mine = await c.call('my_entries', { p_date: D });
  assert.deepEqual(mine.body.entries.map((e) => e.completion).sort((x, y) => x - y), [0, 75, 100]);
});

test('khóa sửa sau phê duyệt và ghi lịch sử chỉnh sửa', async () => {
  const D = '2026-11-12';
  const nv = await makeUser('nv.co1', 'Cơ Khí');
  const nv2 = await makeUser('nv.co2', 'Cơ Khí');
  const ql = await makeUser('ql.co', 'Cơ Khí', 'manager', { teams: ['Cơ Khí'] });
  const qlDien = await makeUser('ql.dien', 'Điện', 'manager', { teams: ['Điện'] });

  const add = await nv.call('add_entry', { p_date: D, p_team: 'Cơ Khí', p_entry: entry(D, { machine: 'Máy ép 1' }) });
  const id = add.body.id;
  await nv2.call('add_entry', { p_date: D, p_team: 'Cơ Khí', p_entry: entry(D, { machine: 'Băng tải' }) });

  // chỉ sửa được dòng của mình
  assert.equal((await nv2.call('update_entry', { p_id: id, p_entry: { machine: 'X' } })).status, 403);
  assert.equal((await nv2.call('delete_entry', { p_id: id })).status, 403);
  assert.equal((await nv.call('update_entry', { p_id: id, p_entry: { completion: '50' } })).status, 200);

  // phê duyệt: chỉ quản lý đúng nhóm
  const body = { p_date: D, p_team: 'Cơ Khí' };
  assert.equal((await qlDien.call('approve_report', body)).status, 403);
  assert.equal((await nv.call('approve_report', body)).status, 403);
  assert.equal((await ql.call('approve_report', body)).status, 200);

  // sau duyệt: nhân viên không sửa/xóa/thêm được (kiểm tra ở máy chủ)
  assert.equal((await nv.call('update_entry', { p_id: id, p_entry: { machine: 'Sửa lén' } })).status, 403);
  assert.equal((await nv.call('delete_entry', { p_id: id })).status, 403);
  assert.equal((await nv.call('add_entry', { p_date: D, p_team: 'Cơ Khí', p_entry: entry(D) })).status, 403);
  assert.equal((await nv.call('my_entries', { p_date: D })).body.entries[0].can_edit, false);

  // quản lý nhóm sửa được, có lịch sử
  assert.equal((await ql.call('update_entry', { p_id: id, p_entry: { completion: 'OK', note: 'Đã chạy thử' } })).status, 200);
  const h = await ql.call('report_history', body);
  const upd = h.body.items.find((x) => x.action === 'update' && x.after_approval);
  assert.ok(upd, 'phải có lịch sử sửa sau phê duyệt');
  assert.equal(upd.user_name, 'NV ql.co');
  assert.deepEqual(upd.old_value, { completion: 50, note: '' });
  assert.deepEqual(upd.new_value, { completion: 100, note: 'Đã chạy thử' });
  assert.equal((await qlDien.call('report_history', body)).status, 403);

  // chỉ Admin hủy phê duyệt
  assert.equal((await ql.call('unapprove_report', body)).status, 403);
  assert.equal((await admin.call('unapprove_report', body)).status, 200);
  assert.equal((await nv.call('update_entry', { p_id: id, p_entry: { machine: 'Máy ép 1A' } })).status, 200);
});

test('quyền xem báo cáo tổng hợp', async () => {
  const D = '2026-11-13';
  const a = await makeUser('nv.pm1', 'PM');
  const b = await makeUser('nv.pm2', 'PM');
  const qlPM = await makeUser('ql.pm', 'PM', 'manager', { teams: ['PM'] });
  const qlAll = await makeUser('ql.all', 'Điện', 'manager', { all: true });
  await a.call('add_entry', { p_date: D, p_team: 'PM', p_entry: entry(D, { machine: 'Máy A' }) });
  await b.call('add_entry', { p_date: D, p_team: 'PM', p_entry: entry(D, { machine: 'Máy B' }) });

  // nhân viên: không xem báo cáo tổng hợp, chỉ thấy dòng của mình
  assert.equal((await a.call('reports_of_day', { p_date: D })).status, 403);
  assert.equal((await a.call('reports_month', { p_month: '2026-11' })).status, 403);
  assert.equal((await a.call('report_export', { p_date: D, p_team: 'PM' })).status, 403);
  assert.deepEqual((await a.call('my_entries', { p_date: D })).body.entries.map((e) => e.machine), ['Máy A']);

  // quản lý giới hạn nhóm PM
  const list = await qlPM.call('reports_of_day', { p_date: D });
  assert.deepEqual(list.body.reports.map((r) => r.team), ['PM']);
  assert.equal(list.body.reports[0].entries.length, 2);
  assert.equal((await qlPM.call('report_history', { p_date: D, p_team: 'Điện' })).status, 403);

  // quản lý "tất cả" và Admin thấy cả 3 nhóm
  assert.deepEqual((await qlAll.call('reports_of_day', { p_date: D })).body.reports.map((r) => r.team), ['Điện', 'Cơ Khí', 'PM']);
  assert.equal((await admin.call('reports_of_day', { p_date: D })).body.reports.length, 3);

  // chưa đăng nhập / token giả
  assert.equal((await client().call('reports_of_day', { p_date: D })).status, 401);
  assert.equal((await client('a'.repeat(64)).call('reports_of_day', { p_date: D })).status, 401);
});

test('xuất Excel: chặn khi thiếu dữ liệu, xuất đúng mẫu khi đầy đủ', async () => {
  const D = '2026-11-10';
  const nv = await makeUser('nv.dien1', 'Điện');
  const ql = await makeUser('ql.dien2', 'Điện', 'manager', { teams: ['Điện'] });
  const body = { p_date: D, p_team: 'Điện' };

  await nv.call('add_entry', { p_date: D, p_team: 'Điện', p_entry: entry(D, { machine: 'Tủ điện MCC1', description: 'Thay contactor', start_at: `${D}T07:30`, end_at: `${D}T09:00`, note: 'Hoạt động bình thường' }) });
  const r2 = await nv.call('add_entry', { p_date: D, p_team: 'Điện', p_entry: { machine: 'Motor quạt', description: '', start_at: `${D}T22:00` } });

  assert.equal((await nv.call('report_export', body)).status, 403);
  let ex = await ql.call('report_export', body);
  assert.equal(ex.status, 400);
  const missing = JSON.parse(ex.body.details);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].row, 2);
  assert.deepEqual(missing[0].fields, ['Diễn giải công việc', 'Thời gian kết thúc']);

  await nv.call('update_entry', { p_id: r2.body.id, p_entry: { description: 'Quấn lại motor\nKiểm tra cách điện', end_at: '2026-11-11T02:15', completion: '80' } });
  for (let i = 0; i < 21; i++) {
    const h = String(10 + (i % 10)).padStart(2, '0');
    await nv.call('add_entry', { p_date: D, p_team: 'Điện', p_entry: entry(D, { machine: `Máy ${i + 3}`, start_at: `${D}T${h}:00`, end_at: `${D}T20:00` }) });
  }
  await ql.call('approve_report', body);

  ex = await ql.call('report_export', body);
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  assert.equal(ExcelExport.exportFileName(ex.body.team, ex.body.date), 'BaoCao_Dien_10-11-2026.xlsx');

  const template = fs.readFileSync(path.join(__dirname, '..', 'web', 'mau_bao_cao.xlsx'));
  const built = await ExcelExport.buildWorkbook(ExcelJS, template, ex.body);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await built.xlsx.writeBuffer());
  const ws = wb.worksheets[0];
  assert.equal(ws.name, 'sua chua hang ngay');
  assert.equal(ws.getCell('B4').value, 'BÁO CÁO SỬA CHỮA HÀNG NGÀY');
  assert.match(ws.getCell('B5').value, /Bộ phận: Điện.*Ngày 10\s+Tháng 11\s+Năm 2026/);
  assert.equal(ws.getCell('B6').value, 'Tên máy');
  assert.equal(ws.getCell('B7').value, 'Tủ điện MCC1');
  assert.equal(ws.getCell('C7').value, 'Thay contactor');
  assert.equal(ws.getCell('D7').value, '07:30');
  assert.equal(ws.getCell('E7').value, '09:00');
  assert.equal(ws.getCell('F7').value, 'Hoạt động bình thường');
  assert.equal(ws.getCell('G7').value, 'NV nv.dien1');
  assert.equal(ws.getCell('H7').value, 'OK');
  assert.equal(ws.getCell('B7').font.name, 'Times New Roman');
  assert.equal(ws.getCell('B7').border.top.style, 'thin');
  const total = 23;
  const last = 7 + total - 1;
  assert.equal(ws.getCell(`B${last}`).value, 'Motor quạt');
  assert.equal(ws.getCell(`E${last}`).value, '02:15 (11/11)');
  assert.equal(ws.getCell(`H${last}`).value, 0.8);
  assert.equal(ws.getCell(`H${last}`).numFmt, '0%');
  assert.equal(ws.getCell(`B${last}`).border.bottom.style, 'thin');
  const shift = total - 20;
  assert.equal(ws.getCell(`F${28 + shift}`).value.trim(), 'Người duyệt');
  assert.equal(ws.getCell(`B${29 + shift}`).value, 'Mã hiệu: QT-03/BM07');
  assert.equal(ws.getCell(`F${31 + shift}`).value, 'NV ql.dien2');
  assert.ok(ws.model.merges.includes(`F${28 + shift}:H${28 + shift}`));
  assert.ok(ws.model.merges.includes(`F${31 + shift}:H${31 + shift}`));
  assert.equal(ws.pageSetup.printArea, `B1:H${31 + shift}`);
  assert.equal(ws.pageSetup.orientation, 'landscape');
});
