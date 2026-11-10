# Báo cáo công việc hàng ngày – Phòng Kỹ thuật

Website nhập, tổng hợp, phê duyệt và xuất Excel báo cáo sửa chữa hàng ngày cho 3 nhóm **Điện**, **Cơ Khí**, **PM**.

```
Điện thoại / máy tính
        │
        ▼
GitHub Pages   thư mục web/  – giao diện, file mẫu Excel, tạo file Excel ngay trên trình duyệt
        │  (HTTPS)
        ▼
Supabase       supabase/schema.sql – cơ sở dữ liệu PostgreSQL + các hàm API tự kiểm tra quyền
```

- **Không cần máy chủ riêng**, miễn phí: GitHub Pages + gói Free của Supabase.
- Mật khẩu băm **bcrypt** (pgcrypto, cost 12). Phiên đăng nhập 12 giờ, lưu dạng băm SHA-256.
- Mọi bảng nằm trong schema `private` — trình duyệt **không đọc/ghi trực tiếp được**. Trình duyệt chỉ gọi các hàm API trong `public`, và **mỗi hàm tự kiểm tra quyền ở máy chủ**.

---

## Cài đặt lần đầu (khoảng 15 phút)

### Bước 1 – Tạo project Supabase
1. Vào <https://supabase.com> → **Start your project** → đăng nhập (có thể dùng tài khoản GitHub).
2. **New project**: đặt tên (ví dụ `bao-cao-ky-thuat`), đặt **Database password** (lưu lại ở nơi an toàn), Region chọn **Southeast Asia (Singapore)** → **Create new project**. Chờ 1–2 phút.

### Bước 2 – Tạo cơ sở dữ liệu
1. Trong project, mở **SQL Editor** (menu trái) → **New query**.
2. Mở file [`supabase/schema.sql`](supabase/schema.sql), copy **toàn bộ** nội dung, dán vào → bấm **Run**. Thấy *Success* là xong.
   (Chạy lại file này nhiều lần cũng không mất dữ liệu – dùng khi cập nhật phiên bản mới.)

### Bước 3 – Tạo tài khoản Admin
Vẫn trong SQL Editor, tạo **New query**, dán dòng sau (sửa họ tên và **đặt mật khẩu mới của bạn**) → **Run**:

```sql
select private.create_admin('k.huy', 'Trần Khánh Huy', 'MatKhauMoiCuaBan123');
```

- Mật khẩu ≥ 8 ký tự, có cả chữ và số.
- Mật khẩu chỉ nằm trong Supabase, **không** nằm trong code trên GitHub.
- Quên mật khẩu Admin? Chạy lại đúng câu lệnh này với mật khẩu mới.

### Bước 4 – Kết nối website với Supabase
1. Trong Supabase, bấm nút **Connect** (đầu trang) hoặc vào **Project Settings → API Keys / Data API**. Lấy:
   - **Project URL** – dạng `https://abcdxyz.supabase.co`
   - Khóa **anon public** (bắt đầu `eyJ…`) hoặc **publishable** (bắt đầu `sb_publishable_…`)
2. Trên GitHub, mở file [`web/config.js`](web/config.js) → bấm biểu tượng ✏️ (Edit) → điền:
   ```js
   window.APP_CONFIG = {
     SUPABASE_URL: 'https://abcdxyz.supabase.co',
     SUPABASE_KEY: 'eyJhbGciOi...',
   };
   ```
   → **Commit changes**.

> Khóa *anon / publishable* được phép công khai: nó chỉ gọi được các hàm API đã tự kiểm tra quyền.
> **Tuyệt đối không** dán khóa `service_role` / `secret` vào đây.

### Bước 5 – Bật GitHub Pages
1. Repo GitHub → **Settings → Pages** → *Build and deployment* → **Source: GitHub Actions** (không cần chọn Jekyll hay Static HTML – repo đã có sẵn workflow `.github/workflows/pages.yml`).
2. Mỗi lần đẩy code lên nhánh `master`, GitHub tự **chạy test rồi đưa thư mục `web/` lên**. Xem tiến trình ở tab **Actions**.
3. Website sẽ ở địa chỉ: `https://<tên-tài-khoản-github>.github.io/<tên-repo>/`

### Bước 6 – Sử dụng
1. Đăng nhập bằng `k.huy` và mật khẩu ở Bước 3.
2. Nhân viên tự **Đăng ký** → Admin vào **Quản trị tài khoản** để duyệt, gán vai trò (Nhân viên / Quản lý), nhóm và phạm vi quản lý.

---

## Lưu ý vận hành

- **Supabase Free tạm dừng project nếu 7 ngày liên tục không có ai dùng.** Dữ liệu vẫn còn; vào trang Supabase bấm *Restore project* là chạy lại.
- **Sao lưu**: Supabase → *Database → Backups* (gói Free không có sao lưu tự động lâu dài). Nên định kỳ xuất dữ liệu: SQL Editor chạy `select * from private.entries` → *Export → CSV*, hoặc dùng `pg_dump` với chuỗi kết nối trong *Connect*.
- Repo GitHub Pages miễn phí phải **Public**: ai cũng xem được code và file mẫu Excel, nhưng **không** xem được dữ liệu báo cáo hay mật khẩu (nằm trong Supabase).
- Đổi biểu mẫu Excel: thay file `web/mau_bao_cao.xlsx`, **giữ nguyên bố cục** (dòng 5 = bộ phận/ngày, dòng 7–26 = dữ liệu, dòng 27–31 = chân trang). Nếu bố cục khác, sửa `LAYOUT` trong `web/excel-export.js`.

## Phân quyền

| Vai trò | Quyền |
|---|---|
| **Admin** | Toàn quyền: duyệt/từ chối đăng ký, gán vai trò và nhóm, khóa/mở khóa, đặt lại mật khẩu, phê duyệt và **hủy phê duyệt**, sửa mọi báo cáo, xuất Excel |
| **Quản lý** | Xem, phê duyệt, sửa và xuất Excel báo cáo của các nhóm được Admin cấp (một vài nhóm hoặc tất cả) |
| **Nhân viên** | Nhập dòng công việc; chỉ xem/sửa/xóa dòng của mình khi báo cáo **chưa phê duyệt** |

Sau khi phê duyệt, nhân viên không thể sửa/xóa/thêm dòng (máy chủ trả lỗi 403). Mọi thay đổi được ghi lịch sử (ai, lúc nào, giá trị cũ → mới); thay đổi sau phê duyệt gắn nhãn **"Sau phê duyệt"**.

## Xuất Excel – ánh xạ vào file mẫu

| Ô mẫu | Dữ liệu |
|---|---|
| B5 | `Bộ phận: <Nhóm>   Ca: ……   Ngày dd Tháng mm Năm yyyy` |
| B / C | Tên máy / Diễn giải công việc |
| D / E | Giờ bắt đầu / kết thúc (`HH:mm`, thêm `(dd/mm)` nếu sang ngày khác) |
| F (Tình trạng) | Tình trạng máy / Ghi chú |
| G | Người thực hiện |
| H (Ghi chú) | `OK` hoặc phần trăm (số, định dạng `0%`) |
| F31 | Họ tên người phê duyệt |

Chỉ xuất được khi mọi dòng có đủ tên máy, diễn giải, giờ bắt đầu, giờ kết thúc, trạng thái — máy chủ kiểm tra và báo rõ dòng nào thiếu trường nào. Báo cáo > 20 dòng tự chèn thêm dòng, khối chữ ký dời xuống. Tên file `BaoCao_<Dien|CoKhi|PM>_<dd-mm-yyyy>.xlsx`.

---

## Dành cho người phát triển

Chạy thử trên máy **không cần tài khoản Supabase** (dùng PostgreSQL nhúng PGlite chạy đúng file `schema.sql`):

```bash
npm install
npm run dev     # http://localhost:3000 – mật khẩu Admin thử in ra cửa sổ dòng lệnh
npm test        # test phân quyền, khóa sửa, xuất Excel trên đúng schema.sql
```

Dữ liệu chạy thử nằm ở `data/dev-db` (xóa thư mục để làm lại từ đầu).

```
web/                  ← đưa lên GitHub Pages
  index.html, app.js, styles.css
  config.js           ← điền URL + khóa Supabase
  excel-export.js     ← tạo file Excel từ mẫu (dùng chung cho trình duyệt và test)
  mau_bao_cao.xlsx    ← file mẫu
  vendor/exceljs.min.js
supabase/schema.sql   ← chạy trong Supabase SQL Editor
dev/                  ← máy chủ chạy thử + giả lập Supabase
test/                 ← test (node --test)
.github/workflows/pages.yml
```
