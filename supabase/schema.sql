-- =====================================================================
--  BÁO CÁO CÔNG VIỆC HÀNG NGÀY – Schema cho Supabase (PostgreSQL)
--  Chạy toàn bộ file này trong Supabase → SQL Editor. Chạy lại nhiều lần được.
--
--  Bảo mật:
--   * Mọi bảng nằm trong schema "private" – trình duyệt KHÔNG đọc/ghi trực tiếp được.
--   * Trình duyệt chỉ gọi được các hàm API trong schema "public" (qua /rest/v1/rpc/...).
--   * Mỗi hàm API tự kiểm tra phiên đăng nhập và quyền (SECURITY DEFINER).
--   * Mật khẩu băm bcrypt (pgcrypto, cost 12). Phiên đăng nhập lưu dạng băm SHA-256.
--   * Lỗi trả về dạng mã PTxxx → PostgREST chuyển thành HTTP status xxx.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema private from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema private from authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------
--  BẢNG
-- ---------------------------------------------------------------------
create table if not exists private.users (
  id            bigint generated always as identity primary key,
  username      text not null,
  full_name     text not null,
  password_hash text not null,
  role          text not null default 'staff' check (role in ('admin', 'manager', 'staff')),
  team          text check (team is null or team in ('Điện', 'Cơ Khí', 'PM')),
  status        text not null default 'pending' check (status in ('pending', 'active', 'rejected', 'locked')),
  manager_all   boolean not null default false,          -- quản lý được xem tất cả nhóm
  manager_teams text[] not null default '{}',            -- hoặc chỉ các nhóm này
  created_at    timestamptz not null default now()
);
create unique index if not exists users_username_key on private.users (lower(username));

create table if not exists private.sessions (
  token_hash text primary key,
  user_id    bigint not null references private.users (id) on delete cascade,
  expires_at timestamptz not null
);

create table if not exists private.login_failures (
  username text primary key,
  first_at timestamptz not null,
  count    int not null
);

create table if not exists private.reports (
  id          bigint generated always as identity primary key,
  report_date date not null,
  team        text not null check (team in ('Điện', 'Cơ Khí', 'PM')),
  status      text not null default 'draft' check (status in ('draft', 'approved')),
  approved_by bigint references private.users (id),
  approved_at timestamptz,
  unique (report_date, team)
);

create table if not exists private.entries (
  id          bigint generated always as identity primary key,
  report_id   bigint not null references private.reports (id) on delete cascade,
  user_id     bigint not null references private.users (id),
  machine     text not null,
  description text not null default '',
  start_at    text,                                     -- 'YYYY-MM-DDTHH:mm'
  end_at      text,
  completion  int not null default 100 check (completion between 0 and 100),  -- 100 = OK
  note        text not null default '',                 -- Tình trạng máy / Ghi chú
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists entries_report_idx on private.entries (report_id);

create table if not exists private.audit_log (
  id             bigint generated always as identity primary key,
  report_id      bigint not null,
  entry_id       bigint,
  user_id        bigint not null references private.users (id),
  action         text not null,                         -- create | update | delete | approve | unapprove
  after_approval boolean not null default false,
  old_value      jsonb,
  new_value      jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists audit_report_idx on private.audit_log (report_id);

-- ---------------------------------------------------------------------
--  HÀM NỘI BỘ (schema private – không gọi được từ trình duyệt)
-- ---------------------------------------------------------------------
create or replace function private.err(p_status int, p_msg text, p_detail text default null)
returns void language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'PT' || p_status, message = p_msg, detail = coalesce(p_detail, '');
end $$;

create or replace function private.vn(ts timestamptz)
returns text language sql stable set search_path = '' as $$
  select to_char(ts at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS')
$$;

create or replace function private.teams()
returns text[] language sql immutable set search_path = '' as $$
  select array['Điện', 'Cơ Khí', 'PM']
$$;

create or replace function private.hash_token(p_token text)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(p_token, 'sha256'), 'hex')
$$;

create or replace function private.viewable_teams(u private.users)
returns text[] language sql stable set search_path = '' as $$
  select case
    when u.role = 'admin' or (u.role = 'manager' and u.manager_all) then private.teams()
    when u.role = 'manager' then array(select t from unnest(private.teams()) t where t = any (u.manager_teams))
    else '{}'::text[]
  end
$$;

create or replace function private.can_manage(u private.users, p_team text)
returns boolean language sql stable set search_path = '' as $$
  select p_team = any (private.viewable_teams(u))
$$;

create or replace function private.public_user(u private.users)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', u.id, 'username', u.username, 'full_name', u.full_name, 'role', u.role, 'team', u.team,
    'manager_all', u.manager_all, 'manager_teams', to_jsonb(u.manager_teams),
    'viewable_teams', to_jsonb(private.viewable_teams(u)))
$$;

/** Lấy người dùng từ token phiên; lỗi 401 nếu không hợp lệ */
create or replace function private.auth_user(p_token text)
returns private.users language plpgsql set search_path = '' as $$
declare u private.users;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    perform private.err(401, 'Bạn cần đăng nhập.');
  end if;
  select usr.* into u
    from private.sessions s join private.users usr on usr.id = s.user_id
   where s.token_hash = private.hash_token(p_token) and s.expires_at > now();
  if not found or u.status <> 'active' then
    perform private.err(401, 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.');
  end if;
  return u;
end $$;

create or replace function private.require_admin(u private.users)
returns void language plpgsql set search_path = '' as $$
begin
  if u.role <> 'admin' then perform private.err(403, 'Bạn không có quyền thực hiện thao tác này.'); end if;
end $$;

create or replace function private.require_manager(u private.users)
returns void language plpgsql set search_path = '' as $$
begin
  if u.role not in ('admin', 'manager') then perform private.err(403, 'Bạn không có quyền thực hiện thao tác này.'); end if;
end $$;

create or replace function private.require_team(u private.users, p_team text)
returns void language plpgsql set search_path = '' as $$
begin
  if not private.can_manage(u, p_team) then perform private.err(403, 'Bạn không có quyền với báo cáo của nhóm này.'); end if;
end $$;

-- ----- Kiểm tra dữ liệu đầu vào -----
create or replace function private.check_team(p_team text)
returns text language plpgsql set search_path = '' as $$
begin
  if p_team is null or not (p_team = any (private.teams())) then
    perform private.err(400, 'Nhóm không hợp lệ (Điện / Cơ Khí / PM).');
  end if;
  return p_team;
end $$;

create or replace function private.check_date(p_date text)
returns date language plpgsql set search_path = '' as $$
declare d date;
begin
  if p_date is null or p_date !~ '^\d{4}-\d{2}-\d{2}$' then perform private.err(400, 'Ngày không hợp lệ (YYYY-MM-DD).'); end if;
  begin
    d := p_date::date;
  exception when others then
    d := null;
  end;
  if d is null then perform private.err(400, 'Ngày không hợp lệ (YYYY-MM-DD).'); end if;
  return d;
end $$;

create or replace function private.check_dt(p_value text, p_label text)
returns text language plpgsql set search_path = '' as $$
declare ok boolean := true;
begin
  if p_value is null or p_value = '' then return null; end if;
  if p_value !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$' then ok := false; end if;
  if ok then
    begin
      perform p_value::timestamp;
    exception when others then
      ok := false;
    end;
  end if;
  if not ok then perform private.err(400, p_label || ' không hợp lệ.'); end if;
  return p_value;
end $$;

create or replace function private.check_text(p_value text, p_max int)
returns text language plpgsql set search_path = '' as $$
declare v text := btrim(coalesce(p_value, ''));
begin
  if length(v) > p_max then perform private.err(400, 'Nội dung quá dài (tối đa ' || p_max || ' ký tự).'); end if;
  return v;
end $$;

create or replace function private.check_username(p_username text)
returns text language plpgsql set search_path = '' as $$
declare v text := btrim(coalesce(p_username, ''));
begin
  if v !~ '^[a-zA-Z0-9._-]{3,32}$' then
    perform private.err(400, 'Tên đăng nhập 3–32 ký tự, chỉ gồm chữ không dấu, số, dấu chấm, gạch dưới, gạch ngang.');
  end if;
  return v;
end $$;

create or replace function private.check_full_name(p_name text)
returns text language plpgsql set search_path = '' as $$
declare v text := private.check_text(p_name, 100);
begin
  if length(v) < 2 then perform private.err(400, 'Vui lòng nhập họ tên.'); end if;
  return v;
end $$;

create or replace function private.check_password(p_password text)
returns text language plpgsql set search_path = '' as $$
begin
  if p_password is null or length(p_password) < 8 or length(p_password) > 128 then
    perform private.err(400, 'Mật khẩu phải có từ 8 đến 128 ký tự.');
  end if;
  if p_password !~ '[A-Za-z]' or p_password !~ '[0-9]' then
    perform private.err(400, 'Mật khẩu phải có cả chữ và số.');
  end if;
  return p_password;
end $$;

create or replace function private.hash_password(p_password text)
returns text language sql volatile set search_path = '' as $$
  select extensions.crypt(p_password, extensions.gen_salt('bf', 12))
$$;

/** "OK" | "0%".."99%" | 0..100 → số nguyên 0..100 (100 = OK) */
create or replace function private.parse_completion(p_value jsonb)
returns int language plpgsql set search_path = '' as $$
declare s text; n numeric;
begin
  if p_value is null or p_value = 'null'::jsonb then return 100; end if;
  if jsonb_typeof(p_value) = 'number' then
    n := (p_value #>> '{}')::numeric;
    if n = trunc(n) and n between 0 and 100 then return n::int; end if;
  elsif jsonb_typeof(p_value) = 'string' then
    s := upper(btrim(p_value #>> '{}'));
    if s in ('', 'OK', '100', '100%') then return 100; end if;
    if s ~ '^\d{1,2}\s*%?$' then return regexp_replace(s, '\D', '', 'g')::int; end if;
  end if;
  perform private.err(400, 'Trạng thái hoàn thành phải là "OK" hoặc phần trăm từ 0% đến 99%.');
  return null;
end $$;

/** Chuẩn hóa dữ liệu 1 dòng công việc. p_partial = true khi cập nhật từng phần */
create or replace function private.entry_input(p jsonb, p_partial boolean)
returns jsonb language plpgsql set search_path = '' as $$
declare o jsonb := '{}'::jsonb; v text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then perform private.err(400, 'Dữ liệu không hợp lệ.'); end if;
  if not p_partial or p ? 'machine' then
    v := private.check_text(p ->> 'machine', 200);
    if v = '' then perform private.err(400, 'Tên máy là bắt buộc.'); end if;
    o := o || jsonb_build_object('machine', v);
  end if;
  if not p_partial or p ? 'description' then
    o := o || jsonb_build_object('description', private.check_text(p ->> 'description', 4000));
  end if;
  if not p_partial or p ? 'start_at' then
    o := o || jsonb_build_object('start_at', private.check_dt(p ->> 'start_at', 'Thời gian bắt đầu'));
  end if;
  if not p_partial or p ? 'end_at' then
    o := o || jsonb_build_object('end_at', private.check_dt(p ->> 'end_at', 'Thời gian kết thúc'));
  end if;
  if not p_partial or p ? 'completion' then
    o := o || jsonb_build_object('completion', private.parse_completion(p -> 'completion'));
  end if;
  if not p_partial or p ? 'note' then
    o := o || jsonb_build_object('note', private.check_text(p ->> 'note', 4000));
  end if;
  return o;
end $$;

create or replace function private.check_time_order(p jsonb)
returns void language plpgsql set search_path = '' as $$
begin
  if p ->> 'start_at' is not null and p ->> 'end_at' is not null and (p ->> 'end_at') < (p ->> 'start_at') then
    perform private.err(400, 'Thời gian kết thúc phải sau thời gian bắt đầu.');
  end if;
end $$;

create or replace function private.entry_json(e private.entries)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('machine', e.machine, 'description', e.description, 'start_at', e.start_at,
                            'end_at', e.end_at, 'completion', e.completion, 'note', e.note)
$$;

create or replace function private.log(p_report_id bigint, p_entry_id bigint, p_user_id bigint, p_action text,
                                       p_after boolean, p_old jsonb, p_new jsonb)
returns void language sql set search_path = '' as $$
  insert into private.audit_log (report_id, entry_id, user_id, action, after_approval, old_value, new_value)
  values (p_report_id, p_entry_id, p_user_id, p_action, p_after, p_old, p_new)
$$;

/** Danh sách dòng còn thiếu trường bắt buộc khi xuất Excel */
create or replace function private.missing(p_report_id bigint)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('row', rn, 'entry_id', id, 'user_name', user_name,
                                               'machine', machine, 'fields', to_jsonb(fields)) order by rn), '[]'::jsonb)
  from (
    select e.id, e.machine, u.full_name as user_name,
           row_number() over (order by coalesce(e.start_at, '9999'), e.id) as rn,
           array_remove(array[
             case when btrim(e.machine) = '' then 'Tên máy' end,
             case when btrim(e.description) = '' then 'Diễn giải công việc' end,
             case when e.start_at is null then 'Thời gian bắt đầu' end,
             case when e.end_at is null then 'Thời gian kết thúc' end,
             case when e.completion is null then 'Trạng thái' end], null) as fields
      from private.entries e join private.users u on u.id = e.user_id
     where e.report_id = p_report_id
  ) x
  where cardinality(fields) > 0
$$;

/** Báo cáo tổng hợp (ngày + nhóm) dưới dạng JSON, kèm quyền sửa từng dòng */
create or replace function private.report_payload(u private.users, p_date date, p_team text)
returns jsonb language plpgsql stable set search_path = '' as $$
declare r record; v_entries jsonb; v_manage boolean := private.can_manage(u, p_team);
begin
  select rp.id, rp.status, rp.approved_at, au.full_name as approved_by_name into r
    from private.reports rp left join private.users au on au.id = rp.approved_by
   where rp.report_date = p_date and rp.team = p_team;
  if not found then
    return jsonb_build_object('date', p_date, 'team', p_team, 'status', 'draft', 'approved_by_name', null,
                              'approved_at', null, 'entries', '[]'::jsonb, 'missing', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id, 'user_id', e.user_id, 'user_name', eu.full_name, 'machine', e.machine,
           'description', e.description, 'start_at', e.start_at, 'end_at', e.end_at,
           'completion', e.completion, 'note', e.note, 'updated_at', private.vn(e.updated_at),
           'can_edit', v_manage or (e.user_id = u.id and r.status = 'draft'))
         order by coalesce(e.start_at, '9999'), e.id), '[]'::jsonb)
    into v_entries
    from private.entries e join private.users eu on eu.id = e.user_id
   where e.report_id = r.id;
  return jsonb_build_object('date', p_date, 'team', p_team, 'status', r.status,
                            'approved_by_name', r.approved_by_name, 'approved_at', private.vn(r.approved_at),
                            'entries', v_entries, 'missing', private.missing(r.id));
end $$;

/**
 * Tạo hoặc đặt lại tài khoản Admin. CHỈ chạy trong Supabase SQL Editor:
 *   select private.create_admin('k.huy', 'Họ tên của bạn', 'MatKhauManh123');
 */
create or replace function private.create_admin(p_username text, p_full_name text, p_password text)
returns text language plpgsql set search_path = '' as $$
declare v_username text := private.check_username(p_username);
begin
  perform private.check_full_name(p_full_name);
  perform private.check_password(p_password);
  insert into private.users (username, full_name, password_hash, role, status, manager_all)
  values (v_username, btrim(p_full_name), private.hash_password(p_password), 'admin', 'active', true)
  on conflict ((lower(username))) do update
    set password_hash = excluded.password_hash, full_name = excluded.full_name,
        role = 'admin', status = 'active', manager_all = true;
  delete from private.sessions s using private.users u where s.user_id = u.id and lower(u.username) = lower(v_username);
  return 'Đã tạo/đặt lại tài khoản Admin "' || v_username || '".';
end $$;

-- ---------------------------------------------------------------------
--  HÀM API (schema public – trình duyệt gọi qua POST /rest/v1/rpc/<tên>)
-- ---------------------------------------------------------------------

-- ===== Tài khoản =====
create or replace function public.register(p_username text, p_full_name text, p_password text, p_team text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_username text := private.check_username(p_username);
        v_name text := private.check_full_name(p_full_name);
begin
  perform private.check_password(p_password);
  perform private.check_team(p_team);
  if exists (select 1 from private.users where lower(username) = lower(v_username)) then
    perform private.err(409, 'Tên đăng nhập đã tồn tại.');
  end if;
  if (select count(*) from private.users where status = 'pending') >= 200 then
    perform private.err(429, 'Đang có quá nhiều tài khoản chờ duyệt. Vui lòng liên hệ Admin.');
  end if;
  insert into private.users (username, full_name, password_hash, role, team, status)
  values (v_username, v_name, private.hash_password(p_password), 'staff', p_team, 'pending');
  return jsonb_build_object('ok', true, 'message', 'Đăng ký thành công. Vui lòng chờ Admin duyệt tài khoản.');
end $$;

-- Không ném lỗi khi sai mật khẩu (để bộ đếm đăng nhập sai không bị rollback)
create or replace function public.login(p_username text, p_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users; f private.login_failures; v_key text := lower(btrim(coalesce(p_username, ''))); v_token text;
begin
  if v_key = '' or coalesce(p_password, '') = '' then
    return jsonb_build_object('ok', false, 'error', 'Vui lòng nhập tên đăng nhập và mật khẩu.');
  end if;
  select * into f from private.login_failures where username = v_key;
  if found and f.first_at > now() - interval '15 minutes' and f.count >= 10 then
    return jsonb_build_object('ok', false, 'error', 'Bạn đã nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.');
  end if;

  select * into u from private.users where lower(username) = v_key;
  if not found then
    perform extensions.crypt(p_password, extensions.gen_salt('bf', 12)); -- cân bằng thời gian phản hồi
  end if;
  if u.id is null or u.password_hash <> extensions.crypt(p_password, u.password_hash) then
    insert into private.login_failures as lf (username, first_at, count) values (v_key, now(), 1)
    on conflict (username) do update set
      first_at = case when lf.first_at < now() - interval '15 minutes' then now() else lf.first_at end,
      count    = case when lf.first_at < now() - interval '15 minutes' then 1 else lf.count + 1 end;
    return jsonb_build_object('ok', false, 'error', 'Tên đăng nhập hoặc mật khẩu không đúng.');
  end if;
  if u.status = 'pending' then return jsonb_build_object('ok', false, 'error', 'Tài khoản đang chờ Admin duyệt.'); end if;
  if u.status = 'rejected' then return jsonb_build_object('ok', false, 'error', 'Tài khoản đã bị từ chối.'); end if;
  if u.status = 'locked' then return jsonb_build_object('ok', false, 'error', 'Tài khoản đã bị khóa. Vui lòng liên hệ Admin.'); end if;

  delete from private.login_failures where username = v_key;
  delete from private.sessions where expires_at < now();
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.sessions (token_hash, user_id, expires_at)
  values (private.hash_token(v_token), u.id, now() + interval '12 hours');
  return jsonb_build_object('ok', true, 'token', v_token, 'user', private.public_user(u));
end $$;

create or replace function public.logout(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_token ~ '^[0-9a-f]{64}$' then
    delete from private.sessions where token_hash = private.hash_token(p_token);
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.me(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return jsonb_build_object('user', private.public_user(private.auth_user(p_token)));
end $$;

create or replace function public.change_password(p_token text, p_old_password text, p_new_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token);
begin
  if p_old_password is null or u.password_hash <> extensions.crypt(p_old_password, u.password_hash) then
    perform private.err(400, 'Mật khẩu hiện tại không đúng.');
  end if;
  perform private.check_password(p_new_password);
  update private.users set password_hash = private.hash_password(p_new_password) where id = u.id;
  -- đăng xuất các phiên khác
  delete from private.sessions where user_id = u.id and token_hash <> private.hash_token(p_token);
  return jsonb_build_object('ok', true, 'message', 'Đã đổi mật khẩu.');
end $$;

create or replace function public.update_profile(p_token text, p_full_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token);
begin
  update private.users set full_name = private.check_full_name(p_full_name) where id = u.id;
  return jsonb_build_object('ok', true, 'message', 'Đã cập nhật họ tên.');
end $$;

-- ===== Quản trị (Admin) =====
create or replace function private.admin_target(p_user_id bigint)
returns private.users language plpgsql set search_path = '' as $$
declare t private.users;
begin
  select * into t from private.users where id = p_user_id for update;
  if not found then perform private.err(404, 'Không tìm thấy tài khoản.'); end if;
  if t.role = 'admin' then perform private.err(403, 'Không thể thay đổi tài khoản Admin từ trang này.'); end if;
  return t;
end $$;

create or replace function public.admin_list_users(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token);
begin
  perform private.require_admin(u);
  return jsonb_build_object('users', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', x.id, 'username', x.username, 'full_name', x.full_name, 'role', x.role, 'team', x.team,
             'status', x.status, 'manager_all', x.manager_all, 'manager_teams', to_jsonb(x.manager_teams),
             'created_at', private.vn(x.created_at))
           order by (x.status = 'pending') desc, x.created_at desc)
      from private.users x), '[]'::jsonb));
end $$;

create or replace function public.admin_set_status(p_token text, p_user_id bigint, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); t private.users; v_new text; v_msg text;
begin
  perform private.require_admin(u);
  t := private.admin_target(p_user_id);
  if p_action = 'approve' then
    if t.status not in ('pending', 'rejected') then perform private.err(400, 'Tài khoản không ở trạng thái chờ duyệt.'); end if;
    v_new := 'active'; v_msg := 'Đã duyệt tài khoản ';
  elsif p_action = 'reject' then
    if t.status <> 'pending' then perform private.err(400, 'Chỉ từ chối được tài khoản đang chờ duyệt.'); end if;
    v_new := 'rejected'; v_msg := 'Đã từ chối tài khoản ';
  elsif p_action = 'lock' then
    if t.status <> 'active' then perform private.err(400, 'Chỉ khóa được tài khoản đang hoạt động.'); end if;
    v_new := 'locked'; v_msg := 'Đã khóa tài khoản ';
    delete from private.sessions where user_id = t.id;
  elsif p_action = 'unlock' then
    if t.status <> 'locked' then perform private.err(400, 'Tài khoản không bị khóa.'); end if;
    v_new := 'active'; v_msg := 'Đã mở khóa tài khoản ';
  else
    perform private.err(400, 'Thao tác không hợp lệ.');
  end if;
  update private.users set status = v_new where id = t.id;
  return jsonb_build_object('ok', true, 'message', v_msg || t.username || '.');
end $$;

create or replace function public.admin_update_user(p_token text, p_user_id bigint, p_role text, p_team text,
                                                    p_manager_all boolean, p_manager_teams text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); t private.users;
        v_all boolean := coalesce(p_manager_all, false); v_teams text[] := coalesce(p_manager_teams, '{}');
begin
  perform private.require_admin(u);
  t := private.admin_target(p_user_id);
  if p_role not in ('staff', 'manager') then perform private.err(400, 'Vai trò chỉ được là Nhân viên hoặc Quản lý.'); end if;
  perform private.check_team(p_team);
  if exists (select 1 from unnest(v_teams) x where not (x = any (private.teams()))) then
    perform private.err(400, 'Phạm vi quản lý không hợp lệ.');
  end if;
  if p_role = 'staff' then
    v_all := false; v_teams := '{}';
  elsif not v_all and cardinality(v_teams) = 0 then
    v_teams := array[p_team];
  end if;
  update private.users
     set role = p_role, team = p_team, manager_all = v_all,
         manager_teams = array(select distinct x from unnest(v_teams) x)
   where id = t.id;
  return jsonb_build_object('ok', true, 'message', 'Đã cập nhật tài khoản ' || t.username || '.');
end $$;

create or replace function public.admin_reset_password(p_token text, p_user_id bigint, p_new_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); t private.users;
begin
  perform private.require_admin(u);
  t := private.admin_target(p_user_id);
  perform private.check_password(p_new_password);
  update private.users set password_hash = private.hash_password(p_new_password) where id = t.id;
  delete from private.sessions where user_id = t.id;
  return jsonb_build_object('ok', true, 'message', 'Đã đặt lại mật khẩu cho ' || t.username || '.');
end $$;

-- ===== Dòng công việc =====
create or replace function public.my_entries(p_token text, p_date text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_date);
begin
  return jsonb_build_object(
    'date', d,
    'report_status', (select jsonb_object_agg(t, coalesce((select r.status from private.reports r
                                                            where r.report_date = d and r.team = t), 'draft'))
                        from unnest(private.teams()) t),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id, 'team', r.team, 'user_name', u.full_name, 'machine', e.machine,
               'description', e.description, 'start_at', e.start_at, 'end_at', e.end_at,
               'completion', e.completion, 'note', e.note,
               'can_edit', private.can_manage(u, r.team) or r.status = 'draft')
             order by coalesce(e.start_at, '9999'), e.id)
        from private.entries e join private.reports r on r.id = e.report_id
       where e.user_id = u.id and r.report_date = d), '[]'::jsonb));
end $$;

create or replace function public.add_entry(p_token text, p_date text, p_team text, p_entry jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_date);
        v jsonb; r private.reports; v_id bigint;
begin
  perform private.check_team(p_team);
  v := private.entry_input(p_entry, false);
  perform private.check_time_order(v);
  insert into private.reports (report_date, team) values (d, p_team) on conflict do nothing;
  select * into r from private.reports where report_date = d and team = p_team for update;
  if r.status = 'approved' and not private.can_manage(u, p_team) then
    perform private.err(403, 'Báo cáo ngày này của nhóm đã được phê duyệt, không thể thêm dòng mới.');
  end if;
  insert into private.entries (report_id, user_id, machine, description, start_at, end_at, completion, note)
  values (r.id, u.id, v ->> 'machine', v ->> 'description', v ->> 'start_at', v ->> 'end_at',
          (v ->> 'completion')::int, v ->> 'note')
  returning id into v_id;
  perform private.log(r.id, v_id, u.id, 'create', r.status = 'approved', null, v);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

/** Khóa dòng + báo cáo, kiểm tra quyền sửa/xóa. Trả về báo cáo chứa dòng đó */
create or replace function private.editable_entry(u private.users, p_id bigint)
returns private.reports language plpgsql set search_path = '' as $$
declare e private.entries; r private.reports;
begin
  select * into e from private.entries where id = p_id for update;
  if not found then perform private.err(404, 'Không tìm thấy dòng công việc.'); end if;
  select * into r from private.reports where id = e.report_id for update;
  if not private.can_manage(u, r.team) then
    if e.user_id <> u.id then perform private.err(403, 'Bạn chỉ được sửa dòng do chính mình nhập.'); end if;
    if r.status = 'approved' then
      perform private.err(403, 'Báo cáo đã được phê duyệt, bạn không thể sửa hoặc xóa nữa.');
    end if;
  end if;
  return r;
end $$;

create or replace function public.update_entry(p_token text, p_id bigint, p_entry jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); r private.reports; e private.entries;
        v_old jsonb; v_new jsonb; v_old_diff jsonb; v_new_diff jsonb;
begin
  r := private.editable_entry(u, p_id);
  select * into e from private.entries where id = p_id;
  v_old := private.entry_json(e);
  v_new := v_old || private.entry_input(p_entry, true);
  perform private.check_time_order(v_new);
  select jsonb_object_agg(k, v_old -> k), jsonb_object_agg(k, v_new -> k) into v_old_diff, v_new_diff
    from jsonb_object_keys(v_new) k where v_new -> k is distinct from v_old -> k;
  if v_new_diff is null then return jsonb_build_object('ok', true); end if;
  update private.entries
     set machine = v_new ->> 'machine', description = v_new ->> 'description', start_at = v_new ->> 'start_at',
         end_at = v_new ->> 'end_at', completion = (v_new ->> 'completion')::int, note = v_new ->> 'note',
         updated_at = now()
   where id = p_id;
  perform private.log(r.id, p_id, u.id, 'update', r.status = 'approved', v_old_diff, v_new_diff);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.delete_entry(p_token text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); r private.reports; e private.entries;
begin
  r := private.editable_entry(u, p_id);
  select * into e from private.entries where id = p_id;
  delete from private.entries where id = p_id;
  perform private.log(r.id, p_id, u.id, 'delete', r.status = 'approved', private.entry_json(e), null);
  return jsonb_build_object('ok', true);
end $$;

-- ===== Báo cáo tổng hợp (Quản lý / Admin) =====
create or replace function public.reports_of_day(p_token text, p_date text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_date);
begin
  perform private.require_manager(u);
  return jsonb_build_object('date', d, 'reports', coalesce((
    select jsonb_agg(private.report_payload(u, d, t) order by array_position(private.teams(), t))
      from unnest(private.viewable_teams(u)) t), '[]'::jsonb));
end $$;

create or replace function public.reports_month(p_token text, p_month text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); v_start date;
begin
  perform private.require_manager(u);
  if p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then perform private.err(400, 'Tháng không hợp lệ (YYYY-MM).'); end if;
  v_start := (p_month || '-01')::date;
  return jsonb_build_object('month', p_month, 'days', coalesce((
    select jsonb_object_agg(day, teams) from (
      select to_char(r.report_date, 'YYYY-MM-DD') as day,
             jsonb_object_agg(r.team, jsonb_build_object('status', r.status, 'count', c.cnt)) as teams
        from private.reports r
        join lateral (select count(*) as cnt from private.entries e where e.report_id = r.id) c on c.cnt > 0
       where r.report_date >= v_start and r.report_date < (v_start + interval '1 month')
         and r.team = any (private.viewable_teams(u))
       group by r.report_date) s), '{}'::jsonb));
end $$;

create or replace function public.report_history(p_token text, p_date text, p_team text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_date);
begin
  perform private.require_manager(u);
  perform private.check_team(p_team);
  perform private.require_team(u, p_team);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'entry_id', a.entry_id, 'action', a.action, 'after_approval', a.after_approval,
             'old_value', a.old_value, 'new_value', a.new_value, 'user_name', au.full_name,
             'created_at', private.vn(a.created_at))
           order by a.id desc)
      from private.audit_log a
      join private.reports r on r.id = a.report_id
      join private.users au on au.id = a.user_id
     where r.report_date = d and r.team = p_team), '[]'::jsonb));
end $$;

create or replace function public.approve_report(p_token text, p_date text, p_team text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_date); r private.reports;
begin
  perform private.require_manager(u);
  perform private.check_team(p_team);
  perform private.require_team(u, p_team);
  select * into r from private.reports where report_date = d and team = p_team for update;
  if not found or not exists (select 1 from private.entries where report_id = r.id) then
    perform private.err(400, 'Báo cáo chưa có dòng công việc nào.');
  end if;
  if r.status = 'approved' then perform private.err(400, 'Báo cáo đã được phê duyệt trước đó.'); end if;
  update private.reports set status = 'approved', approved_by = u.id, approved_at = now() where id = r.id;
  perform private.log(r.id, null, u.id, 'approve', false, null, null);
  return jsonb_build_object('ok', true, 'message', 'Đã phê duyệt báo cáo nhóm ' || p_team || '.');
end $$;

create or replace function public.unapprove_report(p_token text, p_date text, p_team text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_date); r private.reports;
begin
  perform private.require_admin(u);
  perform private.check_team(p_team);
  select * into r from private.reports where report_date = d and team = p_team for update;
  if not found or r.status <> 'approved' then perform private.err(400, 'Báo cáo chưa được phê duyệt.'); end if;
  update private.reports set status = 'draft', approved_by = null, approved_at = null where id = r.id;
  perform private.log(r.id, null, u.id, 'unapprove', true, null, null);
  return jsonb_build_object('ok', true, 'message', 'Đã hủy phê duyệt, nhân viên nhóm ' || p_team || ' có thể sửa lại.');
end $$;

/** Dữ liệu để xuất Excel – chỉ trả về khi báo cáo đầy đủ */
create or replace function public.report_export(p_token text, p_date text, p_team text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_date); v jsonb;
begin
  perform private.require_manager(u);
  perform private.check_team(p_team);
  perform private.require_team(u, p_team);
  v := private.report_payload(u, d, p_team);
  if jsonb_array_length(v -> 'entries') = 0 then
    perform private.err(400, 'Báo cáo chưa có dòng công việc nào để xuất.');
  end if;
  if jsonb_array_length(v -> 'missing') > 0 then
    perform private.err(400, 'Báo cáo chưa đầy đủ, chưa thể xuất Excel.', (v -> 'missing')::text);
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
--  PHÂN QUYỀN GỌI HÀM
-- ---------------------------------------------------------------------
do $$
declare f record;
        api text[] := array['register', 'login', 'logout', 'me', 'change_password', 'update_profile',
                            'admin_list_users', 'admin_set_status', 'admin_update_user', 'admin_reset_password',
                            'my_entries', 'add_entry', 'update_entry', 'delete_entry',
                            'reports_of_day', 'reports_month', 'report_history', 'approve_report',
                            'unapprove_report', 'report_export'];
        roles text := '';
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then roles := roles || ', anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then roles := roles || ', authenticated'; end if;

  -- Hàm nội bộ: không ai ngoài chủ sở hữu được gọi
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' loop
    execute format('revoke all on function %s from public%s', f.sig, roles);
  end loop;

  -- Hàm API: cho phép trình duyệt gọi (vai trò anon / authenticated của Supabase)
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any (api) loop
    execute format('revoke all on function %s from public', f.sig);
    if roles <> '' then
      execute format('grant execute on function %s to %s', f.sig, substr(roles, 3));
    end if;
  end loop;
end $$;

revoke all on all tables in schema private from public;
revoke all on all sequences in schema private from public;

-- Báo PostgREST (Supabase) tải lại danh sách hàm
notify pgrst, 'reload schema';
