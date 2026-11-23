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

test('kiểm tra dữ liệu: diễn giải bắt buộc, tên máy không bắt buộc, phần trăm 0–99 hoặc OK, giờ hợp lệ', async () => {
  const c = await makeUser('nv.valid', 'Điện');
  const D = '2026-11-09';
  const add = (o) => c.call('add_entry', { p_date: D, p_team: 'Điện', p_entry: entry(D, o) });
  assert.equal((await add({ description: '  ' })).status, 400, 'diễn giải công việc bắt buộc');
  assert.equal((await add({ description: undefined })).status, 400);
  assert.equal((await add({ completion: '150%' })).status, 400);
  assert.equal((await add({ completion: 'abc' })).status, 400);
  assert.equal((await add({ start_at: `${D}T25:00` })).status, 400);
  assert.equal((await add({ start_at: `${D}T10:00`, end_at: `${D}T09:00` })).status, 400);
  assert.equal((await c.call('add_entry', { p_date: '2026-02-30', p_team: 'Điện', p_entry: entry(D) })).status, 400);
  assert.equal((await c.call('add_entry', { p_date: D, p_team: 'Hóa', p_entry: entry(D) })).status, 400);
  assert.equal((await add({ completion: '75%' })).status, 200);
  assert.equal((await add({ completion: 0 })).status, 200);
  assert.equal((await add({ start_at: `${D}T22:00`, end_at: '2026-11-10T02:30' })).status, 200, 'cho phép qua ngày hôm sau');
  assert.equal((await add({ machine: '', note: '' })).status, 200, 'không ghi tên máy, không ghi chú vẫn gửi được');
  const mine = await c.call('my_entries', { p_date: D });
  assert.deepEqual(mine.body.entries.map((e) => e.completion).sort((x, y) => x - y), [0, 75, 100, 100]);
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
  const r2 = await nv.call('add_entry', { p_date: D, p_team: 'Điện', p_entry: { machine: '', description: 'Quấn lại motor', start_at: `${D}T22:00` } });

  assert.equal((await nv.call('report_export', body)).status, 403);
  let ex = await ql.call('report_export', body);
  assert.equal(ex.status, 400);
  const missing = JSON.parse(ex.body.details);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].row, 2);
  assert.deepEqual(missing[0].fields, ['Thời gian kết thúc'], 'thiếu tên máy không chặn xuất Excel');

  await nv.call('update_entry', { p_id: r2.body.id, p_entry: { description: 'Quấn lại motor\nKiểm tra cách điện', end_at: '2026-11-11T02:15', completion: '80' } });
  for (let i = 0; i < 21; i++) {
    const h = String(10 + (i % 10)).padStart(2, '0');
    await nv.call('add_entry', { p_date: D, p_team: 'Điện', p_entry: entry(D, { machine: `Máy ${i + 3}`, start_at: `${D}T${h}:00`, end_at: `${D}T20:00` }) });
  }
  await ql.call('approve_report', body);

  ex = await ql.call('report_export', body);
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  assert.equal(ex.body.shift, 'Hành chính', 'không chọn ca → ca Hành chính');
  assert.equal(ExcelExport.exportFileName(ex.body.team, ex.body.date, ex.body.shift), 'BaoCao_Dien_HanhChinh_10-11-2026.xlsx');

  const template = fs.readFileSync(path.join(__dirname, '..', 'web', 'mau_bao_cao.xlsx'));
  const built = await ExcelExport.buildWorkbook(ExcelJS, template, ex.body);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await built.xlsx.writeBuffer());
  const ws = wb.worksheets[0];
  assert.equal(ws.name, 'sua chua hang ngay');
  assert.equal(ws.getCell('B4').value, 'BÁO CÁO SỬA CHỮA HÀNG NGÀY');
  assert.match(ws.getCell('B5').value, /Bộ phận: Điện\s+Ca: Hành chính\s+Ngày 10\s+Tháng 11\s+Năm 2026/);
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
  assert.ok(!ws.getCell(`B${last}`).value, 'không ghi tên máy → ô trống');
  assert.equal(ws.getCell(`C${last}`).value, 'Quấn lại motor\nKiểm tra cách điện');
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

test('người làm cùng: chọn thêm người, hiện trong Excel, người làm cùng chỉ xem', async () => {
  const D = '2026-11-14';
  const long = await makeUser('dh.long', 'Điện');
  const an = await makeUser('nv.an', 'Điện');
  const binh = await makeUser('nv.binh', 'Cơ Khí');
  const ql = await makeUser('ql.cw', 'Điện', 'manager', { teams: ['Điện'] });
  const idAn = await userId('nv.an');
  const idBinh = await userId('nv.binh');
  const idLong = await userId('dh.long');

  // danh sách để chọn: chỉ tài khoản đang hoạt động
  const list = await long.call('list_coworkers');
  assert.equal(list.status, 200);
  assert.ok(list.body.users.some((u) => u.id === idAn && u.full_name === 'NV nv.an'));
  assert.ok(!list.body.users.some((u) => u.full_name === 'Nhân viên chờ'), 'không có tài khoản chưa duyệt/bị khóa');
  assert.equal((await client().call('list_coworkers')).status, 401);

  // kiểm tra dữ liệu
  const bad = (ids) => long.call('add_entry', { p_date: D, p_team: 'Điện', p_entry: entry(D, { coworker_ids: ids }) });
  assert.equal((await bad('abc')).status, 400);
  assert.equal((await bad([999999])).status, 400);
  assert.equal((await bad(Array.from({ length: 11 }, (_, i) => i + 1))).status, 400);

  // thêm dòng có 2 người làm cùng (trùng + tự chọn mình → tự loại)
  const add = await long.call('add_entry', {
    p_date: D, p_team: 'Điện', p_entry: entry(D, { machine: 'Tủ MCC2', coworker_ids: [idBinh, idAn, idAn, idLong] }),
  });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const id = add.body.id;

  const mine = (await long.call('my_entries', { p_date: D })).body.entries[0];
  assert.deepEqual(mine.coworker_ids.sort(), [idAn, idBinh].sort());
  assert.equal(mine.is_owner, true);
  assert.equal(mine.can_edit, true);

  // người làm cùng thấy dòng nhưng không sửa/xóa được
  const seen = (await an.call('my_entries', { p_date: D })).body.entries;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].is_owner, false);
  assert.equal(seen[0].user_name, 'NV dh.long');
  assert.equal(seen[0].can_edit, false);
  assert.equal((await an.call('update_entry', { p_id: id, p_entry: { machine: 'X' } })).status, 403);
  assert.equal((await binh.call('delete_entry', { p_id: id })).status, 403);

  // sửa danh sách người làm cùng → có lịch sử
  assert.equal((await long.call('update_entry', { p_id: id, p_entry: { coworker_ids: [idAn] } })).status, 200);
  assert.equal((await binh.call('my_entries', { p_date: D })).body.entries.length, 0);
  const h = await ql.call('report_history', { p_date: D, p_team: 'Điện' });
  const upd = h.body.items.find((x) => x.action === 'update');
  assert.deepEqual(upd.old_value.coworker_ids.sort(), [idAn, idBinh].sort());
  assert.deepEqual(upd.new_value.coworker_ids, [idAn]);

  // quản lý thấy tên người làm cùng; Excel ghi "Người nhập, Người làm cùng"
  const rep = (await ql.call('reports_of_day', { p_date: D })).body.reports[0];
  assert.deepEqual(rep.entries[0].coworker_names, ['NV nv.an']);
  const ex = await ql.call('report_export', { p_date: D, p_team: 'Điện' });
  assert.equal(ex.status, 200);
  const template = fs.readFileSync(path.join(__dirname, '..', 'web', 'mau_bao_cao.xlsx'));
  const wb = await ExcelExport.buildWorkbook(ExcelJS, template, ex.body);
  assert.equal(wb.worksheets[0].getCell('G7').value, 'NV dh.long, NV nv.an');
});

test('Admin: xem dung lượng và sao lưu toàn bộ dữ liệu ra Excel', async () => {
  const nv = await makeUser('nv.backup', 'PM');
  const ql = await makeUser('ql.backup', 'PM', 'manager', { all: true });

  // chỉ Admin
  assert.equal((await nv.call('admin_storage')).status, 403);
  assert.equal((await ql.call('admin_storage')).status, 403);
  assert.equal((await ql.call('admin_backup')).status, 403);
  assert.equal((await client().call('admin_backup')).status, 401);

  const st = await admin.call('admin_storage');
  assert.equal(st.status, 200);
  assert.ok(st.body.db_bytes > 0);
  assert.equal(st.body.limit_bytes, 500 * 1000 * 1000, '500 MB theo cách tính của Supabase');
  assert.ok(st.body.app_bytes > 0 && st.body.app_bytes < st.body.db_bytes);
  assert.ok(st.body.entries > 0 && st.body.users > 0);

  const bk = await admin.call('admin_backup');
  assert.equal(bk.status, 200);
  const raw = JSON.stringify(bk.body);
  assert.ok(!/password|\$2a\$|token/i.test(raw), 'sao lưu không được chứa mật khẩu/phiên');
  assert.equal(bk.body.entries.length, st.body.entries);
  assert.ok(bk.body.entries.some((e) => e.coworker_names.includes('NV nv.an')));

  const wb = ExcelExport.buildBackupWorkbook(ExcelJS, bk.body);
  const out = new ExcelJS.Workbook();
  await out.xlsx.load(await wb.xlsx.writeBuffer());
  assert.deepEqual(out.worksheets.map((w) => w.name), ['Dòng công việc', 'Báo cáo', 'Tài khoản', 'Lịch sử chỉnh sửa', 'Thông tin']);
  const ws = out.getWorksheet('Dòng công việc');
  assert.equal(ws.getCell('A1').value, 'Ngày');
  assert.equal(ws.rowCount, bk.body.entries.length + 1);
  assert.match(ExcelExport.backupFileName('2026-11-20 08:05:00'), /^SaoLuu_BaoCao_20-11-2026_08h05\.xlsx$/);
});

test('Admin: xóa dữ liệu cũ (bắt buộc sao lưu, gõ XOA, không xóa 15 ngày gần nhất)', async () => {
  const nv = await makeUser('nv.purge', 'Cơ Khí');
  const ql = await makeUser('ql.purge', 'Cơ Khí', 'manager', { all: true });
  const OLD = '2025-12-01';
  const KEEP = '2026-01-05';
  const old1 = await nv.call('add_entry', { p_date: OLD, p_team: 'Cơ Khí', p_entry: entry(OLD, { machine: 'Máy cũ 1' }) });
  await nv.call('add_entry', { p_date: OLD, p_team: 'Cơ Khí', p_entry: entry(OLD, { machine: 'Máy cũ 2' }) });
  await nv.call('update_entry', { p_id: old1.body.id, p_entry: { note: 'sửa' } });
  await nv.call('add_entry', { p_date: KEEP, p_team: 'Cơ Khí', p_entry: entry(KEEP, { machine: 'Máy giữ lại' }) });
  const before = '2026-01-01';

  // chỉ Admin
  for (const fn of ['admin_purge_preview', 'admin_purge_backup', 'admin_purge']) {
    assert.equal((await ql.call(fn, { p_before: before })).status, 403, fn);
  }

  // không cho xóa dữ liệu trong 15 ngày gần nhất
  const { rows } = await mock.db.query('select private.max_purge_before()::text as d, private.vn_today()::text as t');
  const tooRecent = rows[0].t;
  const r0 = await admin.call('admin_purge_preview', { p_before: tooRecent });
  assert.equal(r0.status, 400);
  assert.match(r0.body.message, /15 ngày/);
  assert.equal((await admin.call('admin_purge_preview', { p_before: rows[0].d })).status, 200, 'đúng mốc 15 ngày thì được');

  // xem trước
  const pv = await admin.call('admin_purge_preview', { p_before: before });
  assert.equal(pv.status, 200);
  assert.deepEqual([pv.body.reports, pv.body.entries, pv.body.audit_log], [1, 2, 3]);
  assert.equal(pv.body.first_date, OLD);

  // chưa sao lưu → không xóa được
  let r = await admin.call('admin_purge', { p_before: before, p_ticket: 'a'.repeat(64), p_confirm: 'XOA' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /sao lưu/);

  // sao lưu phần sắp xóa → có phiếu
  const bk = await admin.call('admin_purge_backup', { p_before: before });
  assert.equal(bk.status, 200);
  assert.equal(bk.body.before, before);
  assert.match(bk.body.ticket, /^[0-9a-f]{64}$/);
  assert.deepEqual(bk.body.entries.map((e) => e.machine).sort(), ['Máy cũ 1', 'Máy cũ 2']);
  assert.ok(!/password|\$2a\$/i.test(JSON.stringify(bk.body)));
  const wb = ExcelExport.buildBackupWorkbook(ExcelJS, bk.body);
  assert.equal(wb.getWorksheet('Thông tin').getCell('B3').value, 'Các báo cáo trước ngày 01/01/2026');
  assert.match(ExcelExport.backupFileName(bk.body.generated_at, before), /^SaoLuu_TruocNgay_01-01-2026_/);

  // sai xác nhận / phiếu cho ngày khác → từ chối
  assert.equal((await admin.call('admin_purge', { p_before: before, p_ticket: bk.body.ticket, p_confirm: 'xoa nhầm' })).status, 400);
  assert.equal((await admin.call('admin_purge', { p_before: '2025-12-31', p_ticket: bk.body.ticket, p_confirm: 'XOA' })).status, 400);

  // xóa
  r = await admin.call('admin_purge', { p_before: before, p_ticket: bk.body.ticket, p_confirm: 'XOA' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.reports, r.body.entries, r.body.audit_log], [1, 2, 3]);
  assert.equal((await nv.call('my_entries', { p_date: OLD })).body.entries.length, 0, 'dữ liệu cũ đã bị xóa');
  assert.equal((await nv.call('my_entries', { p_date: KEEP })).body.entries.length, 1, 'dữ liệu sau mốc vẫn còn');
  const left = await mock.db.query(
    "select count(*)::int n from private.audit_log a left join private.reports r on r.id = a.report_id where r.id is null");
  assert.equal(left.rows[0].n, 0, 'không còn lịch sử mồ côi');

  // phiếu đã dùng thì hết hiệu lực; nhật ký lần xóa hiện ở ô dung lượng
  assert.equal((await admin.call('admin_purge', { p_before: before, p_ticket: bk.body.ticket, p_confirm: 'XOA' })).status, 400);
  const st = await admin.call('admin_storage');
  assert.equal(st.body.max_purge_before, rows[0].d);
  assert.equal(st.body.last_purge.reports, 1);
  assert.equal(st.body.last_purge.before, before);
});

test('gửi nhiều công việc một lần: lưu tất cả hoặc không lưu gì, báo đúng công việc lỗi', async () => {
  const D = '2026-11-21';
  const nv = await makeUser('nv.nhieuviec', 'PM');
  const ql = await makeUser('ql.nhieuviec', 'PM', 'manager', { teams: ['PM'] });
  const send = (c, list) => c.call('add_entries', { p_date: D, p_team: 'PM', p_entries: list });

  // công việc thứ 2 thiếu diễn giải → báo "Công việc 2", không lưu công việc nào
  let r = await send(nv, [entry(D, { description: 'Việc A' }), entry(D, { description: '' }), entry(D)]);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /^Công việc 2: .*Diễn giải/);
  assert.equal((await nv.call('my_entries', { p_date: D })).body.entries.length, 0);

  assert.equal((await send(nv, [])).status, 400);
  assert.equal((await send(nv, Array.from({ length: 31 }, () => entry(D)))).status, 400);

  // 3 công việc, có 1 việc làm qua đêm, 1 việc không ghi tên máy
  r = await send(nv, [
    entry(D, { machine: 'Máy nén khí', description: 'Bảo dưỡng định kỳ', start_at: `${D}T08:00`, end_at: `${D}T10:00` }),
    entry(D, { machine: '', description: 'Vệ sinh khu vực', start_at: `${D}T13:00`, end_at: `${D}T14:00` }),
    entry(D, { description: 'Trực sửa máy ca đêm', start_at: `${D}T22:00`, end_at: '2026-11-22T02:00' }),
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.count, 3);
  const mine = (await nv.call('my_entries', { p_date: D })).body.entries;
  assert.equal(mine.length, 3);
  assert.deepEqual(mine.map((e) => e.description).sort(), ['Bảo dưỡng định kỳ', 'Trực sửa máy ca đêm', 'Vệ sinh khu vực']);

  // tất cả nằm chung 1 báo cáo nhóm PM; lịch sử ghi 3 lần tạo
  const hist = await ql.call('report_history', { p_date: D, p_team: 'PM' });
  assert.equal(hist.body.items.filter((h) => h.action === 'create').length, 3);

  // báo cáo đã duyệt → nhân viên không gửi thêm được
  assert.equal((await ql.call('approve_report', { p_date: D, p_team: 'PM' })).status, 200);
  assert.equal((await send(nv, [entry(D)])).status, 403);
  assert.equal((await send(ql, [entry(D, { description: 'Quản lý bổ sung' })])).status, 200);
});

test('ca làm việc: mặc định Hành chính, mỗi ca 1 báo cáo + 1 file Excel riêng, duyệt riêng', async () => {
  const D = '2026-11-23';
  const nv = await makeUser('nv.ca', 'Điện');
  const ql = await makeUser('ql.ca', 'Điện', 'manager', { teams: ['Điện'] });
  const send = (shift, list) => nv.call('add_entries', { p_date: D, p_team: 'Điện', p_shift: shift, p_entries: list });

  assert.equal((await send(undefined, [entry(D, { description: 'Việc hành chính' })])).status, 200);
  assert.equal((await send('Ca 1', [entry(D, { description: 'Việc ca 1 A' }), entry(D, { description: 'Việc ca 1 B' })])).status, 200);
  assert.equal((await send('Ca 3', [entry(D, { description: 'Việc ca 3', start_at: `${D}T22:00`, end_at: '2026-11-24T05:30' })])).status, 200);
  assert.equal((await send('Ca 5', [entry(D)])).status, 400, 'ca không hợp lệ');

  // trang quản lý: 3 báo cáo riêng của nhóm Điện
  const day = await ql.call('reports_of_day', { p_date: D });
  const dien = day.body.reports.filter((r) => r.team === 'Điện');
  assert.deepEqual(dien.map((r) => [r.shift, r.entries.length]), [['Hành chính', 1], ['Ca 1', 2], ['Ca 3', 1]]);

  // duyệt riêng Ca 1 → chỉ khóa Ca 1
  assert.equal((await ql.call('approve_report', { p_date: D, p_team: 'Điện', p_shift: 'Ca 1' })).status, 200);
  assert.equal((await send('Ca 1', [entry(D)])).status, 403);
  assert.equal((await send('Hành chính', [entry(D, { description: 'Thêm việc HC' })])).status, 200);
  const mine = (await nv.call('my_entries', { p_date: D })).body;
  assert.equal(mine.report_statuses['Điện']['Ca 1'], 'approved');
  assert.equal(mine.report_statuses['Điện']['Hành chính'], 'draft');
  assert.ok(mine.entries.every((e) => SHIFTS_OK.includes(e.shift)));

  // xuất Excel Ca 3: ô "Ca:" ghi 3, tên file có Ca3
  const ex = await ql.call('report_export', { p_date: D, p_team: 'Điện', p_shift: 'Ca 3' });
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  assert.equal(ex.body.entries.length, 1);
  assert.equal(ExcelExport.exportFileName(ex.body.team, ex.body.date, ex.body.shift), 'BaoCao_Dien_Ca3_23-11-2026.xlsx');
  const template = fs.readFileSync(path.join(__dirname, '..', 'web', 'mau_bao_cao.xlsx'));
  const built = await ExcelExport.buildWorkbook(ExcelJS, template, ex.body);
  assert.match(built.worksheets[0].getCell('B5').value, /Ca: 3\s+Ngày 23/);

  // đổi ca khi sửa: chuyển dòng HC sang Ca 2
  const hcId = mine.entries.find((e) => e.description === 'Việc hành chính').id;
  assert.equal((await nv.call('update_entry', { p_id: hcId, p_entry: { shift: 'Ca 2' } })).status, 200);
  const ca2 = await ql.call('report_export', { p_date: D, p_team: 'Điện', p_shift: 'Ca 2' });
  assert.deepEqual(ca2.body.entries.map((e) => e.description), ['Việc hành chính']);
  // không chuyển được sang ca đã duyệt
  assert.equal((await nv.call('update_entry', { p_id: hcId, p_entry: { shift: 'Ca 1' } })).status, 403);
  const hist = await ql.call('report_history', { p_date: D, p_team: 'Điện', p_shift: 'Ca 2' });
  assert.ok(hist.body.items.some((h) => h.action === 'update' && h.new_value.shift === 'Ca 2'));

  // lịch tháng: gộp các ca, nhóm Điện chưa duyệt hết
  const month = await ql.call('reports_month', { p_month: '2026-11' });
  assert.equal(month.body.days[D]['Điện'].status, 'draft');
  assert.equal(month.body.days[D]['Điện'].count, 5);
});
const SHIFTS_OK = ['Hành chính', 'Ca 1', 'Ca 2', 'Ca 3'];

test('báo cáo gom theo người gửi: việc của mỗi người thành 1 cụm, không trộn theo giờ', async () => {
  const D = '2026-11-24';
  const a = await makeUser('nv.cumA', 'PM');
  const b = await makeUser('nv.cumB', 'PM');
  const ql = await makeUser('ql.cum', 'PM', 'manager', { teams: ['PM'] });
  const send = (u, list) => u.call('add_entries', { p_date: D, p_team: 'PM', p_entries: list });
  // A gửi trước (8h, 14h), B gửi sau (10h, thiếu giờ kết thúc), A gửi thêm 7h
  assert.equal((await send(a, [entry(D, { description: 'A1', start_at: `${D}T08:00` }), entry(D, { description: 'A2', start_at: `${D}T14:00`, end_at: `${D}T15:00` })])).status, 200);
  assert.equal((await send(b, [entry(D, { description: 'B1', start_at: `${D}T10:00`, end_at: null })])).status, 200);
  assert.equal((await send(a, [entry(D, { description: 'A0', start_at: `${D}T07:00`, end_at: `${D}T07:30` })])).status, 200);

  const day = await ql.call('reports_of_day', { p_date: D });
  const rep = day.body.reports.find((r) => r.team === 'PM');
  assert.deepEqual(rep.entries.map((e) => e.description), ['A0', 'A1', 'A2', 'B1'], 'cụm A (theo giờ) rồi tới cụm B');
  // số dòng trong cảnh báo thiếu khớp vị trí trong bảng / file Excel
  assert.deepEqual(rep.missing.map((m) => [m.row, m.user_name]), [[4, rep.entries[3].user_name]]);
});
