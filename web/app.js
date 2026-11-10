'use strict';
/* =============== Báo cáo công việc hàng ngày – giao diện =============== */
const TEAMS = ['Điện', 'Cơ Khí', 'PM'];
const TEAM_CLASS = { 'Điện': 'dien', 'Cơ Khí': 'cokhi', PM: 'pm' };
const ROLE_LABEL = { admin: 'Admin', manager: 'Quản lý', staff: 'Nhân viên' };
const STATUS_LABEL = { pending: 'Chờ duyệt', active: 'Hoạt động', rejected: 'Bị từ chối', locked: 'Đã khóa' };
const FIELD_LABEL = { machine: 'Tên máy', description: 'Diễn giải', start_at: 'Bắt đầu', end_at: 'Kết thúc', completion: 'Trạng thái', note: 'Tình trạng máy / Ghi chú' };

const state = { user: null, date: today(), team: null, mgrDate: today(), mgrMonth: today().slice(0, 7), adminTab: 'pending' };

/* ---------- Tiện ích ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = () => $('#view');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function pad(n) { return String(n).padStart(2, '0'); }
function today() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function nowHM() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function dmy(date) { const [y, m, d] = date.split('-'); return `${d}/${m}/${y}`; }
function weekday(date) {
  const names = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
  const [y, m, d] = date.split('-').map(Number);
  return names[new Date(y, m - 1, d).getDay()];
}
/** Hiển thị giờ, thêm ngày nếu khác ngày báo cáo */
function fmtTime(dt, reportDate) {
  if (!dt) return '';
  const [d, t] = dt.split('T');
  if (d === reportDate) return t;
  const [, m, dd] = d.split('-');
  return `${t} (${dd}/${m})`;
}
function completionBadge(c) {
  return c >= 100 ? '<span class="badge badge-ok">OK</span>' : `<span class="badge badge-warn">${c}%</span>`;
}
function reportBadge(status) {
  return status === 'approved' ? '<span class="badge badge-ok">✓ Đã phê duyệt</span>' : '<span class="badge badge-info">Đang nhập</span>';
}
function teamTag(t) { return `<span class="team-tag t-${TEAM_CLASS[t]}">${esc(t)}</span>`; }

/* ---------- Kết nối Supabase (gọi hàm API qua /rest/v1/rpc) ---------- */
const CFG = window.APP_CONFIG || {};
const TOKEN_KEY = 'bc_token';
function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* bỏ qua */ } }

/** Gọi hàm API. withToken = true → tự gửi token phiên đăng nhập */
async function rpc(fn, args = {}, withToken = true) {
  const key = CFG.SUPABASE_KEY || '';
  const headers = { 'Content-Type': 'application/json', apikey: key };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`; // khóa anon dạng JWT (cũ)
  const body = withToken ? { p_token: getToken(), ...args } : args;
  let res;
  try {
    res = await fetch(`${String(CFG.SUPABASE_URL).replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.message) || `Lỗi ${res.status}`);
    err.status = res.status;
    try { err.details = data && data.details ? JSON.parse(data.details) : null; } catch { err.details = null; }
    if (res.status === 401 && withToken && state.user) { state.user = null; setToken(null); go('#/dang-nhap'); }
    throw err;
  }
  return data;
}

/** Tải ExcelJS khi cần (file lớn ~1MB, chỉ tải lúc xuất Excel) */
let excelJsPromise;
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  excelJsPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/exceljs.min.js';
    s.onload = () => resolve(window.ExcelJS);
    s.onerror = () => { excelJsPromise = null; reject(new Error('Không tải được thư viện Excel.')); };
    document.head.appendChild(s);
  });
  return excelJsPromise;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 5000 : 2800);
}

function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }

/* ---------- Hộp thoại ---------- */
const dlg = () => $('#dlg');
function openDialog(title, bodyHTML, footHTML = '', wide = false) {
  const d = dlg();
  d.className = 'dlg' + (wide ? ' wide' : '');
  d.innerHTML = `
    <div class="dlg-head"><h2>${esc(title)}</h2><button class="x" data-close aria-label="Đóng">×</button></div>
    <div class="dlg-body">${bodyHTML}</div>
    ${footHTML ? `<div class="dlg-foot">${footHTML}</div>` : ''}`;
  d.showModal();
  return d;
}
function closeDialog() { if (dlg().open) dlg().close(); }
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeDialog();
});

function confirmDialog(title, message, okLabel = 'Đồng ý', danger = false) {
  return new Promise((resolve) => {
    const d = openDialog(title, `<p class="pre">${esc(message)}</p>`,
      `<button class="btn btn-ghost" data-close>Hủy</button><button class="btn ${danger ? 'btn-danger' : ''}" id="dlg-ok">${esc(okLabel)}</button>`);
    let done = false;
    $('#dlg-ok', d).onclick = () => { done = true; closeDialog(); resolve(true); };
    d.addEventListener('close', () => { if (!done) resolve(false); }, { once: true });
  });
}

/* ---------- Form dòng công việc (dùng chung) ---------- */
function entryFormHTML(e, date) {
  const c = e ? e.completion : 100;
  const done = c >= 100;
  const start = e ? e.start_at || '' : `${date}T${date === today() ? nowHM() : '07:30'}`;
  return `
    <div class="stack">
      <label class="field"><span>Tên máy <span class="req">*</span></span>
        <input name="machine" required maxlength="200" autocomplete="off" placeholder="VD: Máy ép viên số 2" value="${esc(e?.machine)}"></label>
      <label class="field"><span>Diễn giải công việc</span>
        <textarea name="description" rows="3" maxlength="4000" placeholder="Mô tả công việc đã làm...">${esc(e?.description)}</textarea></label>
      <div class="field-row">
        <label class="field"><span>Thời gian bắt đầu</span>
          <input type="datetime-local" name="start_at" value="${esc(start)}"></label>
        <label class="field"><span>Thời gian kết thúc</span>
          <input type="datetime-local" name="end_at" value="${esc(e?.end_at || '')}"></label>
      </div>
      <p class="hint">Có thể chọn giờ kết thúc sang ngày hôm sau nếu làm qua đêm.</p>
      <div class="field"><span>Trạng thái hoàn thành</span>
        <div>
          <div class="seg" role="group" aria-label="Trạng thái hoàn thành">
            <button type="button" data-done="1" class="${done ? 'on-ok' : ''}">✓ OK</button>
            <button type="button" data-done="0" class="${done ? '' : 'on-warn'}">Chưa xong</button>
          </div>
          <div class="pct" data-pct ${done ? 'hidden' : ''}>
            <input type="number" name="pct" min="0" max="99" step="1" inputmode="numeric" value="${done ? '' : c}" aria-label="Phần trăm hoàn thành">
            <span>%</span>
            ${[25, 50, 75, 90].map((p) => `<button type="button" class="chip" data-chip="${p}">${p}%</button>`).join('')}
          </div>
        </div>
      </div>
      <label class="field"><span>Tình trạng máy / Ghi chú</span>
        <textarea name="note" rows="2" maxlength="4000" placeholder="VD: Máy hoạt động bình thường">${esc(e?.note)}</textarea></label>
      <div class="form-error" data-err hidden></div>
    </div>`;
}

function bindEntryForm(root) {
  const pctBox = $('[data-pct]', root);
  $$('[data-done]', root).forEach((b) =>
    b.addEventListener('click', () => {
      const ok = b.dataset.done === '1';
      $('[data-done="1"]', root).className = ok ? 'on-ok' : '';
      $('[data-done="0"]', root).className = ok ? '' : 'on-warn';
      pctBox.hidden = ok;
      if (!ok) { const i = $('[name=pct]', root); if (i.value === '') i.value = 50; i.focus(); }
    })
  );
  $$('[data-chip]', root).forEach((b) => b.addEventListener('click', () => { $('[name=pct]', root).value = b.dataset.chip; }));
}

/** Đọc & kiểm tra dữ liệu form phía trình duyệt */
function readEntryForm(root) {
  const val = (n) => $(`[name=${n}]`, root).value;
  const data = {
    machine: val('machine').trim(),
    description: val('description').trim(),
    start_at: val('start_at') || '',
    end_at: val('end_at') || '',
    note: val('note').trim(),
  };
  const errs = [];
  if (!data.machine) errs.push('Vui lòng nhập Tên máy.');
  const notDone = !$('[data-pct]', root).hidden;
  if (notDone) {
    const p = val('pct').trim();
    if (!/^\d{1,2}$/.test(p) || Number(p) > 99) errs.push('Phần trăm hoàn thành phải là số nguyên từ 0 đến 99.');
    data.completion = `${p}%`;
  } else data.completion = 'OK';
  // datetime-local có thể trả về giây → cắt về HH:mm
  data.start_at = data.start_at.slice(0, 16);
  data.end_at = data.end_at.slice(0, 16);
  if (data.start_at && data.end_at && data.end_at < data.start_at) errs.push('Thời gian kết thúc phải sau thời gian bắt đầu.');
  return { data, errs };
}

function showFormError(root, msg, list) {
  const box = $('[data-err]', root);
  box.innerHTML = esc(msg) + (list && list.length ? `<ul>${list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  box.hidden = false;
}

/** Hộp thoại sửa 1 dòng */
function editEntryDialog(entry, reportDate, onSaved) {
  const d = openDialog('Sửa dòng công việc', `<form id="edit-form" novalidate>${entryFormHTML(entry, reportDate)}</form>`,
    `<button class="btn btn-ghost" data-close>Hủy</button><button class="btn" form="edit-form" type="submit">Lưu thay đổi</button>`);
  const form = $('#edit-form', d);
  bindEntryForm(form);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const { data, errs } = readEntryForm(form);
    if (errs.length) return showFormError(form, errs[0]);
    try {
      await rpc('update_entry', { p_id: entry.id, p_entry: data });
      closeDialog();
      toast('Đã lưu thay đổi.');
      onSaved();
    } catch (err) { showFormError(form, err.message); }
  });
}

async function deleteEntry(entry, onDone) {
  const ok = await confirmDialog('Xóa dòng công việc', `Xóa dòng "${entry.machine}"? Thao tác này không hoàn tác được.`, 'Xóa', true);
  if (!ok) return;
  try { await rpc('delete_entry', { p_id: entry.id }); toast('Đã xóa.'); onDone(); }
  catch (err) { toast(err.message, true); }
}

/* ---------- Thanh điều hướng ---------- */
function renderTopbar(active) {
  const u = state.user;
  const bar = $('#topbar');
  if (!u) { bar.hidden = true; return; }
  const links = [['#/nhap', 'Nhập báo cáo']];
  if (u.role === 'admin' || u.role === 'manager') links.push(['#/quan-ly', 'Quản lý báo cáo']);
  if (u.role === 'admin') links.push(['#/quan-tri', 'Quản trị tài khoản']);
  links.push(['#/tai-khoan', 'Tài khoản']);
  bar.innerHTML = `
    <div class="topbar-inner">
      <div class="brand"><span class="brand-mark">BC</span><div>Báo cáo công việc<small>Phòng Kỹ thuật</small></div></div>
      <nav class="nav">${links.map(([h, l]) => `<a href="${h}" class="${h === active ? 'active' : ''}">${l}</a>`).join('')}</nav>
      <div class="userbox">
        <div class="who">${esc(u.full_name)}<small>${ROLE_LABEL[u.role]}${u.team ? ' · ' + esc(u.team) : ''}</small></div>
        <button class="btn btn-ghost btn-sm" id="logout">Đăng xuất</button>
      </div>
    </div>`;
  bar.hidden = false;
  $('#logout').onclick = async () => {
    await rpc('logout').catch(() => {});
    setToken(null);
    state.user = null;
    go('#/dang-nhap');
  };
}

/* ---------- Đăng nhập / Đăng ký ---------- */
function authShell(inner) {
  return `
    <div class="auth">
      <div class="auth-hero">
        <img src="img/hero.webp" alt="Khu silo nhà máy lúc hoàng hôn">
        <div class="caption">
          <h1>Báo cáo công việc hàng ngày</h1>
          <p>Phòng Kỹ thuật · Nhập, tổng hợp và phê duyệt báo cáo sửa chữa của nhóm Điện, Cơ Khí và PM.</p>
        </div>
      </div>
      <div class="auth-panel"><div class="auth-box">${inner}</div></div>
    </div>`;
}

function renderLogin() {
  $('#topbar').hidden = true;
  view().className = '';
  view().innerHTML = authShell(`
    <h2>Đăng nhập</h2>
    <p class="muted">Dùng tài khoản đã được Admin duyệt.</p>
    <form id="login" class="stack" novalidate>
      <label class="field"><span>Tên đăng nhập</span><input name="username" autocomplete="username" autocapitalize="off" required></label>
      <label class="field"><span>Mật khẩu</span><input name="password" type="password" autocomplete="current-password" required></label>
      <div class="form-error" data-err hidden></div>
      <button class="btn btn-block" type="submit">Đăng nhập</button>
    </form>
    <p class="auth-switch">Chưa có tài khoản? <a href="#/dang-ky">Đăng ký</a></p>`);
  const f = $('#login');
  $('[name=username]', f).focus();
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const username = f.username.value.trim();
    const password = f.password.value;
    if (!username || !password) return showFormError(f, 'Vui lòng nhập tên đăng nhập và mật khẩu.');
    const btn = $('button[type=submit]', f);
    btn.disabled = true;
    try {
      const r = await rpc('login', { p_username: username, p_password: password }, false);
      if (!r.ok) return showFormError(f, r.error);
      setToken(r.token);
      state.user = r.user;
      state.team = r.user.team || TEAMS[0];
      go(r.user.role === 'staff' ? '#/nhap' : '#/quan-ly');
    } catch (err) { showFormError(f, err.message); }
    finally { btn.disabled = false; }
  });
}

function renderRegister() {
  $('#topbar').hidden = true;
  view().className = '';
  view().innerHTML = authShell(`
    <h2>Đăng ký tài khoản</h2>
    <p class="muted">Tài khoản mới cần Admin duyệt trước khi sử dụng.</p>
    <form id="reg" class="stack" novalidate>
      <label class="field"><span>Họ và tên</span><input name="full_name" autocomplete="name" required maxlength="100"></label>
      <label class="field"><span>Tên đăng nhập</span><input name="username" autocomplete="username" autocapitalize="off" required maxlength="32">
        <span class="hint">3–32 ký tự: chữ không dấu, số, dấu chấm, gạch dưới.</span></label>
      <label class="field"><span>Mật khẩu</span><input name="password" type="password" autocomplete="new-password" required>
        <span class="hint">Ít nhất 8 ký tự, có cả chữ và số.</span></label>
      <label class="field"><span>Nhập lại mật khẩu</span><input name="password2" type="password" autocomplete="new-password" required></label>
      <label class="field"><span>Nhóm</span>
        <select name="team" required><option value="">— Chọn nhóm —</option>${TEAMS.map((t) => `<option>${t}</option>`).join('')}</select></label>
      <div class="form-error" data-err hidden></div>
      <div class="form-ok" data-ok hidden></div>
      <button class="btn btn-block" type="submit">Đăng ký</button>
    </form>
    <p class="auth-switch">Đã có tài khoản? <a href="#/dang-nhap">Đăng nhập</a></p>`);
  const f = $('#reg');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('[data-err]', f).hidden = true;
    const d = { full_name: f.full_name.value.trim(), username: f.username.value.trim(), password: f.password.value, team: f.team.value };
    if (d.full_name.length < 2) return showFormError(f, 'Vui lòng nhập họ tên.');
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(d.username)) return showFormError(f, 'Tên đăng nhập 3–32 ký tự, chỉ gồm chữ không dấu, số, dấu chấm, gạch dưới, gạch ngang.');
    if (d.password.length < 8 || !/[A-Za-z]/.test(d.password) || !/\d/.test(d.password)) return showFormError(f, 'Mật khẩu phải có ít nhất 8 ký tự, gồm cả chữ và số.');
    if (d.password !== f.password2.value) return showFormError(f, 'Mật khẩu nhập lại không khớp.');
    if (!d.team) return showFormError(f, 'Vui lòng chọn nhóm.');
    try {
      const r = await rpc('register', { p_username: d.username, p_full_name: d.full_name, p_password: d.password, p_team: d.team }, false);
      f.reset();
      const ok = $('[data-ok]', f);
      ok.textContent = r.message;
      ok.hidden = false;
    } catch (err) { showFormError(f, err.message); }
  });
}

/* ---------- Trang nhập báo cáo (nhân viên) ---------- */
async function renderEntry() {
  renderTopbar('#/nhap');
  view().className = 'view';
  if (!state.team) state.team = state.user.team || TEAMS[0];
  view().innerHTML = `
    <div class="page-head">
      <div><h1>Nhập báo cáo công việc</h1><p class="muted">Các dòng bạn nhập được gom vào báo cáo tổng hợp của nhóm trong ngày.</p></div>
    </div>
    <div class="grid-2">
      <section class="card sticky-side">
        <div class="field-row">
          <label class="field"><span>Ngày báo cáo</span><input type="date" id="f-date" value="${state.date}" required></label>
          <label class="field"><span>Nhóm</span><select id="f-team">${TEAMS.map((t) => `<option ${t === state.team ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        </div>
        <div id="lock-note" class="notice notice-ok" hidden></div>
        <form id="add-form" novalidate class="stack">
          <div id="add-fields"></div>
          <button class="btn btn-block" type="submit">+ Thêm dòng công việc</button>
        </form>
      </section>
      <section>
        <div class="row-between"><h2 id="list-title"></h2><span class="muted small" id="list-count"></span></div>
        <div id="my-list" class="stack"><div class="loading">Đang tải…</div></div>
      </section>
    </div>`;

  const form = $('#add-form');
  const resetForm = () => { $('#add-fields').innerHTML = entryFormHTML(null, state.date); bindEntryForm(form); };
  resetForm();

  $('#f-date').addEventListener('change', (e) => {
    if (!e.target.value) return;
    state.date = e.target.value;
    resetForm();
    loadMine();
  });
  $('#f-team').addEventListener('change', (e) => { state.team = e.target.value; loadMine(); });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('[data-err]', form).hidden = true;
    const { data, errs } = readEntryForm(form);
    if (errs.length) return showFormError(form, errs[0]);
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      await rpc('add_entry', { p_date: state.date, p_team: state.team, p_entry: data });
      toast('Đã thêm dòng công việc.');
      resetForm();
      $('[name=machine]', form).focus();
      loadMine();
    } catch (err) { showFormError(form, err.message); }
    finally { btn.disabled = false; }
  });

  loadMine();
}

async function loadMine() {
  const list = $('#my-list');
  if (!list) return;
  $('#list-title').textContent = `Dòng của tôi · ${weekday(state.date)}, ${dmy(state.date)}`;
  let r;
  try { r = await rpc('my_entries', { p_date: state.date }); }
  catch (err) { list.innerHTML = `<div class="form-error">${esc(err.message)}</div>`; return; }

  // Báo cáo nhóm đang chọn đã duyệt? (quản lý của nhóm vẫn thêm được)
  const approved = r.report_status[state.team] === 'approved';
  const canManage = state.user.viewable_teams.includes(state.team);
  const note = $('#lock-note');
  note.hidden = !approved;
  note.innerHTML = approved ? `🔒 Báo cáo nhóm ${esc(state.team)} ngày ${dmy(state.date)} đã được phê duyệt.${canManage ? ' Bạn có quyền quản lý nên vẫn sửa được (sẽ ghi lịch sử).' : ' Không thể thêm hoặc sửa nữa.'}` : '';
  $('#add-form button[type=submit]').disabled = approved && !canManage;

  $('#list-count').textContent = r.entries.length ? `${r.entries.length} dòng` : '';
  if (!r.entries.length) {
    list.innerHTML = '<div class="empty">Chưa có dòng công việc nào trong ngày này.</div>';
    return;
  }
  list.innerHTML = r.entries.map((e) => `
    <article class="entry e-${TEAM_CLASS[e.team]}" data-id="${e.id}">
      <div class="entry-head">
        <div class="row"><span class="entry-machine">${esc(e.machine)}</span>${teamTag(e.team)}</div>
        <div class="row">${completionBadge(e.completion)}${r.report_status[e.team] === 'approved' ? '<span class="badge badge-muted">🔒 Đã duyệt</span>' : ''}</div>
      </div>
      <div class="entry-time">${e.start_at ? esc(fmtTime(e.start_at, state.date)) : '—'} → ${e.end_at ? esc(fmtTime(e.end_at, state.date)) : '<span class="miss">chưa nhập giờ kết thúc</span>'}</div>
      ${e.description ? `<div class="entry-body pre">${esc(e.description)}</div>` : '<div class="entry-body muted small">Chưa có diễn giải</div>'}
      ${e.note ? `<div class="entry-note pre">📝 ${esc(e.note)}</div>` : ''}
      ${e.can_edit ? `<div class="entry-actions"><button class="btn btn-ghost btn-sm" data-edit>Sửa</button><button class="btn btn-danger btn-sm" data-del>Xóa</button></div>` : ''}
    </article>`).join('');
  const byId = Object.fromEntries(r.entries.map((e) => [e.id, e]));
  $$('.entry', list).forEach((el) => {
    const e = byId[el.dataset.id];
    const ed = $('[data-edit]', el);
    if (ed) ed.onclick = () => editEntryDialog(e, state.date, loadMine);
    const del = $('[data-del]', el);
    if (del) del.onclick = () => deleteEntry(e, loadMine);
  });
}

/* ---------- Trang quản lý báo cáo ---------- */
async function renderManager() {
  renderTopbar('#/quan-ly');
  view().className = 'view';
  view().innerHTML = `
    <div class="page-head">
      <div><h1>Quản lý báo cáo</h1><p class="muted">Mỗi ngày có 3 báo cáo tổng hợp: Điện, Cơ Khí, PM.</p></div>
    </div>
    <div class="mgr">
      <aside class="card sticky-side">
        <div class="cal-head">
          <button class="btn btn-ghost btn-sm" id="cal-prev" aria-label="Tháng trước">‹</button>
          <strong id="cal-title"></strong>
          <button class="btn btn-ghost btn-sm" id="cal-next" aria-label="Tháng sau">›</button>
        </div>
        <div class="cal" id="cal"></div>
        <div class="legend"><span><i class="dot d-warn"></i>Đang nhập</span><span><i class="dot d-ok"></i>Đã phê duyệt</span></div>
        <div class="row legend" id="cal-today-row"><button class="btn btn-ghost btn-sm" id="cal-today">Hôm nay</button>
          <input type="date" id="mgr-date" value="${state.mgrDate}" aria-label="Chọn ngày"></div>
      </aside>
      <section id="reports" class="stack"><div class="loading">Đang tải…</div></section>
    </div>`;
  const shiftMonth = (n) => {
    const [y, m] = state.mgrMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    state.mgrMonth = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    loadCalendar();
  };
  $('#cal-prev').onclick = () => shiftMonth(-1);
  $('#cal-next').onclick = () => shiftMonth(1);
  $('#cal-today').onclick = () => selectDay(today());
  $('#mgr-date').addEventListener('change', (e) => e.target.value && selectDay(e.target.value));
  loadCalendar();
  loadReports();
}

function selectDay(date) {
  state.mgrDate = date;
  state.mgrMonth = date.slice(0, 7);
  const inp = $('#mgr-date');
  if (inp) inp.value = date;
  loadCalendar();
  loadReports();
}

async function loadCalendar() {
  const cal = $('#cal');
  if (!cal) return;
  const [y, m] = state.mgrMonth.split('-').map(Number);
  $('#cal-title').textContent = `Tháng ${m}/${y}`;
  let days = {};
  try { days = (await rpc('reports_month', { p_month: state.mgrMonth })).days; } catch { /* bỏ qua */ }
  const first = new Date(y, m - 1, 1);
  const offset = (first.getDay() + 6) % 7; // tuần bắt đầu thứ hai
  const start = new Date(y, m - 1, 1 - offset);
  let html = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map((d) => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const ds = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const info = days[ds] || {};
    const dots = TEAMS.filter((t) => info[t]).map((t) => `<i class="dot ${info[t].status === 'approved' ? 'd-ok' : 'd-warn'}" title="${t}"></i>`).join('');
    const cls = [d.getMonth() !== m - 1 ? 'out' : '', ds === today() ? 'today' : '', ds === state.mgrDate ? 'sel' : ''].join(' ');
    html += `<button class="${cls}" data-day="${ds}" aria-label="${dmy(ds)}">${d.getDate()}<span class="dots">${dots}</span></button>`;
  }
  cal.innerHTML = html;
  $$('[data-day]', cal).forEach((b) => (b.onclick = () => selectDay(b.dataset.day)));
}

async function loadReports() {
  const box = $('#reports');
  if (!box) return;
  let r;
  try { r = await rpc('reports_of_day', { p_date: state.mgrDate }); }
  catch (err) { box.innerHTML = `<div class="form-error">${esc(err.message)}</div>`; return; }
  const isAdmin = state.user.role === 'admin';
  box.innerHTML = `<h2>${weekday(state.mgrDate)}, ${dmy(state.mgrDate)}</h2>` + r.reports.map((rep) => {
    const missByEntry = Object.fromEntries(rep.missing.map((m) => [m.entry_id, m.fields]));
    const approved = rep.status === 'approved';
    return `
    <section class="card report-card r-${TEAM_CLASS[rep.team]}" data-team="${esc(rep.team)}">
      <div class="report-head">
        <div>
          <div class="report-title"><h2>Báo cáo nhóm ${esc(rep.team)}</h2>${reportBadge(rep.status)}</div>
          <div class="report-meta">${rep.entries.length} dòng công việc${approved && rep.approved_by_name ? ` · Duyệt bởi ${esc(rep.approved_by_name)} lúc ${esc(rep.approved_at)}` : ''}</div>
        </div>
        <div class="report-actions">
          ${!approved && rep.entries.length ? '<button class="btn btn-sm" data-act="approve">✓ Phê duyệt</button>' : ''}
          ${approved && isAdmin ? '<button class="btn btn-ghost btn-sm" data-act="unapprove">Hủy phê duyệt</button>' : ''}
          ${rep.entries.length ? '<button class="btn btn-accent btn-sm" data-act="export">⬇ Xuất Excel</button>' : ''}
          <button class="btn btn-ghost btn-sm" data-act="history">Lịch sử</button>
        </div>
      </div>
      ${rep.missing.length ? `<div class="notice notice-warn missing">⚠ ${rep.missing.length} dòng còn thiếu thông tin, cần bổ sung trước khi xuất Excel (đánh dấu màu cam bên dưới).</div>` : ''}
      ${rep.entries.length ? `
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>#</th><th>Tên máy</th><th>Diễn giải công việc</th><th>Bắt đầu</th><th>Kết thúc</th><th>Trạng thái</th><th>Tình trạng / Ghi chú</th><th>Người thực hiện</th><th></th></tr></thead>
        <tbody>${rep.entries.map((e, i) => {
          const miss = missByEntry[e.id] || [];
          const m = (label, v) => (miss.includes(label) ? '<span class="miss">thiếu</span>' : v);
          return `<tr class="${miss.length ? 'row-missing' : ''}" data-id="${e.id}">
            <td data-label="#" class="num">${i + 1}</td>
            <td data-label="Tên máy" class="w-machine"><strong>${esc(e.machine)}</strong></td>
            <td data-label="Diễn giải" class="w-desc pre">${m('Diễn giải công việc', esc(e.description))}</td>
            <td data-label="Bắt đầu" class="num">${m('Thời gian bắt đầu', esc(fmtTime(e.start_at, rep.date)))}</td>
            <td data-label="Kết thúc" class="num">${m('Thời gian kết thúc', esc(fmtTime(e.end_at, rep.date)))}</td>
            <td data-label="Trạng thái">${completionBadge(e.completion)}</td>
            <td data-label="Ghi chú" class="w-note pre">${esc(e.note)}</td>
            <td data-label="Người thực hiện" class="nowrap">${esc(e.user_name)}</td>
            <td class="no-label nowrap">${e.can_edit ? '<button class="btn btn-ghost btn-sm" data-edit>Sửa</button> <button class="btn btn-danger btn-sm" data-del>Xóa</button>' : ''}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : '<div class="empty">Chưa có dòng công việc nào.</div>'}
    </section>`;
  }).join('');

  const byTeam = Object.fromEntries(r.reports.map((rep) => [rep.team, rep]));
  $$('.report-card', box).forEach((card) => {
    const rep = byTeam[card.dataset.team];
    const refresh = () => { loadReports(); loadCalendar(); };
    $$('[data-act]', card).forEach((b) => (b.onclick = () => reportAction(b.dataset.act, rep, refresh)));
    const byId = Object.fromEntries(rep.entries.map((e) => [e.id, e]));
    $$('tr[data-id]', card).forEach((tr) => {
      const e = byId[tr.dataset.id];
      const ed = $('[data-edit]', tr);
      if (ed) ed.onclick = () => {
        if (rep.status === 'approved') toast('Báo cáo đã phê duyệt: thay đổi sẽ được ghi vào lịch sử.');
        editEntryDialog(e, rep.date, refresh);
      };
      const del = $('[data-del]', tr);
      if (del) del.onclick = () => deleteEntry(e, refresh);
    });
  });
}

async function reportAction(act, rep, refresh) {
  const body = { p_date: rep.date, p_team: rep.team };
  try {
    if (act === 'approve') {
      const msg = `Phê duyệt báo cáo nhóm ${rep.team} ngày ${dmy(rep.date)}?\nSau khi duyệt, nhân viên không thể sửa hoặc xóa dòng của mình.` +
        (rep.missing.length ? `\n\nLưu ý: còn ${rep.missing.length} dòng thiếu thông tin.` : '');
      if (!(await confirmDialog('Phê duyệt báo cáo', msg, 'Phê duyệt'))) return;
      toast((await rpc('approve_report', body)).message);
      refresh();
    } else if (act === 'unapprove') {
      if (!(await confirmDialog('Hủy phê duyệt', `Mở lại báo cáo nhóm ${rep.team} ngày ${dmy(rep.date)} cho nhân viên sửa?`, 'Hủy phê duyệt', true))) return;
      toast((await rpc('unapprove_report', body)).message);
      refresh();
    } else if (act === 'export') {
      await exportExcel(rep);
    } else if (act === 'history') {
      await showHistory(rep);
    }
  } catch (err) { toast(err.message, true); }
}

async function exportExcel(rep) {
  // Máy chủ kiểm tra quyền + độ đầy đủ rồi mới trả dữ liệu
  let data;
  try {
    data = await rpc('report_export', { p_date: rep.date, p_team: rep.team });
  } catch (err) {
    if (Array.isArray(err.details) && err.details.length) {
      openDialog('Chưa thể xuất Excel', `
        <p>${esc(err.message)}</p>
        <div class="form-error"><ul>${err.details.map((d) =>
          `<li><strong>Dòng ${d.row}</strong> (${esc(d.machine || 'chưa có tên máy')} – ${esc(d.user_name)}): thiếu ${d.fields.map(esc).join(', ')}</li>`).join('')}</ul></div>`,
        '<button class="btn" data-close>Đã hiểu</button>');
      return;
    }
    throw err;
  }
  toast('Đang tạo file Excel…');
  const [ExcelJS, template] = await Promise.all([
    loadExcelJS(),
    fetch('mau_bao_cao.xlsx', { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error('Không tải được file mẫu mau_bao_cao.xlsx.');
      return r.arrayBuffer();
    }),
  ]);
  const wb = await window.ExcelExport.buildWorkbook(ExcelJS, template, data);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const name = window.ExcelExport.exportFileName(data.team, data.date);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`Đã tải ${name}`);
}

const ACTION_LABEL = { create: 'Thêm dòng', update: 'Sửa dòng', delete: 'Xóa dòng', approve: 'Phê duyệt báo cáo', unapprove: 'Hủy phê duyệt' };
function fmtVal(k, v) {
  if (v === null || v === undefined || v === '') return '(trống)';
  if (k === 'completion') return v >= 100 ? 'OK' : `${v}%`;
  if (k === 'start_at' || k === 'end_at') return v.replace('T', ' ');
  return v;
}
async function showHistory(rep) {
  const r = await rpc('report_history', { p_date: rep.date, p_team: rep.team });
  const body = r.items.length ? r.items.map((h) => {
    const keys = Object.keys(h.new_value || h.old_value || {});
    const diff = h.action === 'update'
      ? `<div class="hist-diff">${keys.map((k) => `<div class="k">${FIELD_LABEL[k] || k}</div><div class="old pre">${esc(fmtVal(k, h.old_value[k]))}</div><div class="new pre">${esc(fmtVal(k, h.new_value[k]))}</div>`).join('')}</div>`
      : (h.action === 'create' || h.action === 'delete')
        ? `<div class="small muted">Tên máy: ${esc((h.new_value || h.old_value).machine)}</div>` : '';
    return `<div class="hist-item">
      <div class="row-between"><div class="row"><strong>${ACTION_LABEL[h.action] || h.action}</strong>${h.after_approval ? '<span class="badge badge-warn">Sau phê duyệt</span>' : ''}</div>
      <span class="small muted">${esc(h.created_at)}</span></div>
      <div class="small">Người thực hiện: ${esc(h.user_name)}</div>${diff}</div>`;
  }).join('') : '<div class="empty">Chưa có lịch sử.</div>';
  openDialog(`Lịch sử · ${rep.team} · ${dmy(rep.date)}`, body, '<button class="btn" data-close>Đóng</button>', true);
}

/* ---------- Trang quản trị tài khoản (Admin) ---------- */
async function renderAdmin() {
  renderTopbar('#/quan-tri');
  view().className = 'view';
  view().innerHTML = `
    <div class="page-head"><div><h1>Quản trị tài khoản</h1><p class="muted">Duyệt đăng ký, phân quyền, khóa tài khoản và đặt lại mật khẩu.</p></div></div>
    <div class="tabs" id="tabs"></div>
    <section class="card" id="users"><div class="loading">Đang tải…</div></section>`;
  loadUsers();
}

async function loadUsers() {
  let users;
  try { users = (await rpc('admin_list_users')).users; }
  catch (err) { $('#users').innerHTML = `<div class="form-error">${esc(err.message)}</div>`; return; }
  const pending = users.filter((u) => u.status === 'pending');
  const tabs = [['pending', 'Chờ duyệt', pending.length], ['active', 'Đang hoạt động'], ['locked', 'Đã khóa'], ['rejected', 'Bị từ chối']];
  $('#tabs').innerHTML = tabs.map(([k, l, n]) => `<button data-tab="${k}" class="${state.adminTab === k ? 'on' : ''}">${l}${n ? `<span class="count">${n}</span>` : ''}</button>`).join('');
  $$('[data-tab]').forEach((b) => (b.onclick = () => { state.adminTab = b.dataset.tab; loadUsers(); }));

  const list = users.filter((u) => u.status === state.adminTab);
  const box = $('#users');
  if (!list.length) { box.innerHTML = '<div class="empty">Không có tài khoản nào.</div>'; return; }

  box.innerHTML = list.map((u) => {
    const isAdmin = u.role === 'admin';
    const scopeAll = !!u.manager_all;
    const scopes = u.manager_teams || [];
    const head = `<div><div class="name">${esc(u.full_name)} ${isAdmin ? '<span class="badge badge-info">Admin</span>' : ''}</div>
      <div class="small muted">@${esc(u.username)} · đăng ký ${esc(u.created_at)}</div></div>`;
    if (u.status === 'pending' || u.status === 'rejected') {
      return `<div class="user-row" data-id="${u.id}">${head}
        <div class="small">Nhóm: ${u.team ? teamTag(u.team) : '—'}</div><div></div><div></div>
        <div class="user-actions"><button class="btn btn-sm" data-a="approve">Duyệt</button>${u.status === 'pending' ? '<button class="btn btn-danger btn-sm" data-a="reject">Từ chối</button>' : ''}</div></div>`;
    }
    if (isAdmin) {
      return `<div class="user-row">${head}<div class="small">Toàn quyền</div><div></div><div></div><div class="user-actions small muted">Đổi mật khẩu ở trang Tài khoản</div></div>`;
    }
    return `<div class="user-row" data-id="${u.id}">${head}
      <label class="field"><span class="small">Vai trò</span><select data-f="role">
        <option value="staff" ${u.role === 'staff' ? 'selected' : ''}>Nhân viên</option>
        <option value="manager" ${u.role === 'manager' ? 'selected' : ''}>Quản lý</option></select></label>
      <label class="field"><span class="small">Nhóm</span><select data-f="team">${TEAMS.map((t) => `<option ${t === u.team ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <div class="field scope-cell" data-scope ${u.role === 'manager' ? '' : 'hidden'}><span class="small">Được quản lý báo cáo</span>
        <div class="scope">
          <label><input type="checkbox" data-all ${scopeAll ? 'checked' : ''}> Tất cả</label>
          ${TEAMS.map((t) => `<label><input type="checkbox" data-t="${t}" ${scopeAll || scopes.includes(t) ? 'checked' : ''} ${scopeAll ? 'disabled' : ''}> ${t}</label>`).join('')}
        </div></div>
      <div class="user-actions">
        <button class="btn btn-sm" data-a="save">Lưu</button>
        <button class="btn btn-ghost btn-sm" data-a="reset">Đặt lại MK</button>
        ${u.status === 'locked' ? '<button class="btn btn-ghost btn-sm" data-a="unlock">Mở khóa</button>' : '<button class="btn btn-danger btn-sm" data-a="lock">Khóa</button>'}
      </div></div>`;
  }).join('');

  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  $$('.user-row[data-id]', box).forEach((row) => {
    const u = byId[row.dataset.id];
    const roleSel = $('[data-f=role]', row);
    if (roleSel) roleSel.onchange = () => { $('[data-scope]', row).hidden = roleSel.value !== 'manager'; };
    const all = $('[data-all]', row);
    if (all) all.onchange = () => $$('[data-t]', row).forEach((c) => { c.disabled = all.checked; if (all.checked) c.checked = true; });
    $$('[data-a]', row).forEach((b) => (b.onclick = () => userAction(b.dataset.a, u, row)));
  });
}

async function userAction(a, u, row) {
  try {
    let r;
    const setStatus = (action) => rpc('admin_set_status', { p_user_id: u.id, p_action: action });
    if (a === 'approve') r = await setStatus('approve');
    else if (a === 'reject') {
      if (!(await confirmDialog('Từ chối đăng ký', `Từ chối tài khoản @${u.username}?`, 'Từ chối', true))) return;
      r = await setStatus('reject');
    } else if (a === 'lock') {
      if (!(await confirmDialog('Khóa tài khoản', `Khóa tài khoản @${u.username}? Người này sẽ bị đăng xuất ngay.`, 'Khóa', true))) return;
      r = await setStatus('lock');
    } else if (a === 'unlock') r = await setStatus('unlock');
    else if (a === 'save') {
      const role = $('[data-f=role]', row).value;
      const team = $('[data-f=team]', row).value;
      let all = false;
      let teams = [];
      if (role === 'manager') {
        all = $('[data-all]', row).checked;
        if (!all) {
          teams = $$('[data-t]', row).filter((c) => c.checked).map((c) => c.dataset.t);
          if (!teams.length) return toast('Chọn ít nhất một nhóm cho quản lý.', true);
        }
      }
      r = await rpc('admin_update_user', { p_user_id: u.id, p_role: role, p_team: team, p_manager_all: all, p_manager_teams: teams });
    } else if (a === 'reset') return resetPasswordDialog(u);
    toast(r.message);
    loadUsers();
  } catch (err) { toast(err.message, true); }
}

function resetPasswordDialog(u) {
  const d = openDialog(`Đặt lại mật khẩu · @${u.username}`, `
    <form id="rp" class="stack" novalidate>
      <label class="field"><span>Mật khẩu mới</span><input name="pw" type="text" autocomplete="off" required>
        <span class="hint">Ít nhất 8 ký tự, có chữ và số. Hãy gửi mật khẩu này trực tiếp cho người dùng.</span></label>
      <div class="form-error" data-err hidden></div>
    </form>`, '<button class="btn btn-ghost" data-close>Hủy</button><button class="btn" form="rp" type="submit">Đặt lại</button>');
  const f = $('#rp', d);
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const pw = f.pw.value;
    if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return showFormError(f, 'Mật khẩu phải có ít nhất 8 ký tự, gồm cả chữ và số.');
    try { const r = await rpc('admin_reset_password', { p_user_id: u.id, p_new_password: pw }); closeDialog(); toast(r.message); }
    catch (err) { showFormError(f, err.message); }
  });
}

/* ---------- Trang tài khoản ---------- */
function renderAccount() {
  renderTopbar('#/tai-khoan');
  view().className = 'view';
  const u = state.user;
  view().innerHTML = `
    <div class="page-head"><div><h1>Tài khoản</h1><p class="muted">@${esc(u.username)} · ${ROLE_LABEL[u.role]}${u.team ? ' · Nhóm ' + esc(u.team) : ''}</p></div></div>
    <div class="grid-2">
      <section class="card">
        <h2>Họ tên hiển thị</h2>
        <p class="muted small">Tên này xuất hiện ở cột "Người thực hiện" và "Người duyệt" trong file Excel.</p>
        <form id="pf" class="stack" novalidate>
          <label class="field"><span>Họ và tên</span><input name="full_name" value="${esc(u.full_name)}" maxlength="100" required></label>
          <div class="form-error" data-err hidden></div>
          <button class="btn" type="submit">Lưu họ tên</button>
        </form>
      </section>
      <section class="card">
        <h2>Đổi mật khẩu</h2>
        <form id="cp" class="stack" novalidate>
          <label class="field"><span>Mật khẩu hiện tại</span><input name="old" type="password" autocomplete="current-password" required></label>
          <label class="field"><span>Mật khẩu mới</span><input name="pw" type="password" autocomplete="new-password" required>
            <span class="hint">Ít nhất 8 ký tự, có cả chữ và số.</span></label>
          <label class="field"><span>Nhập lại mật khẩu mới</span><input name="pw2" type="password" autocomplete="new-password" required></label>
          <div class="form-error" data-err hidden></div>
          <button class="btn" type="submit">Đổi mật khẩu</button>
        </form>
      </section>
    </div>`;
  const pf = $('#pf');
  pf.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = pf.full_name.value.trim();
    if (name.length < 2) return showFormError(pf, 'Vui lòng nhập họ tên.');
    try { toast((await rpc('update_profile', { p_full_name: name })).message); state.user.full_name = name; renderTopbar('#/tai-khoan'); }
    catch (err) { showFormError(pf, err.message); }
  });
  const cp = $('#cp');
  cp.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('[data-err]', cp).hidden = true;
    const pw = cp.pw.value;
    if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return showFormError(cp, 'Mật khẩu mới phải có ít nhất 8 ký tự, gồm cả chữ và số.');
    if (pw !== cp.pw2.value) return showFormError(cp, 'Mật khẩu nhập lại không khớp.');
    try { toast((await rpc('change_password', { p_old_password: cp.old.value, p_new_password: pw })).message); cp.reset(); }
    catch (err) { showFormError(cp, err.message); }
  });
}

/* ---------- Chưa cấu hình Supabase ---------- */
function renderSetupNeeded() {
  $('#topbar').hidden = true;
  view().className = 'view';
  view().innerHTML = `
    <section class="card stack">
      <h1>Chưa cấu hình kết nối</h1>
      <p>Website chưa được kết nối với cơ sở dữ liệu Supabase.</p>
      <p>Người quản trị cần mở file <strong>web/config.js</strong> trong repo GitHub và điền
         <strong>SUPABASE_URL</strong> và <strong>SUPABASE_KEY</strong> theo hướng dẫn trong README.</p>
    </section>`;
}

/* ---------- Điều hướng ---------- */
async function route() {
  closeDialog();
  const h = location.hash || '#/nhap';
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_KEY) return renderSetupNeeded();
  if (h === '#/dang-ky') return state.user ? go('#/nhap') : renderRegister();
  if (!state.user && getToken()) {
    try { state.user = (await rpc('me')).user; } catch { setToken(null); }
  }
  if (!state.user) return renderLogin();
  if (h === '#/dang-nhap') return go('#/nhap');
  const isMgr = state.user.role === 'admin' || state.user.role === 'manager';
  if (h === '#/quan-ly' && isMgr) return renderManager();
  if (h === '#/quan-tri' && state.user.role === 'admin') return renderAdmin();
  if (h === '#/tai-khoan') return renderAccount();
  if (h !== '#/nhap') return go('#/nhap');
  return renderEntry();
}

window.addEventListener('hashchange', route);
document.addEventListener('DOMContentLoaded', () => {
  dlg().addEventListener('click', (e) => { if (e.target === dlg()) closeDialog(); });
  route();
});
