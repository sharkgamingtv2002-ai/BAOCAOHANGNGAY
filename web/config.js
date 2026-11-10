/*
 * CẤU HÌNH KẾT NỐI SUPABASE
 * Lấy 2 giá trị trong Supabase → Project Settings → API (hoặc nút "Connect"):
 *   - SUPABASE_URL : Project URL, dạng https://xxxxxxxx.supabase.co
 *   - SUPABASE_KEY : khóa "anon public" (eyJ...) hoặc "publishable" (sb_publishable_...)
 * Khóa này được phép công khai: nó chỉ gọi được các hàm API đã tự kiểm tra quyền.
 * TUYỆT ĐỐI KHÔNG dán khóa "service_role" / "secret" vào đây.
 */
window.APP_CONFIG = {
  SUPABASE_URL: 'https://naybfnrhpphhbnfatfdz.supabase.co',
  SUPABASE_KEY: 'sb_publishable_2MFX8iZbQMF1VM93gm0gow_C8rHP4R1',
};
