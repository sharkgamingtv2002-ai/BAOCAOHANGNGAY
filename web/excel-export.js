/**
 * Xuất báo cáo ra Excel bằng cách MỞ FILE MẪU mau_bao_cao.xlsx và điền dữ liệu.
 * Chạy được cả trên trình duyệt (window.ExcelExport) và Node (require) để test.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ExcelExport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Vị trí trong file mẫu (sheet "sua chua hang ngay")
  var LAYOUT = {
    headerCell: 'B5', // Bộ phận … Ca … Ngày … Tháng … Năm …
    firstDataRow: 7,
    templateDataRows: 20, // dòng 7–26
    footerStart: 27, // dòng 27–31: khối "Người duyệt" + mã hiệu
    footerEnd: 31, // F31 = tên người duyệt
    cols: { machine: 2, description: 3, start: 4, end: 5, note: 6, person: 7, completion: 8 }, // B..H
    firstCol: 2,
    lastCol: 8,
  };

  var TEAM_SLUG = { 'Điện': 'Dien', 'Cơ Khí': 'CoKhi', PM: 'PM' };

  function exportFileName(team, date) {
    var p = date.split('-');
    return 'BaoCao_' + (TEAM_SLUG[team] || team) + '_' + p[2] + '-' + p[1] + '-' + p[0] + '.xlsx';
  }

  /** "HH:mm", thêm "(dd/mm)" nếu khác ngày báo cáo (làm qua đêm) */
  function fmtTime(dt, reportDate) {
    if (!dt) return '';
    var parts = dt.split('T');
    if (parts[0] === reportDate) return parts[1];
    var d = parts[0].split('-');
    return parts[1] + ' (' + d[2] + '/' + d[1] + ')';
  }

  function clone(o) {
    return o ? JSON.parse(JSON.stringify(o)) : o;
  }

  /** Ước lượng chiều cao dòng (ExcelJS không tự co giãn được) */
  function estimateHeight(values, widths, minHeight) {
    var lines = 1;
    values.forEach(function (val, i) {
      var capacity = Math.max(1, Math.floor(widths[i] * 1.1));
      var n = String(val || '')
        .split('\n')
        .reduce(function (s, part) {
          return s + Math.max(1, Math.ceil(part.length / capacity));
        }, 0);
      lines = Math.max(lines, n);
    });
    return Math.max(minHeight, lines * 15 + 6);
  }

  /**
   * @param ExcelJS   thư viện ExcelJS
   * @param template  nội dung file mẫu (ArrayBuffer / Buffer)
   * @param report    { date, team, status, approved_by_name, entries: [...] }
   */
  async function buildWorkbook(ExcelJS, template, report) {
    var wb = new ExcelJS.Workbook();
    await wb.xlsx.load(template);
    var ws = wb.worksheets[0];
    var L = LAYOUT, cols = L.cols;
    var r, c;

    // 1) Dòng Bộ phận / Ngày tháng năm
    var dp = report.date.split('-');
    ws.getCell(L.headerCell).value =
      'Bộ phận: ' + report.team + '        Ca: ……………………        Ngày ' + dp[2] + '  Tháng ' + dp[1] + '  Năm ' + dp[0];

    var entries = report.entries;
    var extra = Math.max(0, entries.length - L.templateDataRows);
    var styleRow = L.firstDataRow + L.templateDataRows - 1; // dòng 26 làm mẫu định dạng
    var baseHeight = ws.getRow(styleRow).height || 27.95;
    var baseStyles = [];
    for (c = L.firstCol; c <= L.lastCol; c++) baseStyles[c] = clone(ws.getRow(styleRow).getCell(c).style);

    // 2) Nếu > 20 dòng: dời khối chân trang xuống, giữ nguyên định dạng và ô gộp
    if (extra > 0) {
      var footerMerges = ws.model.merges.filter(function (rng) {
        var row = Number(rng.split(':')[0].replace(/[A-Z]+/, ''));
        return row >= L.footerStart && row <= L.footerEnd;
      });
      var saved = [];
      for (r = L.footerStart; r <= L.footerEnd; r++) {
        var row = ws.getRow(r);
        var cells = [];
        for (c = L.firstCol; c <= L.lastCol; c++) {
          var cell = row.getCell(c);
          cells.push({ c: c, value: cell.isMerged && cell.master !== cell ? null : cell.value, style: clone(cell.style) });
        }
        saved.push({ r: r, height: row.height, cells: cells });
      }
      footerMerges.forEach(function (rng) { ws.unMergeCells(rng); });
      for (r = L.footerStart; r <= L.footerEnd; r++) {
        for (c = L.firstCol; c <= L.lastCol; c++) {
          ws.getRow(r).getCell(c).value = null;
          ws.getRow(r).getCell(c).style = {};
        }
      }
      saved.forEach(function (s) {
        var row2 = ws.getRow(s.r + extra);
        row2.height = s.height;
        s.cells.forEach(function (sc) {
          var target = row2.getCell(sc.c);
          target.style = sc.style;
          if (sc.value !== null) target.value = sc.value;
        });
      });
      footerMerges.forEach(function (rng) {
        ws.mergeCells(rng.replace(/\d+/g, function (n) { return String(Number(n) + extra); }));
      });
      ws.pageSetup.printArea = 'B1:H' + (L.footerEnd + extra);
    }

    // 3) Điền dữ liệu
    var widths = [];
    for (c = L.firstCol; c <= L.lastCol; c++) widths[c] = ws.getColumn(c).width || 10;
    var rowCount = Math.max(L.templateDataRows, entries.length);
    for (var i = 0; i < rowCount; i++) {
      var dataRow = ws.getRow(L.firstDataRow + i);
      var e = entries[i];
      var values = {};
      values[cols.machine] = e ? e.machine : null;
      values[cols.description] = e ? e.description : null;
      values[cols.start] = e ? fmtTime(e.start_at, report.date) : null;
      values[cols.end] = e ? fmtTime(e.end_at, report.date) : null;
      values[cols.note] = e ? e.note || '' : null;
      values[cols.person] = e ? e.user_name : null;
      // OK = chữ; phần trăm = số kiểu 0% (tránh cảnh báo "số lưu dạng chữ" của Excel)
      values[cols.completion] = e ? (e.completion >= 100 ? 'OK' : e.completion / 100) : null;
      for (c = L.firstCol; c <= L.lastCol; c++) {
        var dc = dataRow.getCell(c);
        var style = clone(baseStyles[c]);
        var center = c === cols.start || c === cols.end || c === cols.completion || c === cols.machine;
        style.alignment = Object.assign({}, style.alignment || {}, {
          vertical: 'middle', horizontal: center ? 'center' : 'left', wrapText: true,
        });
        if (c === cols.completion && typeof values[c] === 'number') style.numFmt = '0%';
        dc.style = style;
        dc.value = values[c];
      }
      dataRow.height = e
        ? estimateHeight(
            [values[cols.machine], values[cols.description], values[cols.note], values[cols.person]],
            [widths[cols.machine], widths[cols.description], widths[cols.note], widths[cols.person]],
            baseHeight
          )
        : baseHeight;
    }

    // 4) Tên người duyệt (ô gộp F31:H31)
    if (report.status === 'approved' && report.approved_by_name) {
      ws.getCell('F' + (L.footerEnd + extra)).value = report.approved_by_name;
    }
    wb.creator = 'He thong bao cao cong viec';
    return wb;
  }

  return { buildWorkbook: buildWorkbook, exportFileName: exportFileName, fmtTime: fmtTime, LAYOUT: LAYOUT };
});
