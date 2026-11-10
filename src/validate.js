'use strict';
// Kiểm tra dữ liệu đầu vào phía backend
const { TEAMS } = require('./db');
const { HttpError } = require('./auth');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isValidDateTime(s) {
  if (typeof s !== 'string' || !DATETIME_RE.test(s)) return false;
  const [d, t] = s.split('T');
  const [hh, mm] = t.split(':').map(Number);
  return isValidDate(d) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}

function str(v, max) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, 'Dữ liệu không hợp lệ.');
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `Nội dung quá dài (tối đa ${max} ký tự).`);
  return s;
}

/**
 * Trạng thái hoàn thành: "OK" hoặc số/chuỗi phần trăm 0–99.
 * Trả về số nguyên 0–100 (100 = OK).
 */
function parseCompletion(v) {
  if (v === undefined || v === null || v === '') return 100;
  if (typeof v === 'string') {
    const s = v.trim().toUpperCase();
    if (s === 'OK' || s === '100' || s === '100%') return 100;
    const m = /^(\d{1,2})\s*%?$/.exec(s);
    if (m) return Number(m[1]);
    throw new HttpError(400, 'Trạng thái hoàn thành phải là "OK" hoặc phần trăm từ 0% đến 99%.');
  }
  if (Number.isInteger(v) && v >= 0 && v <= 100) return v;
  throw new HttpError(400, 'Trạng thái hoàn thành phải là "OK" hoặc phần trăm từ 0% đến 99%.');
}

function team(v) {
  if (!TEAMS.includes(v)) throw new HttpError(400, 'Nhóm không hợp lệ (Điện / Cơ Khí / PM).');
  return v;
}

function date(v) {
  if (!isValidDate(v)) throw new HttpError(400, 'Ngày không hợp lệ (định dạng YYYY-MM-DD).');
  return v;
}

/** Kiểm tra dữ liệu 1 dòng công việc. partial = true khi cập nhật từng phần. */
function entryInput(body, partial = false) {
  const b = body || {};
  const out = {};
  if (!partial || 'machine' in b) {
    out.machine = str(b.machine, 200);
    if (!out.machine) throw new HttpError(400, 'Tên máy là bắt buộc.');
  }
  if (!partial || 'description' in b) out.description = str(b.description, 4000);
  for (const k of ['start_at', 'end_at']) {
    if (!partial || k in b) {
      const v = b[k] === undefined || b[k] === null ? '' : b[k];
      if (v === '') out[k] = null;
      else if (isValidDateTime(v)) out[k] = v;
      else throw new HttpError(400, `${k === 'start_at' ? 'Thời gian bắt đầu' : 'Thời gian kết thúc'} không hợp lệ.`);
    }
  }
  if (!partial || 'completion' in b) out.completion = parseCompletion(b.completion);
  if (!partial || 'note' in b) out.note = str(b.note, 4000);
  return out;
}

function checkTimeOrder(start, end) {
  if (start && end && end < start) throw new HttpError(400, 'Thời gian kết thúc phải sau thời gian bắt đầu.');
}

function password(v) {
  if (typeof v !== 'string' || v.length < 8 || v.length > 128)
    throw new HttpError(400, 'Mật khẩu phải có từ 8 đến 128 ký tự.');
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) throw new HttpError(400, 'Mật khẩu phải có cả chữ và số.');
  return v;
}

function username(v) {
  if (typeof v !== 'string' || !USERNAME_RE.test(v.trim()))
    throw new HttpError(400, 'Tên đăng nhập 3–32 ký tự, chỉ gồm chữ không dấu, số, dấu chấm, gạch dưới, gạch ngang.');
  return v.trim();
}

function fullName(v) {
  const s = str(v, 100);
  if (s.length < 2) throw new HttpError(400, 'Vui lòng nhập họ tên.');
  return s;
}

module.exports = {
  isValidDate,
  isValidDateTime,
  parseCompletion,
  entryInput,
  checkTimeOrder,
  team,
  date,
  password,
  username,
  fullName,
  str,
};
