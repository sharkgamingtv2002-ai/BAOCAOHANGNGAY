# Báo cáo công việc hàng ngày – Phòng Kỹ thuật

Website nhập, tổng hợp, phê duyệt và xuất Excel báo cáo sửa chữa hàng ngày cho 3 nhóm **Điện**, **Cơ Khí**, **PM**.

- Backend: Node.js + Express
- CSDL: SQLite (module tích hợp `node:sqlite` của Node, không cần biên dịch native, API giống better-sqlite3)
- Mật khẩu: bcrypt (thư viện `bcryptjs`, cost 12)
- Đăng nhập: phiên lưu trong CSDL, cookie `httpOnly` + `SameSite=Lax`
- Xuất Excel: ExcelJS mở file mẫu `templates/mau_bao_cao.xlsx` rồi điền dữ liệu

## Yêu cầu

- Node.js **22.13 trở lên** (đã thử với Node 26)

## Cài đặt và chạy

```bash
npm install
npm run seed      # tạo tài khoản gốc (máy chủ cũng tự tạo khi khởi động)
npm start         # http://localhost:3000
```

Tài khoản gốc: `k.huy`. Mật khẩu ban đầu nằm trong `src/seed.js`. **Hãy đổi mật khẩu ngay sau lần đăng nhập đầu** (trang *Tài khoản*), đồng thời sửa họ tên hiển thị, vì tên này được in ở ô "Người duyệt" trong file Excel.

Chạy test:

```bash
npm test
```

### Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng web |
| `HOST` | `0.0.0.0` | Địa chỉ lắng nghe |
| `DB_FILE` | `data/app.db` | File CSDL SQLite |
| `TEMPLATE_FILE` | `templates/mau_bao_cao.xlsx` | File mẫu Excel |
| `COOKIE_SECURE` | (trống) | Đặt `1` khi chạy sau HTTPS |
| `TRUST_PROXY` | (trống) | Đặt `1` khi chạy sau reverse proxy (IIS/Nginx) |

## Phân quyền

| Vai trò | Quyền |
|---|---|
| **Admin** | Toàn quyền: duyệt/từ chối đăng ký, gán vai trò và nhóm, khóa/mở khóa, đặt lại mật khẩu, phê duyệt và **hủy phê duyệt**, sửa mọi báo cáo, xuất Excel |
| **Quản lý** | Xem, phê duyệt, sửa và xuất Excel báo cáo của các nhóm được Admin cấp (một vài nhóm hoặc tất cả) |
| **Nhân viên** | Nhập dòng công việc; chỉ xem/sửa/xóa dòng của mình khi báo cáo **chưa phê duyệt** |

Mọi kiểm tra quyền đều thực hiện ở backend. Sau khi phê duyệt, nhân viên không thể sửa, xóa hoặc thêm dòng (API trả lỗi 403). Mọi thay đổi đều được ghi vào lịch sử (ai, lúc nào, giá trị cũ → mới); thay đổi sau phê duyệt được gắn nhãn **"Sau phê duyệt"**.

## Xuất Excel – ánh xạ vào file mẫu

| Ô mẫu | Dữ liệu |
|---|---|
| B5 | `Bộ phận: <Nhóm>   Ca: ……   Ngày dd Tháng mm Năm yyyy` |
| B / C | Tên máy / Diễn giải công việc |
| D / E | Giờ bắt đầu / kết thúc (`HH:mm`, thêm `(dd/mm)` nếu sang ngày khác) |
| F (Tình trạng) | Tình trạng máy / Ghi chú |
| G | Người thực hiện |
| H (Ghi chú) | `OK` hoặc phần trăm (định dạng số `0%`) |
| F31 | Họ tên người phê duyệt |

- Các dòng được sắp theo giờ bắt đầu. Báo cáo có hơn 20 dòng sẽ tự chèn thêm dòng; khối "Người duyệt"/mã hiệu và vùng in được dời xuống theo.
- Chỉ xuất được khi mọi dòng có đủ: tên máy, diễn giải, giờ bắt đầu, giờ kết thúc, trạng thái. Nếu thiếu, hệ thống báo rõ dòng nào thiếu trường nào.
- Tên file: `BaoCao_<Dien|CoKhi|PM>_<dd-mm-yyyy>.xlsx`.
- Khi biểu mẫu thay đổi (ví dụ lần ban hành mới), chỉ cần thay file `templates/mau_bao_cao.xlsx`, **giữ nguyên bố cục** (dòng 5 = bộ phận/ngày, dòng 7–26 = dữ liệu, dòng 27–31 = chân trang). Nếu bố cục khác, sửa hằng số `LAYOUT` trong `src/excel.js`.

## Triển khai lên máy chủ nội bộ (Windows)

1. Cài Node.js LTS (≥ 22.13) trên máy chủ.
2. Chép thư mục dự án (không cần `node_modules`, `data`) rồi chạy `npm install --omit=dev`.
3. Chạy như dịch vụ Windows để tự khởi động lại, ví dụ dùng [NSSM](https://nssm.cc):
   ```bat
   nssm install BaoCaoKyThuat "C:\Program Files\nodejs\node.exe" "D:\bao-cao\src\server.js"
   nssm set BaoCaoKyThuat AppDirectory "D:\bao-cao"
   nssm set BaoCaoKyThuat AppEnvironmentExtra PORT=3000
   nssm start BaoCaoKyThuat
   ```
   Hoặc dùng PM2: `npm i -g pm2 && pm2 start src/server.js --name bao-cao && pm2 save`.
4. Mở cổng trên Windows Firewall (chỉ cho mạng nội bộ):
   ```bat
   netsh advfirewall firewall add rule name="BaoCao 3000" dir=in action=allow protocol=TCP localport=3000 remoteip=localsubnet
   ```
5. Người dùng truy cập `http://<IP-máy-chủ>:3000` từ máy tính hoặc điện thoại trong mạng công ty.
6. (Khuyến nghị) Đặt sau IIS/Nginx có HTTPS, rồi bật `COOKIE_SECURE=1` và `TRUST_PROXY=1`.

### Sao lưu

Toàn bộ dữ liệu nằm trong `data/app.db` (kèm `app.db-wal`, `app.db-shm` khi đang chạy). Sao lưu định kỳ bằng lệnh an toàn khi máy chủ đang chạy:

```bash
mkdir -p backup
node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('data/app.db').exec(\"VACUUM INTO 'backup/app-\"+new Date().toISOString().slice(0,10)+\".db'\")"
```

## Cấu trúc thư mục

```
src/
  server.js        khởi động máy chủ
  app.js           cấu hình Express, bảo mật, xử lý lỗi
  db.js            kết nối & lược đồ SQLite
  seed.js          tạo tài khoản gốc
  auth.js          phiên đăng nhập, hàm kiểm tra quyền
  validate.js      kiểm tra dữ liệu đầu vào
  excel.js         xuất Excel từ file mẫu
  routes/          auth, admin, reports
public/            giao diện (HTML/CSS/JS thuần, tiếng Việt, responsive)
templates/         file mẫu mau_bao_cao.xlsx
test/              test API (node:test)
```
