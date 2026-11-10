'use strict';
// Xuất báo cáo ra Excel bằng cách MỞ FILE MẪU và điền dữ liệu (không vẽ lại từ đầu)
const path = require('path');
const ExcelJS = require('exceljs');

const TEMPLATE = process.env.TEMPLATE_FILE || path.join(__dirname, '..', 'templates', 'mau_bao_cao.xlsx');

// Vị trí trong file mẫu (sheet "sua chua hang ngay")
const LAYOUT = {
  headerCell: 'B5', // Bộ phận … Ca … Ngày … Tháng … Năm …
  firstDataRow: 7,
  templateDataRows: 20, // dòng 7–26
  footerStart: 27, // dòng 27–31: khối "Người duyệt" + mã hiệu
  footerEnd: 31,
  approverRowOffset: 4, // F31 = footerStart + 4
  cols: { machine: 2, description: 3, start: 4, end: 5, note: 6, person: 7, completion: 8 }, // B..H
  firstCol: 2,
  lastCol: 8,
};

const TEAM_SLUG = { 'Điện': 'Dien', 'Cơ Khí': 'CoKhi', PM: 'PM' };

function exportFileName(team, date) {
  const [y, m, d] = date.split('-');
  return `BaoCao_${TEAM_SLUG[team] || team}_${d}-${m}-${y}.xlsx`;
}

/** Danh sách dòng còn thiếu trường bắt buộc khi xuất */
function findMissing(entries) {
  const out = [];
  entries.forEach((e, i) => {
    const fields = [];
    if (!e.machine || !String(e.machine).trim()) fields.push('Tên máy');
    if (!e.description || !String(e.description).trim()) fields.push('Diễn giải công việc');
    if (!e.start_at) fields.push('Thời gian bắt đầu');
    if (!e.end_at) fields.push('Thời gian kết thúc');
    if (e.completion === null || e.completion === undefined) fields.push('Trạng thái');
    if (fields.length) out.push({ row: i + 1, entry_id: e.id, user_name: e.user_name, machine: e.machine, fields });
  });
  return out;
}

/** "HH:mm", thêm "(dd/mm)" nếu khác ngày báo cáo (ví dụ làm qua đêm) */
function fmtTime(dt, reportDate) {
  if (!dt) return '';
  const [d, t] = dt.split('T');
  if (d === reportDate) return t;
  const [, m, dd] = d.split('-');
  return `${t} (${dd}/${m})`;
}

function fmtCompletion(c) {
  return c >= 100 ? 'OK' : `${c}%`;
}

const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);

/** Ước lượng chiều cao dòng (ExcelJS không tự co giãn được) */
function estimateHeight(values, widths, minHeight) {
  let lines = 1;
  values.forEach((val, i) => {
    const capacity = Math.max(1, Math.floor(widths[i] * 1.1)); // số ký tự cỡ 11 trên 1 dòng
    const n = String(val || '')
      .split('\n')
      .reduce((s, part) => s + Math.max(1, Math.ceil(part.length / capacity)), 0);
    lines = Math.max(lines, n);
  });
  return Math.max(minHeight, lines * 15 + 6);
}

async function buildWorkbook(report) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const ws = wb.worksheets[0];
  const { cols, firstDataRow, templateDataRows, footerStart, footerEnd, firstCol, lastCol } = LAYOUT;

  // 1) Dòng Bộ phận / Ngày tháng năm
  const [y, m, d] = report.date.split('-');
  ws.getCell(LAYOUT.headerCell).value = `Bộ phận: ${report.team}        Ca: ……………………        Ngày ${d}  Tháng ${m}  Năm ${y}`;

  const entries = report.entries;
  const extra = Math.max(0, entries.length - templateDataRows);
  const styleRow = firstDataRow + templateDataRows - 1; // dòng 26 làm mẫu định dạng
  const baseHeight = ws.getRow(styleRow).height || 27.95;
  const baseStyles = [];
  for (let c = firstCol; c <= lastCol; c++) baseStyles[c] = clone(ws.getRow(styleRow).getCell(c).style);

  // 2) Nếu > 20 dòng: dời khối chân trang xuống, giữ nguyên định dạng và ô gộp
  if (extra > 0) {
    const footerMerges = ws.model.merges.filter((rng) => {
      const row = Number(rng.split(':')[0].replace(/[A-Z]+/, ''));
      return row >= footerStart && row <= footerEnd;
    });
    const saved = [];
    for (let r = footerStart; r <= footerEnd; r++) {
      const row = ws.getRow(r);
      const cells = [];
      for (let c = firstCol; c <= lastCol; c++) {
        const cell = row.getCell(c);
        cells.push({ c, value: cell.isMerged && cell.master !== cell ? null : cell.value, style: clone(cell.style) });
      }
      saved.push({ r, height: row.height, cells });
    }
    footerMerges.forEach((rng) => ws.unMergeCells(rng));
    // Xóa khối cũ
    for (let r = footerStart; r <= footerEnd; r++) {
      const row = ws.getRow(r);
      for (let c = firstCol; c <= lastCol; c++) {
        row.getCell(c).value = null;
        row.getCell(c).style = {};
      }
    }
    // Viết lại khối chân trang ở vị trí mới
    for (const s of saved) {
      const row = ws.getRow(s.r + extra);
      row.height = s.height;
      for (const cell of s.cells) {
        const target = row.getCell(cell.c);
        target.style = cell.style;
        if (cell.value !== null) target.value = cell.value;
      }
    }
    footerMerges.forEach((rng) => ws.mergeCells(rng.replace(/\d+/g, (n) => String(Number(n) + extra))));
    ws.pageSetup.printArea = `B1:H${footerEnd + extra}`;
  }

  // 3) Điền dữ liệu
  const widths = [];
  for (let c = firstCol; c <= lastCol; c++) widths[c] = ws.getColumn(c).width || 10;
  const rowCount = Math.max(templateDataRows, entries.length);
  for (let i = 0; i < rowCount; i++) {
    const row = ws.getRow(firstDataRow + i);
    const e = entries[i];
    const values = {
      [cols.machine]: e ? e.machine : null,
      [cols.description]: e ? e.description : null,
      [cols.start]: e ? fmtTime(e.start_at, report.date) : null,
      [cols.end]: e ? fmtTime(e.end_at, report.date) : null,
      [cols.note]: e ? e.note || '' : null,
      [cols.person]: e ? e.user_name : null,
      // OK = chữ; phần trăm = số kiểu 0% (tránh cảnh báo "số lưu dạng chữ" của Excel)
      [cols.completion]: e ? (e.completion >= 100 ? 'OK' : e.completion / 100) : null,
    };
    for (let c = firstCol; c <= lastCol; c++) {
      const cell = row.getCell(c);
      const style = clone(baseStyles[c]);
      const center = c === cols.start || c === cols.end || c === cols.completion || c === cols.machine;
      style.alignment = { ...(style.alignment || {}), vertical: 'middle', horizontal: center ? 'center' : 'left', wrapText: true };
      if (c === cols.completion && typeof values[c] === 'number') style.numFmt = '0%';
      cell.style = style;
      cell.value = values[c];
    }
    row.height = e
      ? estimateHeight(
          [values[cols.machine], values[cols.description], values[cols.note], values[cols.person]],
          [widths[cols.machine], widths[cols.description], widths[cols.note], widths[cols.person]],
          baseHeight
        )
      : baseHeight;
  }

  // 4) Tên người duyệt (ô gộp F31:H31)
  if (report.status === 'approved' && report.approved_by_name) {
    ws.getCell(`F${footerEnd + extra}`).value = report.approved_by_name;
  }

  wb.creator = 'He thong bao cao cong viec';
  return wb;
}

module.exports = { buildWorkbook, findMissing, exportFileName, fmtTime, fmtCompletion, LAYOUT, TEMPLATE };
