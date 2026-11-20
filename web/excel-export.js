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

  /** "Người thực hiện": người nhập + người làm cùng */
  function personText(e) {
    return [e.user_name].concat(e.coworker_names || []).filter(Boolean).join(', ');
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
      values[cols.person] = e ? personText(e) : null;
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

  // ------------------------------------------------------------------
  //  SAO LƯU TOÀN BỘ DỮ LIỆU RA EXCEL (trang Admin)
  // ------------------------------------------------------------------
  var ROLE = { admin: 'Admin', manager: 'Quản lý', staff: 'Nhân viên' };
  var STATUS = { pending: 'Chờ duyệt', active: 'Hoạt động', rejected: 'Bị từ chối', locked: 'Đã khóa' };
  var REPORT_STATUS = { draft: 'Đang nhập', approved: 'Đã phê duyệt' };
  var ACTION = { create: 'Thêm dòng', update: 'Sửa dòng', delete: 'Xóa dòng', approve: 'Phê duyệt', unapprove: 'Hủy phê duyệt' };

  function dmy(d) {
    if (!d) return '';
    var p = String(d).split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : d;
  }
  function dt(v) {
    return v ? String(v).replace('T', ' ') : '';
  }

  function addSheet(wb, name, columns, rows) {
    var ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns.map(function (c) { return { header: c[1], key: c[0], width: c[2] }; });
    rows.forEach(function (r) { ws.addRow(r); });
    var head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14532D' } };
    head.alignment = { vertical: 'middle', wrapText: true };
    head.height = 22;
    ws.eachRow(function (row, n) {
      if (n > 1) row.alignment = { vertical: 'top', wrapText: true };
    });
    if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    return ws;
  }

  function buildBackupWorkbook(ExcelJS, data) {
    var wb = new ExcelJS.Workbook();
    wb.creator = 'He thong bao cao cong viec';

    addSheet(wb, 'Dòng công việc', [
      ['date', 'Ngày', 12], ['team', 'Nhóm', 9], ['report_status', 'Trạng thái báo cáo', 15],
      ['machine', 'Tên máy', 24], ['description', 'Diễn giải công việc', 50],
      ['start', 'Bắt đầu', 17], ['end', 'Kết thúc', 17], ['completion', 'Hoàn thành', 11],
      ['note', 'Tình trạng máy / Ghi chú', 36], ['user', 'Người nhập', 22], ['coworkers', 'Người làm cùng', 30],
      ['created', 'Nhập lúc', 19], ['updated', 'Sửa lần cuối', 19], ['id', 'Mã dòng', 9],
    ], (data.entries || []).map(function (e) {
      return {
        date: dmy(e.date), team: e.team, report_status: REPORT_STATUS[e.report_status] || e.report_status,
        machine: e.machine, description: e.description, start: dt(e.start_at), end: dt(e.end_at),
        completion: e.completion >= 100 ? 'OK' : e.completion + '%', note: e.note, user: e.user_name,
        coworkers: (e.coworker_names || []).join(', '), created: e.created_at, updated: e.updated_at, id: e.id,
      };
    }));

    addSheet(wb, 'Báo cáo', [
      ['date', 'Ngày', 12], ['team', 'Nhóm', 9], ['status', 'Trạng thái', 15], ['entries', 'Số dòng', 9],
      ['approved_by', 'Người duyệt', 22], ['approved_at', 'Duyệt lúc', 19],
    ], (data.reports || []).map(function (r) {
      return {
        date: dmy(r.date), team: r.team, status: REPORT_STATUS[r.status] || r.status, entries: r.entries,
        approved_by: r.approved_by || '', approved_at: r.approved_at || '',
      };
    }));

    addSheet(wb, 'Tài khoản', [
      ['username', 'Tên đăng nhập', 18], ['full_name', 'Họ tên', 24], ['role', 'Vai trò', 11], ['team', 'Nhóm', 9],
      ['scope', 'Phạm vi quản lý', 20], ['status', 'Trạng thái', 12], ['created', 'Đăng ký lúc', 19],
    ], (data.users || []).map(function (u) {
      return {
        username: u.username, full_name: u.full_name, role: ROLE[u.role] || u.role, team: u.team || '',
        scope: u.role === 'staff' ? '' : u.manager_all ? 'Tất cả' : (u.manager_teams || []).join(', '),
        status: STATUS[u.status] || u.status, created: u.created_at,
      };
    }));

    addSheet(wb, 'Lịch sử chỉnh sửa', [
      ['created', 'Thời gian', 19], ['date', 'Ngày báo cáo', 12], ['team', 'Nhóm', 9], ['user', 'Người thực hiện', 22],
      ['action', 'Thao tác', 15], ['after', 'Sau phê duyệt', 12], ['entry', 'Mã dòng', 9],
      ['old', 'Giá trị cũ', 45], ['new', 'Giá trị mới', 45],
    ], (data.audit_log || []).map(function (a) {
      return {
        created: a.created_at, date: dmy(a.date), team: a.team || '', user: a.user_name,
        action: ACTION[a.action] || a.action, after: a.after_approval ? 'Có' : '', entry: a.entry_id || '',
        old: a.old_value ? JSON.stringify(a.old_value) : '', new: a.new_value ? JSON.stringify(a.new_value) : '',
      };
    }));

    var info = wb.addWorksheet('Thông tin');
    info.columns = [{ width: 26 }, { width: 40 }];
    [
      ['SAO LƯU DỮ LIỆU BÁO CÁO', ''],
      ['Thời điểm sao lưu', data.generated_at],
      ['Phạm vi', data.before ? 'Các báo cáo trước ngày ' + dmy(data.before) : 'Toàn bộ dữ liệu'],
      ['Số dòng công việc', (data.entries || []).length],
      ['Số báo cáo', (data.reports || []).length],
      ['Số tài khoản', (data.users || []).length],
      ['Số bản ghi lịch sử', (data.audit_log || []).length],
      ['Ghi chú', 'Không chứa mật khẩu. Dùng để lưu trữ/đối chiếu.'],
    ].forEach(function (r) { info.addRow(r); });
    info.getRow(1).font = { bold: true, size: 14 };
    return wb;
  }

  /** SaoLuu_BaoCao_<ngày sao lưu>_<giờ>.xlsx, hoặc SaoLuu_TruocNgay_<mốc>_<ngày sao lưu>_<giờ>.xlsx */
  function backupFileName(generatedAt, before) {
    var d = String(generatedAt || '').slice(0, 10).split('-');
    var t = String(generatedAt || '').slice(11, 16).replace(':', 'h');
    var stamp = d.length === 3 ? d[2] + '-' + d[1] + '-' + d[0] + '_' + t : 'khong-ro';
    if (before) {
      var b = String(before).split('-');
      return 'SaoLuu_TruocNgay_' + b[2] + '-' + b[1] + '-' + b[0] + '_' + stamp + '.xlsx';
    }
    return 'SaoLuu_BaoCao_' + stamp + '.xlsx';
  }

  return {
    buildWorkbook: buildWorkbook, exportFileName: exportFileName, fmtTime: fmtTime, LAYOUT: LAYOUT,
    buildBackupWorkbook: buildBackupWorkbook, backupFileName: backupFileName, personText: personText,
  };
});
