'use strict';
/* =============== Báo cáo công việc hàng ngày – giao diện =============== */
const TEAMS = ['Điện', 'Cơ Khí', 'PM', 'Trực ca'];
const SHIFTS = ['Hành chính', 'Ca 1', 'Ca 2', 'Ca 3'];
const DEFAULT_SHIFT = 'Hành chính';
const TEAM_CLASS = { 'Điện': 'dien', 'Cơ Khí': 'cokhi', PM: 'pm', 'Trực ca': 'trucca' };
const ROLE_LABEL = { admin: 'Admin', manager: 'Quản lý', staff: 'Nhân viên' };
const STATUS_LABEL = { pending: 'Chờ duyệt', active: 'Hoạt động', rejected: 'Bị từ chối', locked: 'Đã khóa' };
const FIELD_LABEL = { machine: 'Tên máy', description: 'Diễn giải', start_at: 'Bắt đầu', end_at: 'Kết thúc', completion: 'Trạng thái', note: 'Tình trạng máy / Ghi chú', coworker_ids: 'Người làm cùng', shift: 'Ca làm việc' };
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const state = { user: null, date: today(), team: null, shift: DEFAULT_SHIFT, mgrDate: today(), mgrMonth: today().slice(0, 7), adminTab: 'pending' };

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
/** Cộng/trừ ngày cho chuỗi yyyy-mm-dd */
function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Chuẩn hóa giờ gõ tay: "730", "0730", "7:30", "7h30", "7h", "7" → "07:30"/"07:00". '' nếu trống, null nếu sai */
function normalizeHM(v) {
  const t = String(v || '').trim().toLowerCase().replace(/[h.,;\s]+/g, ':').replace(/:$/, '');
  if (!t) return '';
  let h;
  let m;
  let x = t.match(/^(\d{1,2}):(\d{1,2})$/);
  if (x) { h = x[1]; m = x[2].length === 1 ? `${x[2]}0` : x[2]; }
  else if ((x = t.match(/^\d{1,4}$/))) {
    if (t.length <= 2) { h = t; m = '0'; } else { h = t.slice(0, t.length - 2); m = t.slice(-2); }
  } else return null;
  h = Number(h); m = Number(m);
  if (h > 23 || m > 59) return null;
  return `${pad(h)}:${pad(m)}`;
}
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
function shiftTag(s) { const v = s || DEFAULT_SHIFT; return `<span class="shift-tag ${v === DEFAULT_SHIFT ? '' : 'sh-ca'}">${esc(v)}</span>`; }

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

/* ---------- Người làm cùng ---------- */
let coworkerCache = null;
const knownNames = new Map(); // id → họ tên (kể cả tài khoản đã khóa, lấy từ dữ liệu dòng)
async function loadCoworkers(force = false) {
  if (!coworkerCache || force) {
    coworkerCache = (await rpc('list_coworkers')).users;
    coworkerCache.forEach((u) => knownNames.set(u.id, u.full_name));
  }
  return coworkerCache;
}
function rememberNames(ids, names) { (ids || []).forEach((id, i) => names && names[i] && knownNames.set(id, names[i])); }
function coworkerName(id) { return knownNames.get(id) || `#${id}`; }
/** Bỏ dấu tiếng Việt để tìm kiếm */
function fold(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase(); }
const sameIds = (a, b) => JSON.stringify([...(a || [])].sort((x, y) => x - y)) === JSON.stringify([...(b || [])].sort((x, y) => x - y));

function coworkerFieldHTML(e) {
  const owner = e ? e.user_id : state.user.id;
  return `
    <div class="field"><span>Người làm cùng</span>
      <div class="cw" data-cw data-owner="${esc(owner ?? '')}" data-selected="${esc(JSON.stringify(e?.coworker_ids || []))}">
        <div class="cw-chips" data-cw-chips></div>
        <button type="button" class="btn btn-ghost btn-sm" data-cw-toggle aria-expanded="false">+ Thêm người làm cùng</button>
        <div class="cw-panel" data-cw-panel hidden>
          <input type="search" data-cw-search placeholder="Tìm theo tên…" aria-label="Tìm người làm cùng" autocomplete="off">
          <div class="cw-list" data-cw-list><div class="muted small">Đang tải…</div></div>
        </div>
      </div>
      <span class="hint">Người được chọn sẽ thấy dòng này và có tên ở cột "Người thực hiện".</span>
    </div>`;
}

function bindCoworkers(root) {
  const box = $('[data-cw]', root);
  if (!box) return;
  const owner = Number(box.dataset.owner) || state.user.id;
  let selected = JSON.parse(box.dataset.selected || '[]');
  const chips = $('[data-cw-chips]', box);
  const panel = $('[data-cw-panel]', box);
  const list = $('[data-cw-list]', box);
  const search = $('[data-cw-search]', box);
  const toggle = $('[data-cw-toggle]', box);

  const sync = () => {
    box.dataset.selected = JSON.stringify(selected);
    chips.innerHTML = selected.map((id) =>
      `<span class="cw-chip">${esc(coworkerName(id))}<button type="button" data-rm="${id}" aria-label="Bỏ ${esc(coworkerName(id))}">×</button></span>`).join('');
    toggle.textContent = panel.hidden ? (selected.length ? '+ Thêm / bớt người' : '+ Thêm người làm cùng') : 'Xong';
    $$('[data-rm]', chips).forEach((b) => (b.onclick = () => {
      selected = selected.filter((x) => x !== Number(b.dataset.rm));
      sync();
      renderList();
    }));
  };
  const renderList = () => {
    if (!coworkerCache) return;
    const q = fold(search.value.trim());
    const users = coworkerCache.filter((u) => u.id !== owner && (!q || fold(u.full_name).includes(q)));
    if (!users.length) { list.innerHTML = '<div class="muted small">Không tìm thấy ai.</div>'; return; }
    let html = '';
    let lastTeam;
    for (const u of users) {
      if (u.team !== lastTeam) { html += `<div class="cw-group">${esc(u.team || 'Khác')}</div>`; lastTeam = u.team; }
      html += `<label class="cw-item"><input type="checkbox" value="${u.id}" ${selected.includes(u.id) ? 'checked' : ''}> ${esc(u.full_name)}</label>`;
    }
    list.innerHTML = html;
    $$('input[type=checkbox]', list).forEach((cb) => (cb.onchange = () => {
      const id = Number(cb.value);
      if (cb.checked) {
        if (selected.length >= 10) { cb.checked = false; toast('Chỉ chọn tối đa 10 người làm cùng.', true); return; }
        selected.push(id);
      } else selected = selected.filter((x) => x !== id);
      sync();
    }));
  };
  toggle.onclick = async () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    sync();
    if (panel.hidden) return;
    try { await loadCoworkers(); renderList(); search.focus(); }
    catch (err) { list.innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
  };
  search.oninput = renderList;
  search.onkeydown = (ev) => { if (ev.key === 'Enter') ev.preventDefault(); };
  sync();
  if (selected.some((id) => !knownNames.has(id))) loadCoworkers().then(sync).catch(() => {});
}

/* ---------- Form dòng công việc (dùng chung) ---------- */
function entryFormHTML(e, date) {
  const c = e ? e.completion : 100;
  const done = c >= 100;
  // ngày tự lấy theo ngày báo cáo (dòng cũ: giữ ngày bắt đầu đã lưu)
  const base = e && e.start_at ? e.start_at.slice(0, 10) : date;
  return `
    <div class="stack" data-base="${esc(base)}">
      <label class="field"><span>Diễn giải công việc (tên công việc) <span class="req">*</span></span>
        <div class="voice-wrap">
          <textarea name="description" rows="3" maxlength="4000" required placeholder="VD: Thay vòng bi motor quạt hút, vệ sinh tủ điện...">${esc(e?.description)}</textarea>
          ${micBtnHTML('description')}
        </div></label>
      ${e ? `<label class="field"><span>Ca làm việc</span>
        <select name="shift">${SHIFTS.map((x) => `<option ${x === (e.shift || DEFAULT_SHIFT) ? 'selected' : ''}>${x}</option>`).join('')}</select></label>` : ''}
      <label class="field"><span>Tên máy</span>
        <input name="machine" maxlength="200" autocomplete="off" placeholder="VD: Máy ép viên số 2" value="${esc(e?.machine)}"></label>
      <div class="field-row time-row">
        <label class="field"><span>Giờ bắt đầu</span>
          <input name="start_hm" class="time-in" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="VD: 07:30" value="${esc(e?.start_at ? e.start_at.slice(11, 16) : '')}"></label>
        <label class="field"><span>Giờ kết thúc</span>
          <input name="end_hm" class="time-in" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="VD: 09:00" value="${esc(e?.end_at ? e.end_at.slice(11, 16) : '')}"></label>
      </div>
      <p class="hint" data-time-hint></p>
      ${coworkerFieldHTML(e)}
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
      <label class="field"><span>Tình trạng máy / Ghi chú <span class="muted small">(không bắt buộc)</span></span>
        <div class="voice-wrap">
          <textarea name="note" rows="2" maxlength="4000" placeholder="VD: Máy hoạt động bình thường">${esc(e?.note)}</textarea>
          ${micBtnHTML('note')}
        </div></label>
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
  $$('.time-in', root).forEach((i) => {
    i.addEventListener('blur', () => {
      const v = normalizeHM(i.value);
      if (v !== null) i.value = v;
      i.classList.toggle('invalid', v === null);
      updateTimeHint(root);
    });
    i.addEventListener('input', () => { i.classList.remove('invalid'); updateTimeHint(root); });
  });
  updateTimeHint(root);
  bindCoworkers(root);
  $$('[data-mic]', root).forEach((b) => b.addEventListener('click', (ev) => {
    ev.preventDefault();
    toggleVoice(b, $(`[name=${b.dataset.mic}]`, root));
  }));
}

/* ---------- Nói thành chữ (Web Speech API của trình duyệt, tiếng Việt) ---------- */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let voice = null; // { rec, btn, field }

function micBtnHTML(field) {
  return `<button type="button" class="mic-btn" data-mic="${field}" title="Bấm để nói, bấm lần nữa để dừng" aria-label="Nói thay vì gõ" aria-pressed="false">🎤</button>`;
}

function stopVoice() {
  if (voice) { try { voice.rec.stop(); } catch { /* đã dừng */ } }
}

function toggleVoice(btn, field) {
  if (voice && voice.btn === btn) { stopVoice(); return; }
  stopVoice();
  if (!SpeechRec) {
    toast('Trình duyệt này chưa hỗ trợ nói thành chữ. Hãy dùng Chrome / Safari, hoặc bấm micro trên bàn phím điện thoại.', true);
    return;
  }
  const rec = new SpeechRec();
  rec.lang = 'vi-VN';
  rec.continuous = true;
  rec.interimResults = true;
  const start = field.value.replace(/\s+$/, '');
  const max = Number(field.getAttribute('maxlength')) || 4000;
  let finalText = '';
  const show = (interim) => {
    let said = (finalText + interim).replace(/\s+/g, ' ').trim();
    if (!said) return;
    if (!start || /[.!?]$/.test(start)) said = said.charAt(0).toUpperCase() + said.slice(1);
    field.value = (start ? start + ' ' : '') + said;
    if (field.value.length > max) field.value = field.value.slice(0, max);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) finalText += t + ' ';
      else interim += t;
    }
    show(interim);
  };
  rec.onerror = (ev) => {
    const msg = {
      'not-allowed': 'Chưa cho phép dùng micro. Bấm biểu tượng ổ khóa cạnh địa chỉ web → cho phép Micro.',
      'service-not-allowed': 'Trình duyệt này không cho dùng nói thành chữ. Hãy dùng Chrome / Safari.',
      'no-speech': 'Không nghe thấy tiếng nói, bấm 🎤 và nói lại.',
      'audio-capture': 'Không tìm thấy micro trên thiết bị.',
      network: 'Nói thành chữ cần có mạng internet.',
    }[ev.error];
    if (msg) toast(msg, true);
  };
  rec.onend = () => {
    show('');
    btn.classList.remove('rec');
    btn.setAttribute('aria-pressed', 'false');
    if (voice && voice.rec === rec) voice = null;
  };
  try { rec.start(); } catch { toast('Không bật được micro, thử lại.', true); return; }
  voice = { rec, btn, field };
  btn.classList.add('rec');
  btn.setAttribute('aria-pressed', 'true');
  toast('Đang nghe… nói xong bấm 🎤 lần nữa để dừng.');
}

/** Dòng nhắc dưới ô giờ: ngày theo báo cáo, báo khi giờ kết thúc sang hôm sau */
function updateTimeHint(root) {
  const box = $('[data-base]', root);
  const hint = $('[data-time-hint]', root);
  if (!box || !hint) return;
  const base = box.dataset.base;
  const sh = normalizeHM($('[name=start_hm]', root).value);
  const eh = normalizeHM($('[name=end_hm]', root).value);
  let txt = `Ngày: ${weekday(base)}, ${dmy(base)} (lấy theo ô "Ngày báo cáo" đã chọn). Gõ giờ dạng 07:30 hoặc 0730.`;
  if (sh && eh && eh < sh) txt += ` Giờ kết thúc nhỏ hơn giờ bắt đầu → tính sang ngày ${dmy(addDays(base, 1))}.`;
  hint.textContent = txt;
}

/** Rút gọn chữ dài (dùng khi nhắc tên công việc) */
function shortText(t, n = 60) {
  t = String(t || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Đọc & kiểm tra dữ liệu form phía trình duyệt */
function readEntryForm(root) {
  const val = (n) => $(`[name=${n}]`, root).value;
  const data = {
    machine: val('machine').trim(),
    description: val('description').trim(),
    note: val('note').trim(),
  };
  const errs = [];
  const base = $('[data-base]', root).dataset.base;
  const sh = normalizeHM(val('start_hm'));
  const eh = normalizeHM(val('end_hm'));
  if (sh === null) errs.push('Giờ bắt đầu không hợp lệ (gõ dạng 07:30 hoặc 0730).');
  if (eh === null) errs.push('Giờ kết thúc không hợp lệ (gõ dạng 09:00 hoặc 0900).');
  data.start_at = sh ? `${base}T${sh}` : '';
  // giờ kết thúc nhỏ hơn giờ bắt đầu → làm qua đêm, sang ngày hôm sau
  data.end_at = eh ? `${sh && eh < sh ? addDays(base, 1) : base}T${eh}` : '';
  if (!data.description) errs.push('Vui lòng nhập Diễn giải công việc (tên công việc).');
  const notDone = !$('[data-pct]', root).hidden;
  if (notDone) {
    const p = val('pct').trim();
    if (!/^\d{1,2}$/.test(p) || Number(p) > 99) errs.push('Phần trăm hoàn thành phải là số nguyên từ 0 đến 99.');
    data.completion = `${p}%`;
  } else data.completion = 'OK';
  const cw = $('[data-cw]', root);
  if (cw) data.coworker_ids = JSON.parse(cw.dataset.selected || '[]');
  const shiftSel = $('[name=shift]', root);
  if (shiftSel) data.shift = shiftSel.value;
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
    // không gửi lại danh sách người làm cùng nếu không đổi (tránh lỗi khi có người vừa bị khóa)
    if (sameIds(data.coworker_ids, entry.coworker_ids)) delete data.coworker_ids;
    if (data.shift === (entry.shift || DEFAULT_SHIFT)) delete data.shift;
    try {
      await rpc('update_entry', { p_id: entry.id, p_entry: data });
      closeDialog();
      toast('Đã lưu thay đổi.');
      onSaved();
    } catch (err) { showFormError(form, err.message); }
  });
}

async function deleteEntry(entry, onDone) {
  const ok = await confirmDialog('Xóa dòng công việc', `Xóa dòng "${entry.machine || shortText(entry.description)}"? Thao tác này không hoàn tác được.`, 'Xóa', true);
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
        <img src="img/xuong-co-khi.webp" alt="Xưởng cơ khí – An toàn trên hết">
        <div class="caption">
          <h1>Báo cáo công việc hàng ngày</h1>
          <p>Phòng Kỹ thuật · Nhập, tổng hợp và phê duyệt báo cáo sửa chữa của nhóm Điện, Cơ Khí, PM và Trực ca.</p>
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
        <div class="field field-shift"><span>Ca làm việc</span>
          <div class="seg seg-shift" id="f-shift" role="group" aria-label="Ca làm việc">
            ${SHIFTS.map((x) => `<button type="button" data-shift="${x}">${x}</button>`).join('')}
          </div>
          <span class="hint" id="shift-hint"></span>
        </div>
        <div id="lock-note" class="notice notice-ok" hidden></div>
        <form id="add-form" novalidate class="stack">
          <div id="add-items" class="stack"></div>
          <button type="button" class="btn btn-ghost btn-block btn-add-job" id="add-more">+ Thêm công việc</button>
          <div class="form-error" id="batch-err" hidden></div>
          <button class="btn btn-block" type="submit" id="send-btn">Gửi báo cáo</button>
          <p class="hint center">Nhập hết các công việc trong ngày rồi bấm <strong>Gửi báo cáo</strong> một lần.</p>
        </form>
      </section>
      <section>
        <div class="row-between"><h2 id="list-title"></h2><span class="muted small" id="list-count"></span></div>
        <div id="my-list" class="stack"><div class="loading">Đang tải…</div></div>
      </section>
    </div>`;

  const form = $('#add-form');
  const items = $('#add-items');
  const sendBtn = $('#send-btn');
  const batchErr = $('#batch-err');

  /** Khung công việc còn trống hoàn toàn (bỏ qua khi gửi) */
  const isBlank = (it) => ['description', 'machine', 'start_hm', 'end_hm', 'note']
    .every((n) => !$(`[name=${n}]`, it).value.trim()) && !JSON.parse($('[data-cw]', it)?.dataset.selected || '[]').length;

  const refresh = () => {
    const all = $$('[data-item]', items);
    all.forEach((it, i) => {
      $('[data-item-title]', it).textContent = `Công việc ${i + 1}`;
      $('[data-rm-item]', it).hidden = all.length === 1;
    });
    const n = all.filter((it) => !isBlank(it)).length;
    sendBtn.textContent = n > 1 ? `Gửi báo cáo (${n} công việc)` : 'Gửi báo cáo';
  };

  const addItem = (focus) => {
    if ($$('[data-item]', items).length >= 30) return toast('Mỗi lần gửi tối đa 30 công việc.', true);
    const it = document.createElement('div');
    it.className = 'job-item';
    it.dataset.item = '';
    it.innerHTML = `<div class="job-head"><strong data-item-title></strong>
      <button type="button" class="btn btn-ghost btn-sm" data-rm-item aria-label="Bỏ công việc này">✕ Bỏ</button></div>
      ${entryFormHTML(null, state.date)}`;
    items.appendChild(it);
    bindEntryForm(it);
    $('[data-rm-item]', it).onclick = async () => {
      if (!isBlank(it) && !(await confirmDialog('Bỏ công việc', 'Bỏ công việc đang nhập này (chưa gửi)?', 'Bỏ', true))) return;
      it.remove();
      refresh();
    };
    it.addEventListener('input', refresh);
    refresh();
    if (focus) { it.scrollIntoView({ behavior: 'smooth', block: 'start' }); $('[name=description]', it).focus(); }
  };
  const resetItems = () => { items.innerHTML = ''; addItem(false); };
  resetItems();

  $('#add-more').onclick = () => addItem(true);

  // Đổi ngày: giữ nguyên các công việc đang nhập, chỉ đổi ngày theo báo cáo
  $('#f-date').addEventListener('change', (e) => {
    if (!e.target.value) return;
    state.date = e.target.value;
    $$('[data-item]', items).forEach((it) => { $('[data-base]', it).dataset.base = state.date; updateTimeHint(it); });
    loadMine();
  });
  $('#f-team').addEventListener('change', (e) => { state.team = e.target.value; loadMine(); });

  // Ca làm việc: mặc định Hành chính, đi ca 1/2/3 thì bấm đổi
  const paintShift = () => {
    $$('[data-shift]').forEach((b) => {
      const on = b.dataset.shift === state.shift;
      b.className = on ? (state.shift === DEFAULT_SHIFT ? 'on-ok' : 'on-warn') : '';
      b.setAttribute('aria-pressed', String(on));
    });
    $('#shift-hint').textContent = state.shift === DEFAULT_SHIFT
      ? 'Mặc định ca Hành chính. Đi ca 1, 2, 3 thì bấm chọn ca tương ứng.'
      : `Đang nhập cho ${state.shift}. Báo cáo ${state.shift} được xuất ra file Excel riêng.`;
  };
  $$('[data-shift]').forEach((b) => (b.onclick = () => { state.shift = b.dataset.shift; paintShift(); loadMine(); }));
  paintShift();

  // Nhắc khi rời trang mà còn công việc chưa gửi
  window.onbeforeunload = () => ($('#add-items') && $$('[data-item]', items).some((it) => !isBlank(it)) ? true : undefined);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    batchErr.hidden = true;
    $$('[data-err]', items).forEach((b) => { b.hidden = true; });
    const all = $$('[data-item]', items);
    const filled = all.filter((it) => !isBlank(it));
    if (!filled.length) {
      showFormError(all[0], 'Vui lòng nhập Diễn giải công việc (tên công việc).');
      $('[name=description]', all[0]).focus();
      return;
    }
    const entries = [];
    let firstBad = null;
    for (const it of filled) {
      const { data, errs } = readEntryForm(it);
      if (errs.length) { showFormError(it, errs[0]); firstBad = firstBad || it; }
      entries.push(data);
    }
    if (firstBad) { firstBad.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    sendBtn.disabled = true;
    try {
      const r = await rpc('add_entries', { p_date: state.date, p_team: state.team, p_shift: state.shift, p_entries: entries });
      toast(`Đã gửi ${r.count} công việc (${state.shift}).`);
      resetItems();
      loadMine();
    } catch (err) {
      // máy chủ báo "Công việc N: ..." → hiện lỗi ngay tại khung đó
      const m = /^Công việc (\d+): (.*)$/s.exec(err.message);
      const it = m && filled[Number(m[1]) - 1];
      if (it) { showFormError(it, m[2]); it.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      else { batchErr.textContent = err.message; batchErr.hidden = false; }
    } finally { sendBtn.disabled = false; refresh(); }
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
  const approved = ((r.report_statuses || {})[state.team] || {})[state.shift] === 'approved';
  const canManage = state.user.viewable_teams.includes(state.team);
  const note = $('#lock-note');
  note.hidden = !approved;
  note.innerHTML = approved ? `🔒 Báo cáo nhóm ${esc(state.team)} (${esc(state.shift)}) ngày ${dmy(state.date)} đã được phê duyệt.${canManage ? ' Bạn có quyền quản lý nên vẫn sửa được (sẽ ghi lịch sử).' : ' Không thể thêm hoặc sửa nữa.'}` : '';
  const locked = approved && !canManage;
  $('#send-btn').disabled = locked;
  $('#add-more').disabled = locked;

  $('#list-count').textContent = r.entries.length ? `${r.entries.length} dòng` : '';
  if (!r.entries.length) {
    list.innerHTML = '<div class="empty">Chưa có dòng công việc nào trong ngày này.</div>';
    return;
  }
  list.innerHTML = r.entries.map((e) => `
    <article class="entry e-${TEAM_CLASS[e.team]}" data-id="${e.id}">
      <div class="entry-head">
        <div class="row"><span class="entry-machine">${e.machine ? esc(e.machine) : '<span class="muted">(không ghi tên máy)</span>'}</span>${teamTag(e.team)}${shiftTag(e.shift)}</div>
        <div class="row">${completionBadge(e.completion)}${e.report_status === 'approved' ? '<span class="badge badge-muted">🔒 Đã duyệt</span>' : ''}</div>
      </div>
      <div class="entry-time">${e.start_at ? esc(fmtTime(e.start_at, state.date)) : '—'} → ${e.end_at ? esc(fmtTime(e.end_at, state.date)) : '<span class="miss">chưa nhập giờ kết thúc</span>'}</div>
      ${e.description ? `<div class="entry-body pre">${esc(e.description)}</div>` : '<div class="entry-body muted small">Chưa có diễn giải</div>'}
      ${e.note ? `<div class="entry-note pre">📝 ${esc(e.note)}</div>` : ''}
      ${e.is_owner === false ? `<div class="entry-cw">✍️ Do <strong>${esc(e.user_name)}</strong> nhập · bạn là người làm cùng</div>` : ''}
      ${e.coworker_names && e.coworker_names.length ? `<div class="entry-cw">👥 Làm cùng: ${esc(e.coworker_names.join(', '))}</div>` : ''}
      ${e.can_edit ? `<div class="entry-actions"><button class="btn btn-ghost btn-sm" data-edit>Sửa</button><button class="btn btn-danger btn-sm" data-del>Xóa</button></div>` : ''}
    </article>`).join('');
  r.entries.forEach((e) => rememberNames(e.coworker_ids, e.coworker_names));
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
      <div><h1>Quản lý báo cáo</h1><p class="muted">Mỗi nhóm, mỗi ca (Hành chính, Ca 1, Ca 2, Ca 3) là 1 báo cáo và 1 file Excel riêng.</p></div>
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
    <section class="card report-card r-${TEAM_CLASS[rep.team]}" data-key="${esc(rep.team + '|' + rep.shift)}">
      <div class="report-head">
        <div>
          <div class="report-title"><h2>Báo cáo nhóm ${esc(rep.team)}</h2>${shiftTag(rep.shift)}${reportBadge(rep.status)}</div>
          <div class="report-meta">${rep.entries.length} dòng công việc</div>
          ${approved && rep.approved_by_name ? `<div class="approved-by">✅ Đã phê duyệt bởi <strong>${esc(rep.approved_by_name)}</strong> lúc ${esc(rep.approved_at)}</div>` : ''}
        </div>
        <div class="report-actions">
          ${!approved && rep.entries.length ? '<button class="btn btn-sm" data-act="approve">✓ Phê duyệt</button>' : ''}
          ${approved && (isAdmin || rep.approved_by === state.user.id) ? '<button class="btn btn-ghost btn-sm" data-act="unapprove">Hủy phê duyệt</button>' : ''}
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
          // dòng tiêu đề đầu mỗi cụm: các việc của cùng 1 người gửi đứng liền nhau
          const head = i === 0 || rep.entries[i - 1].user_id !== e.user_id
            ? `<tr class="grp-row"><td colspan="9" class="no-label">👤 ${esc(e.user_name)} · ${rep.entries.filter((x) => x.user_id === e.user_id).length} công việc</td></tr>` : '';
          return `${head}<tr class="${miss.length ? 'row-missing' : ''}" data-id="${e.id}">
            <td data-label="#" class="num">${i + 1}</td>
            <td data-label="Tên máy" class="w-machine"><strong>${esc(e.machine)}</strong></td>
            <td data-label="Diễn giải" class="w-desc pre">${m('Diễn giải công việc', esc(e.description))}</td>
            <td data-label="Bắt đầu" class="num">${m('Thời gian bắt đầu', esc(fmtTime(e.start_at, rep.date)))}</td>
            <td data-label="Kết thúc" class="num">${m('Thời gian kết thúc', esc(fmtTime(e.end_at, rep.date)))}</td>
            <td data-label="Trạng thái">${completionBadge(e.completion)}</td>
            <td data-label="Ghi chú" class="w-note pre">${esc(e.note)}</td>
            <td data-label="Người thực hiện" class="w-person">${esc(e.user_name)}${e.coworker_names && e.coworker_names.length ? `<div class="small muted">+ ${esc(e.coworker_names.join(', '))}</div>` : ''}</td>
            <td class="no-label nowrap">${e.can_edit ? '<button class="btn btn-ghost btn-sm" data-edit>Sửa</button> <button class="btn btn-danger btn-sm" data-del>Xóa</button>' : ''}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : '<div class="empty">Chưa có dòng công việc nào.</div>'}
    </section>`;
  }).join('');

  r.reports.forEach((rep) => rep.entries.forEach((e) => rememberNames(e.coworker_ids, e.coworker_names)));
  const byKey = Object.fromEntries(r.reports.map((rep) => [`${rep.team}|${rep.shift}`, rep]));
  $$('.report-card', box).forEach((card) => {
    const rep = byKey[card.dataset.key];
    rep.entries.forEach((e) => { e.shift = rep.shift; });
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
  const body = { p_date: rep.date, p_team: rep.team, p_shift: rep.shift };
  try {
    if (act === 'approve') {
      const msg = `Phê duyệt báo cáo nhóm ${rep.team} (${rep.shift}) ngày ${dmy(rep.date)}?\nSau khi duyệt, nhân viên không thể sửa hoặc xóa dòng của mình.` +
        (rep.missing.length ? `\n\nLưu ý: còn ${rep.missing.length} dòng thiếu thông tin.` : '');
      if (!(await confirmDialog('Phê duyệt báo cáo', msg, 'Phê duyệt'))) return;
      toast((await rpc('approve_report', body)).message);
      refresh();
    } else if (act === 'unapprove') {
      if (!(await confirmDialog('Hủy phê duyệt', `Mở lại báo cáo nhóm ${rep.team} (${rep.shift}) ngày ${dmy(rep.date)} cho nhân viên sửa?`, 'Hủy phê duyệt', true))) return;
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
    data = await rpc('report_export', { p_date: rep.date, p_team: rep.team, p_shift: rep.shift });
  } catch (err) {
    if (Array.isArray(err.details) && err.details.length) {
      openDialog('Chưa thể xuất Excel', `
        <p>${esc(err.message)}</p>
        <div class="form-error"><ul>${err.details.map((d) =>
          `<li><strong>Dòng ${d.row}</strong> (${esc(d.machine || 'không ghi tên máy')} – ${esc(d.user_name)}): thiếu ${d.fields.map(esc).join(', ')}</li>`).join('')}</ul></div>`,
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
  downloadBlob(new Blob([buf], { type: XLSX_TYPE }), window.ExcelExport.exportFileName(data.team, data.date, data.shift));
}

function downloadBlob(blob, name) {
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
  if (k === 'coworker_ids') return Array.isArray(v) && v.length ? v.map(coworkerName).join(', ') : '(không có)';
  return v;
}
async function showHistory(rep) {
  const [r] = await Promise.all([rpc('report_history', { p_date: rep.date, p_team: rep.team, p_shift: rep.shift }), loadCoworkers().catch(() => null)]);
  const body = r.items.length ? r.items.map((h) => {
    const keys = Object.keys(h.new_value || h.old_value || {});
    const diff = h.action === 'update'
      ? `<div class="hist-diff">${keys.map((k) => `<div class="k">${FIELD_LABEL[k] || k}</div><div class="old pre">${esc(fmtVal(k, h.old_value[k]))}</div><div class="new pre">${esc(fmtVal(k, h.new_value[k]))}</div>`).join('')}</div>`
      : (h.action === 'create' || h.action === 'delete')
        ? `<div class="small muted">${(h.new_value || h.old_value).machine ? `Tên máy: ${esc((h.new_value || h.old_value).machine)} · ` : ''}Công việc: ${esc(shortText((h.new_value || h.old_value).description))}</div>` : '';
    return `<div class="hist-item">
      <div class="row-between"><div class="row"><strong>${ACTION_LABEL[h.action] || h.action}</strong>${h.after_approval ? '<span class="badge badge-warn">Sau phê duyệt</span>' : ''}</div>
      <span class="small muted">${esc(h.created_at)}</span></div>
      <div class="small">Người thực hiện: ${esc(h.user_name)}</div>${diff}</div>`;
  }).join('') : '<div class="empty">Chưa có lịch sử.</div>';
  openDialog(`Lịch sử · ${rep.team} · ${rep.shift} · ${dmy(rep.date)}`, body, '<button class="btn" data-close>Đóng</button>', true);
}

/* ---------- Trang quản trị tài khoản (Admin) ---------- */
async function renderAdmin() {
  renderTopbar('#/quan-tri');
  view().className = 'view';
  view().innerHTML = `
    <div class="page-head"><div><h1>Quản trị tài khoản</h1><p class="muted">Duyệt đăng ký, phân quyền, khóa tài khoản, đặt lại mật khẩu và sao lưu dữ liệu.</p></div></div>
    <section class="card storage" id="storage"><div class="loading">Đang tải dung lượng…</div></section>
    <h2 class="section-title">Tài khoản</h2>
    <div class="tabs" id="tabs"></div>
    <section class="card" id="users"><div class="loading">Đang tải…</div></section>`;
  loadStorage();
  loadUsers();
}

/* ----- Dung lượng & sao lưu ----- */
/** Đơn vị thập phân giống Supabase (1 MB = 1.000.000 byte) */
function fmtBytes(b) {
  const n = (v, d) => v.toLocaleString('vi-VN', { minimumFractionDigits: d, maximumFractionDigits: d });
  if (b < 1e6) return `${n(b / 1e3, 0)} KB`;
  return `${n(b / 1e6, b < 1e8 ? 1 : 0)} MB`;
}
const fmtNum = (n) => Number(n || 0).toLocaleString('vi-VN');

async function loadStorage() {
  const box = $('#storage');
  if (!box) return;
  let s;
  try { s = await rpc('admin_storage'); }
  catch (err) { box.innerHTML = `<div class="form-error">${esc(err.message)}</div>`; return; }
  const pct = Math.min(100, (s.db_bytes / s.limit_bytes) * 100);
  const level = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok';
  const advice = {
    ok: 'Nên sao lưu định kỳ (mỗi tuần hoặc mỗi tháng) vì gói Free không có bản sao lưu tự động.',
    warn: '⚠ Dung lượng đã trên 70%. Hãy sao lưu và cân nhắc xóa dữ liệu cũ hoặc nâng gói Supabase.',
    danger: '⛔ Sắp hết dung lượng! Hãy sao lưu ngay, sau đó xóa dữ liệu cũ hoặc nâng gói Supabase.',
  }[level];
  box.innerHTML = `
    <div class="row-between">
      <div><h2>Dung lượng dữ liệu</h2><p class="muted small">Gói Free của Supabase cho phép tối đa 500 MB.</p></div>
      <button class="btn btn-accent" id="backup-btn">⬇ Sao lưu ra Excel</button>
    </div>
    <div class="storage-figs"><strong>${fmtBytes(s.db_bytes)} / 500 MB</strong><span class="muted">đã dùng ${pct.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%</span></div>
    <div class="meter meter-${level}" role="meter" aria-label="Dung lượng đã dùng" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct.toFixed(1)}"><span></span></div>
    <div class="storage-stats">
      <div><b>${fmtNum(s.entries)}</b><span>dòng công việc</span></div>
      <div><b>${fmtNum(s.reports)}</b><span>báo cáo</span></div>
      <div><b>${fmtNum(s.users)}</b><span>tài khoản</span></div>
      <div><b>${fmtNum(s.audit_log)}</b><span>lịch sử sửa</span></div>
    </div>
    <p class="small muted">Tính giống trang Usage của Supabase. Trong đó dữ liệu báo cáo chiếm ${fmtBytes(s.app_bytes || 0)}, phần còn lại là phần nền có sẵn của Supabase.</p>
    <p class="small ${level === 'ok' ? 'muted' : `text-${level}`}">${s.first_date ? `Dữ liệu từ ${dmy(s.first_date)} đến ${dmy(s.last_date)}. ` : ''}${advice}</p>
    ${purgeSectionHTML(s, level)}`;
  $('.meter span', box).style.width = `${Math.max(pct, 0.5)}%`;
  $('#backup-btn').onclick = (ev) => downloadBackup(ev.currentTarget);
  bindPurge(box);
}

/* ----- Xóa dữ liệu cũ ----- */
function purgeSectionHTML(s, level) {
  const max = s.max_purge_before;
  const jan1 = `${today().slice(0, 4)}-01-01`;
  const def = jan1 <= max ? jan1 : max;
  const last = s.last_purge;
  return `
    <details class="purge" ${level === 'ok' ? '' : 'open'}>
      <summary>🗑 Xóa dữ liệu cũ để giải phóng dung lượng</summary>
      <div class="purge-body stack">
        <p class="small muted">Xóa <strong>vĩnh viễn</strong> các báo cáo (kèm dòng công việc và lịch sử sửa) <strong>trước</strong> ngày bạn chọn.
          Không xóa được dữ liệu trong <strong>15 ngày gần nhất</strong>. Tài khoản nhân viên được giữ nguyên.
          Bắt buộc tải bản sao lưu của phần dữ liệu đó trước khi xóa.</p>
        ${last ? `<p class="small">Lần xóa gần nhất: ${esc(last.created_at)} — ${esc(last.user_name)} xóa ${fmtNum(last.reports)} báo cáo, ${fmtNum(last.entries)} dòng (trước ${dmy(last.before)}).</p>` : ''}
        <div class="purge-row">
          <label class="field"><span>Xóa các báo cáo trước ngày</span>
            <input type="date" id="purge-date" max="${esc(max)}" value="${esc(def)}"></label>
          <button class="btn btn-ghost" id="purge-preview" type="button">Xem trước</button>
        </div>
        <span class="hint">Chọn được muộn nhất là ngày ${dmy(max)}.</span>
        <div id="purge-result"></div>
      </div>
    </details>`;
}

function bindPurge(box) {
  const dateInput = $('#purge-date', box);
  const result = $('#purge-result', box);
  const reset = () => { result.innerHTML = ''; };
  dateInput.addEventListener('change', reset);
  $('#purge-preview', box).onclick = async () => {
    const before = dateInput.value;
    if (!before) return toast('Vui lòng chọn ngày.', true);
    if (before > dateInput.max) return toast(`Chỉ chọn được ngày không sau ${dmy(dateInput.max)}.`, true);
    result.innerHTML = '<div class="loading">Đang kiểm tra…</div>';
    let p;
    try { p = await rpc('admin_purge_preview', { p_before: before }); }
    catch (err) { result.innerHTML = `<div class="form-error">${esc(err.message)}</div>`; return; }
    if (!p.reports) {
      result.innerHTML = `<div class="notice notice-ok">Không có báo cáo nào trước ngày ${dmy(before)}. Không có gì để xóa.</div>`;
      return;
    }
    result.innerHTML = `
      <div class="notice notice-warn"><div>Sẽ xóa <strong>${fmtNum(p.reports)}</strong> báo cáo, <strong>${fmtNum(p.entries)}</strong> dòng công việc
        và <strong>${fmtNum(p.audit_log)}</strong> bản ghi lịch sử, từ ngày ${dmy(p.first_date)} đến ${dmy(p.last_date)}.</div></div>
      <ol class="purge-steps">
        <li><div class="row"><button class="btn btn-accent" id="purge-backup" type="button">⬇ Bước 1: Tải bản sao lưu phần này</button>
          <span class="small" id="purge-backup-ok"></span></div></li>
        <li><label class="field"><span>Bước 2: Gõ chữ <strong>XOA</strong> để xác nhận</span>
            <input id="purge-confirm" autocomplete="off" placeholder="XOA" disabled></label>
          <button class="btn btn-danger-solid" id="purge-go" type="button" disabled>Xóa vĩnh viễn</button></li>
      </ol>`;
    let ticket = null;
    const confirmInput = $('#purge-confirm', result);
    const goBtn = $('#purge-go', result);
    const refreshGo = () => { goBtn.disabled = !ticket || confirmInput.value.trim().toUpperCase() !== 'XOA'; };
    confirmInput.oninput = refreshGo;
    $('#purge-backup', result).onclick = async (ev) => {
      const btn = ev.currentTarget;
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Đang sao lưu…';
      try {
        const [data, ExcelJS] = await Promise.all([rpc('admin_purge_backup', { p_before: before }), loadExcelJS()]);
        const wb = window.ExcelExport.buildBackupWorkbook(ExcelJS, data);
        const buf = await wb.xlsx.writeBuffer();
        downloadBlob(new Blob([buf], { type: XLSX_TYPE }), window.ExcelExport.backupFileName(data.generated_at, before));
        ticket = data.ticket;
        $('#purge-backup-ok', result).innerHTML = '<span class="badge badge-ok">✓ Đã tải bản sao lưu</span>';
        confirmInput.disabled = false;
        confirmInput.focus();
        refreshGo();
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    };
    goBtn.onclick = async () => {
      const ok = await confirmDialog('Xóa vĩnh viễn dữ liệu cũ',
        `Xóa ${fmtNum(p.reports)} báo cáo và ${fmtNum(p.entries)} dòng công việc trước ngày ${dmy(before)}?\n\nThao tác này KHÔNG hoàn tác được. Hãy chắc chắn bạn đã cất giữ file sao lưu.`,
        'Xóa vĩnh viễn', true);
      if (!ok) return;
      goBtn.disabled = true;
      try {
        const r = await rpc('admin_purge', { p_before: before, p_ticket: ticket, p_confirm: confirmInput.value.trim().toUpperCase() });
        toast(r.message);
        await loadStorage();
        openDialog('Đã xóa dữ liệu cũ', `
          <p>${esc(r.message)}</p>
          <p class="small muted">Con số dung lượng có thể <strong>chưa giảm ngay</strong>: phần trống sẽ được dùng lại cho dữ liệu mới,
            nên dung lượng sẽ không tăng thêm trong một thời gian. Muốn con số giảm hẳn, vào Supabase → SQL Editor và chạy lần lượt:
            <code>vacuum full private.entries;</code> <code>vacuum full private.audit_log;</code> <code>vacuum full private.reports;</code></p>`,
          '<button class="btn" data-close>Đã hiểu</button>');
      } catch (err) {
        toast(err.message, true);
        refreshGo();
      }
    };
  };
}

async function downloadBackup(btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Đang sao lưu…';
  try {
    const [data, ExcelJS] = await Promise.all([rpc('admin_backup'), loadExcelJS()]);
    const wb = window.ExcelExport.buildBackupWorkbook(ExcelJS, data);
    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(new Blob([buf], { type: XLSX_TYPE }), window.ExcelExport.backupFileName(data.generated_at));
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
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
      return `<div class="user-row" data-id="${u.id}">${head}<div class="small">Toàn quyền</div><div></div><div></div>
        <div class="user-actions"><button class="btn btn-ghost btn-sm" data-a="sig">${u.signature ? '✍️ Chữ ký' : '+ Chữ ký'}</button></div></div>`;
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
        ${u.role === 'manager' ? `<button class="btn btn-ghost btn-sm" data-a="sig">${u.signature ? '✍️ Chữ ký' : '+ Chữ ký'}</button>` : ''}
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
    else if (a === 'sig') {
      return signatureDialog(u, (sig, name) => rpc('admin_set_signature', { p_user_id: u.id, p_signature: sig, p_name: name }), loadUsers);
    }
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

/** Ô xem trước chữ ký + tên in bên dưới (giống ô "Người duyệt" trong Excel) */
function sigPreviewHTML(u) {
  return `<div class="sig-preview"><img data-img alt="Ảnh chữ ký" ${u.signature ? `src="${u.signature}"` : 'hidden'}>
    <span data-none class="muted small" ${u.signature ? 'hidden' : ''}>Chưa có chữ ký</span>
    <div class="sig-name" data-sig-name>${esc(u.signature_name || u.full_name)}</div></div>`;
}

/** Chèn ảnh chữ ký (Quản lý tự làm ở trang Tài khoản, Admin sửa giúp ở trang Quản trị).
 *  Ảnh thu về khung 300×120 PNG: nhỏ, cùng tỉ lệ ô "Người duyệt" trong Excel. */
function signatureDialog(u, saveRpc, done) {
  let data = u.signature || null;
  const d = openDialog(`Chữ ký duyệt · ${u.full_name}`, `
    <div class="stack">
      <p class="small muted">Chữ ký và tên bên dưới sẽ in vào ô "Người duyệt" của file Excel khi bấm phê duyệt.
        Nên dùng ảnh chữ ký trên nền trắng, chụp rõ nét.</p>
      ${sigPreviewHTML(u)}
      <label class="field"><span>Chọn ảnh chữ ký</span><input type="file" accept="image/*" data-file></label>
      <label class="field"><span>Tên dưới chữ ký</span><input data-name maxlength="100" value="${esc(u.signature_name || u.full_name)}">
        <span class="hint">Chỉ ghi họ tên, VD: Trần Văn A. Để trống thì lấy họ tên tài khoản.</span></label>
      <div class="form-error" data-err hidden></div>
    </div>`, `${u.signature ? '<button class="btn btn-danger" data-del>Xóa chữ ký</button>' : ''}
    <button class="btn btn-ghost" data-close>Hủy</button><button class="btn" data-save>Lưu chữ ký</button>`);
  const img = $('[data-img]', d);
  const nameIn = $('[data-name]', d);
  nameIn.oninput = () => { $('[data-sig-name]', d).textContent = nameIn.value.trim() || u.full_name; };
  const err = (m) => { const e = $('[data-err]', d); e.textContent = m; e.hidden = !m; };
  $('[data-file]', d).onchange = (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const src = URL.createObjectURL(file);
    const pic = new Image();
    pic.onload = () => {
      const c = document.createElement('canvas');
      c.width = 300; c.height = 120;
      const k = Math.min(c.width / pic.width, c.height / pic.height);
      const w = pic.width * k, h = pic.height * k;
      c.getContext('2d').drawImage(pic, (c.width - w) / 2, (c.height - h) / 2, w, h);
      URL.revokeObjectURL(src);
      data = c.toDataURL('image/png');
      img.src = data; img.hidden = false; $('[data-none]', d).hidden = true; err('');
    };
    pic.onerror = () => err('Không đọc được ảnh này, hãy chọn file ảnh khác (JPG, PNG).');
    pic.src = src;
  };
  const save = async (value) => {
    const name = nameIn.value.trim();
    try { const r = await saveRpc(value, name === u.full_name ? '' : name); closeDialog(); toast(r.message); done(value, name); }
    catch (e) { err(e.message); }
  };
  $('[data-save]', d).onclick = () => (data ? save(data) : err('Hãy chọn ảnh chữ ký.'));
  const del = $('[data-del]', d);
  if (del) del.onclick = () => save(null);
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
      ${u.role === 'manager' || u.role === 'admin' ? `<section class="card" id="sig-card">
        <h2>Chữ ký duyệt</h2>
        <p class="muted small">Khi bạn bấm Phê duyệt, chữ ký và tên này được in vào ô "Người duyệt" của file Excel.</p>
        <div class="stack">${sigPreviewHTML(u)}
          <button class="btn" data-my-sig>${u.signature ? 'Đổi chữ ký' : '+ Chèn chữ ký'}</button></div>
      </section>` : ''}
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
  const mySig = $('[data-my-sig]');
  if (mySig) {
    mySig.onclick = () => signatureDialog(u, (sig, name) => rpc('set_my_signature', { p_signature: sig, p_name: name }), (sig, name) => {
      u.signature = sig; u.signature_name = sig && name && name !== u.full_name ? name : null; renderAccount();
    });
  }
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
