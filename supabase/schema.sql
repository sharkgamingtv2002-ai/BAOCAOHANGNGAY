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
  team          text check (team is null or team in ('Điện', 'Cơ Khí', 'PM', 'Trực ca')),
  status        text not null default 'pending' check (status in ('pending', 'active', 'rejected', 'locked')),
  manager_all   boolean not null default false,          -- quản lý được xem tất cả nhóm
  manager_teams text[] not null default '{}',            -- hoặc chỉ các nhóm này
  created_at    timestamptz not null default now()
);
create unique index if not exists users_username_key on private.users (lower(username));
-- Ảnh chữ ký (PNG dạng data URL) của Quản lý / Admin, in vào ô "Người duyệt" khi xuất Excel
alter table private.users add column if not exists signature text;
alter table private.users add column if not exists signature_name text; -- tên in dưới chữ ký (trống = họ tên)

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
  team        text not null check (team in ('Điện', 'Cơ Khí', 'PM', 'Trực ca')),
  status      text not null default 'draft' check (status in ('draft', 'approved')),
  approved_by bigint references private.users (id),
  approved_at timestamptz
);
-- Ca làm việc (bản cập nhật 4): mỗi ngày + nhóm + ca là 1 báo cáo riêng. Dữ liệu cũ = ca Hành chính
alter table private.reports add column if not exists shift text not null default 'Hành chính';
alter table private.reports drop constraint if exists reports_report_date_team_key;
-- thêm nhóm "Trực ca": thay điều kiện nhóm của bảng đã có
alter table private.users drop constraint if exists users_team_check;
alter table private.users add constraint users_team_check check (team is null or team in ('Điện', 'Cơ Khí', 'PM', 'Trực ca'));
alter table private.reports drop constraint if exists reports_team_check;
alter table private.reports add constraint reports_team_check check (team in ('Điện', 'Cơ Khí', 'PM', 'Trực ca'));
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'reports_shift_check') then
    alter table private.reports add constraint reports_shift_check check (shift in ('Hành chính', 'Ca 1', 'Ca 2', 'Ca 3'));
  end if;
end $$;
create unique index if not exists reports_day_team_shift_key on private.reports (report_date, team, shift);

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
-- Người làm cùng (bản cập nhật 2): danh sách id tài khoản, không gồm người nhập
alter table private.entries add column if not exists coworker_ids bigint[] not null default '{}';
create index if not exists entries_coworkers_idx on private.entries using gin (coworker_ids);

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
  select array['Điện', 'Cơ Khí', 'PM', 'Trực ca']
$$;

create or replace function private.shifts()
returns text[] language sql immutable set search_path = '' as $$
  select array['Hành chính', 'Ca 1', 'Ca 2', 'Ca 3']
$$;

/** Ca làm việc: để trống → ca Hành chính (mặc định) */
create or replace function private.check_shift(p_shift text)
returns text language plpgsql set search_path = '' as $$
declare v text := coalesce(nullif(btrim(p_shift), ''), 'Hành chính');
begin
  if not (v = any (private.shifts())) then
    perform private.err(400, 'Ca làm việc không hợp lệ (Hành chính, Ca 1, Ca 2, Ca 3).');
  end if;
  return v;
end $$;

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
    || case when u.role in ('manager', 'admin')
            then jsonb_build_object('signature', u.signature, 'signature_name', u.signature_name) else '{}'::jsonb end
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

/** Danh sách id người làm cùng: mảng số, không trùng, tối đa 10, phải là tài khoản đang hoạt động */
create or replace function private.check_coworkers(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare ids bigint[]; ok boolean := true;
begin
  if p is null or p = 'null'::jsonb then return '[]'::jsonb; end if;
  if jsonb_typeof(p) <> 'array' then ok := false; end if;
  if ok then
    begin
      select coalesce(array_agg(distinct (x #>> '{}')::bigint), '{}') into ids from jsonb_array_elements(p) x;
    exception when others then
      ok := false;
    end;
  end if;
  if not ok then perform private.err(400, 'Danh sách người làm cùng không hợp lệ.'); end if;
  if cardinality(ids) > 10 then perform private.err(400, 'Chỉ chọn tối đa 10 người làm cùng.'); end if;
  if exists (select 1 from unnest(ids) i
              where not exists (select 1 from private.users u where u.id = i and u.status = 'active')) then
    perform private.err(400, 'Người làm cùng không tồn tại hoặc đã bị khóa.');
  end if;
  return to_jsonb(ids);
end $$;

/** Bỏ người nhập ra khỏi danh sách người làm cùng (jsonb mảng số) */
create or replace function private.without_owner(p jsonb, p_owner bigint)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(x order by (x #>> '{}')::bigint), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p, '[]'::jsonb)) x where (x #>> '{}')::bigint <> p_owner
$$;

create or replace function private.jsonb_ids(p jsonb)
returns bigint[] language sql immutable set search_path = '' as $$
  select coalesce(array(select (x #>> '{}')::bigint from jsonb_array_elements(coalesce(p, '[]'::jsonb)) x), '{}')
$$;

/** Họ tên theo danh sách id (giữ thứ tự) */
create or replace function private.user_names(p_ids bigint[])
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(u.full_name order by array_position(p_ids, u.id)), '[]'::jsonb)
    from private.users u where u.id = any (p_ids)
$$;

/** Chuẩn hóa dữ liệu 1 dòng công việc. p_partial = true khi cập nhật từng phần */
create or replace function private.entry_input(p jsonb, p_partial boolean)
returns jsonb language plpgsql set search_path = '' as $$
declare o jsonb := '{}'::jsonb; v text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then perform private.err(400, 'Dữ liệu không hợp lệ.'); end if;
  if not p_partial or p ? 'machine' then
    o := o || jsonb_build_object('machine', private.check_text(p ->> 'machine', 200));   -- không bắt buộc
  end if;
  if not p_partial or p ? 'description' then
    v := private.check_text(p ->> 'description', 4000);
    if v = '' then perform private.err(400, 'Vui lòng nhập Diễn giải công việc (tên công việc).'); end if;
    o := o || jsonb_build_object('description', v);
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
  if not p_partial or p ? 'coworker_ids' then
    o := o || jsonb_build_object('coworker_ids', private.check_coworkers(p -> 'coworker_ids'));
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
                            'end_at', e.end_at, 'completion', e.completion, 'note', e.note,
                            'coworker_ids', to_jsonb(e.coworker_ids))
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
           -- cùng thứ tự với báo cáo: gom theo người gửi (ai gửi trước đứng trước), trong cụm theo giờ bắt đầu
           row_number() over (order by e.grp, coalesce(e.start_at, '9999'), e.id) as rn,
           array_remove(array[
             case when btrim(e.description) = '' then 'Diễn giải công việc' end,
             case when e.start_at is null then 'Thời gian bắt đầu' end,
             case when e.end_at is null then 'Thời gian kết thúc' end,
             case when e.completion is null then 'Trạng thái' end], null) as fields
      from (select y.*, min(y.id) over (partition by y.user_id) as grp
              from private.entries y where y.report_id = p_report_id) e
      join private.users u on u.id = e.user_id
  ) x
  where cardinality(fields) > 0
$$;

/** Báo cáo tổng hợp (ngày + nhóm + ca) dưới dạng JSON, kèm quyền sửa từng dòng */
drop function if exists private.report_payload(private.users, date, text);
create or replace function private.report_payload(u private.users, p_date date, p_team text, p_shift text)
returns jsonb language plpgsql stable set search_path = '' as $$
declare r record; v_entries jsonb; v_manage boolean := private.can_manage(u, p_team);
begin
  select rp.id, rp.status, rp.approved_at, rp.approved_by, au.full_name as approved_by_name into r
    from private.reports rp left join private.users au on au.id = rp.approved_by
   where rp.report_date = p_date and rp.team = p_team and rp.shift = p_shift;
  if not found then
    return jsonb_build_object('date', p_date, 'team', p_team, 'shift', p_shift, 'status', 'draft', 'approved_by_name', null,
                              'approved_at', null, 'entries', '[]'::jsonb, 'missing', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id, 'user_id', e.user_id, 'user_name', eu.full_name, 'machine', e.machine,
           'description', e.description, 'start_at', e.start_at, 'end_at', e.end_at,
           'completion', e.completion, 'note', e.note, 'updated_at', private.vn(e.updated_at),
           'coworker_ids', to_jsonb(e.coworker_ids), 'coworker_names', private.user_names(e.coworker_ids),
           'can_edit', v_manage or (e.user_id = u.id and r.status = 'draft'))
         -- gom dòng theo người gửi thành từng cụm (ai gửi trước đứng trước), trong cụm theo giờ bắt đầu
         order by e.grp, coalesce(e.start_at, '9999'), e.id), '[]'::jsonb)
    into v_entries
    from (select x.*, min(x.id) over (partition by x.user_id) as grp
            from private.entries x where x.report_id = r.id) e
    join private.users eu on eu.id = e.user_id;
  return jsonb_build_object('date', p_date, 'team', p_team, 'shift', p_shift, 'status', r.status,
                            'approved_by', r.approved_by, 'approved_by_name', r.approved_by_name, 'approved_at', private.vn(r.approved_at),
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
             'created_at', private.vn(x.created_at), 'signature', x.signature, 'signature_name', x.signature_name)
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

/** Lưu / xóa chữ ký duyệt (p_signature null = xóa) + tên in dưới chữ ký; chỉ cho Quản lý / Admin */
create or replace function private.save_signature(t private.users, p_signature text, p_name text)
returns jsonb language plpgsql set search_path = '' as $$
declare v_name text := nullif(private.check_text(p_name, 100), '');
begin
  if t.role not in ('manager', 'admin') then perform private.err(403, 'Chỉ tài khoản Quản lý mới có chữ ký duyệt.'); end if;
  if p_signature is not null and (length(p_signature) > 200000
      or p_signature !~ '^data:image/png;base64,[A-Za-z0-9+/]+=*$') then
    perform private.err(400, 'Ảnh chữ ký không hợp lệ hoặc quá lớn.');
  end if;
  update private.users set signature = p_signature, signature_name = case when p_signature is null then null else v_name end
   where id = t.id;
  return jsonb_build_object('ok', true, 'message',
    case when p_signature is null then 'Đã xóa chữ ký của ' else 'Đã lưu chữ ký của ' end || t.full_name || '.');
end $$;

/** Quản lý tự chèn chữ ký của mình */
create or replace function public.set_my_signature(p_token text, p_signature text, p_name text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return private.save_signature(private.auth_user(p_token), p_signature, p_name);
end $$;

/** Admin chèn / sửa giúp chữ ký của tài khoản Quản lý hoặc Admin */
drop function if exists public.admin_set_signature(text, bigint, text);
create or replace function public.admin_set_signature(p_token text, p_user_id bigint, p_signature text, p_name text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); t private.users;
begin
  perform private.require_admin(u);
  select * into t from private.users where id = p_user_id for update;
  if not found then perform private.err(404, 'Không tìm thấy tài khoản.'); end if;
  return private.save_signature(t, p_signature, p_name);
end $$;

-- ===== Dòng công việc =====
create or replace function public.my_entries(p_token text, p_date text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_date);
begin
  return jsonb_build_object(
    'date', d,
    -- trạng thái từng báo cáo trong ngày: { "Điện": { "Hành chính": "approved", ... }, ... }
    'report_statuses', coalesce((select jsonb_object_agg(x.team, x.st) from (
        select r.team, jsonb_object_agg(r.shift, r.status) as st
          from private.reports r where r.report_date = d group by r.team) x), '{}'::jsonb),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id, 'team', r.team, 'shift', r.shift, 'report_status', r.status,
               'user_id', e.user_id, 'user_name', ow.full_name, 'machine', e.machine,
               'description', e.description, 'start_at', e.start_at, 'end_at', e.end_at,
               'completion', e.completion, 'note', e.note, 'is_owner', e.user_id = u.id,
               'coworker_ids', to_jsonb(e.coworker_ids), 'coworker_names', private.user_names(e.coworker_ids),
               'can_edit', private.can_manage(u, r.team) or (e.user_id = u.id and r.status = 'draft'))
             order by coalesce(e.start_at, '9999'), e.id)
        from private.entries e
        join private.reports r on r.id = e.report_id
        join private.users ow on ow.id = e.user_id
       where (e.user_id = u.id or u.id = any (e.coworker_ids)) and r.report_date = d), '[]'::jsonb));
end $$;

drop function if exists public.add_entry(text, text, text, jsonb);
create or replace function public.add_entry(p_token text, p_date text, p_team text, p_entry jsonb, p_shift text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_date);
        v_shift text := private.check_shift(p_shift); v jsonb; r private.reports; v_id bigint;
begin
  perform private.check_team(p_team);
  v := private.entry_input(p_entry, false);
  perform private.check_time_order(v);
  r := private.report_for_update(d, p_team, v_shift);
  if r.status = 'approved' and not private.can_manage(u, p_team) then
    perform private.err(403, 'Báo cáo ngày này của nhóm (' || v_shift || ') đã được phê duyệt, không thể thêm dòng mới.');
  end if;
  v := jsonb_set(v, '{coworker_ids}', private.without_owner(v -> 'coworker_ids', u.id));
  insert into private.entries (report_id, user_id, machine, description, start_at, end_at, completion, note, coworker_ids)
  values (r.id, u.id, v ->> 'machine', v ->> 'description', v ->> 'start_at', v ->> 'end_at',
          (v ->> 'completion')::int, v ->> 'note', private.jsonb_ids(v -> 'coworker_ids'))
  returning id into v_id;
  perform private.log(r.id, v_id, u.id, 'create', r.status = 'approved', null, v);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

/** Lấy (tạo nếu chưa có) báo cáo ngày + nhóm + ca và khóa dòng để ghi */
create or replace function private.report_for_update(d date, p_team text, p_shift text)
returns private.reports language plpgsql set search_path = '' as $$
declare r private.reports;
begin
  insert into private.reports (report_date, team, shift) values (d, p_team, p_shift) on conflict do nothing;
  select * into r from private.reports where report_date = d and team = p_team and shift = p_shift for update;
  return r;
end $$;

/** Gửi nhiều dòng công việc một lần (lưu tất cả hoặc không lưu dòng nào) */
drop function if exists public.add_entries(text, text, text, jsonb);
create or replace function public.add_entries(p_token text, p_date text, p_team text, p_entries jsonb, p_shift text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_date);
        v_shift text := private.check_shift(p_shift); n int; i int; v jsonb; vs jsonb := '[]'::jsonb; r private.reports; v_id bigint; ids jsonb := '[]'::jsonb;
begin
  perform private.check_team(p_team);
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then perform private.err(400, 'Dữ liệu không hợp lệ.'); end if;
  n := jsonb_array_length(p_entries);
  if n = 0 then perform private.err(400, 'Chưa có công việc nào để gửi.'); end if;
  if n > 30 then perform private.err(400, 'Mỗi lần gửi tối đa 30 công việc.'); end if;
  -- kiểm tra toàn bộ trước, báo rõ công việc thứ mấy bị lỗi
  for i in 0 .. n - 1 loop
    begin
      v := private.entry_input(p_entries -> i, false);
      perform private.check_time_order(v);
      v := jsonb_set(v, '{coworker_ids}', private.without_owner(v -> 'coworker_ids', u.id));
    exception when others then
      raise exception using errcode = sqlstate, message = 'Công việc ' || (i + 1) || ': ' || sqlerrm;
    end;
    vs := vs || jsonb_build_array(v);
  end loop;
  r := private.report_for_update(d, p_team, v_shift);
  if r.status = 'approved' and not private.can_manage(u, p_team) then
    perform private.err(403, 'Báo cáo ngày này của nhóm (' || v_shift || ') đã được phê duyệt, không thể thêm dòng mới.');
  end if;
  for v in select value from jsonb_array_elements(vs) loop
    insert into private.entries (report_id, user_id, machine, description, start_at, end_at, completion, note, coworker_ids)
    values (r.id, u.id, v ->> 'machine', v ->> 'description', v ->> 'start_at', v ->> 'end_at',
            (v ->> 'completion')::int, v ->> 'note', private.jsonb_ids(v -> 'coworker_ids'))
    returning id into v_id;
    perform private.log(r.id, v_id, u.id, 'create', r.status = 'approved', null, v);
    ids := ids || to_jsonb(v_id);
  end loop;
  return jsonb_build_object('ok', true, 'ids', ids, 'count', n);
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
declare u private.users := private.auth_user(p_token); r private.reports; e private.entries; t private.reports;
        v_old jsonb; v_new jsonb; v_old_diff jsonb; v_new_diff jsonb; v_shift text;
begin
  r := private.editable_entry(u, p_id);
  select * into e from private.entries where id = p_id;
  v_old := private.entry_json(e);
  v_new := v_old || private.entry_input(p_entry, true);
  v_new := jsonb_set(v_new, '{coworker_ids}', private.without_owner(v_new -> 'coworker_ids', e.user_id));
  perform private.check_time_order(v_new);
  select jsonb_object_agg(k, v_old -> k), jsonb_object_agg(k, v_new -> k) into v_old_diff, v_new_diff
    from jsonb_object_keys(v_new) k where v_new -> k is distinct from v_old -> k;

  -- Đổi ca: chuyển dòng sang báo cáo của ca mới (cùng ngày, cùng nhóm)
  t := r;
  if p_entry ? 'shift' then
    v_shift := private.check_shift(p_entry ->> 'shift');
    if v_shift <> r.shift then
      t := private.report_for_update(r.report_date, r.team, v_shift);
      if t.status = 'approved' and not private.can_manage(u, t.team) then
        perform private.err(403, 'Báo cáo ' || v_shift || ' của nhóm đã được phê duyệt, không thể chuyển dòng sang ca này.');
      end if;
      v_old_diff := coalesce(v_old_diff, '{}'::jsonb) || jsonb_build_object('shift', r.shift);
      v_new_diff := coalesce(v_new_diff, '{}'::jsonb) || jsonb_build_object('shift', v_shift);
    end if;
  end if;

  if v_new_diff is null then return jsonb_build_object('ok', true); end if;
  update private.entries
     set report_id = t.id,
         machine = v_new ->> 'machine', description = v_new ->> 'description', start_at = v_new ->> 'start_at',
         end_at = v_new ->> 'end_at', completion = (v_new ->> 'completion')::int, note = v_new ->> 'note',
         coworker_ids = private.jsonb_ids(v_new -> 'coworker_ids'), updated_at = now()
   where id = p_id;
  perform private.log(t.id, p_id, u.id, 'update', t.status = 'approved' or r.status = 'approved', v_old_diff, v_new_diff);
  if t.id <> r.id then
    -- ghi cả vào lịch sử báo cáo ca cũ để biết dòng đã chuyển đi đâu
    perform private.log(r.id, p_id, u.id, 'update', r.status = 'approved', v_old_diff, v_new_diff);
  end if;
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

/** Danh sách tài khoản đang hoạt động để chọn "người làm cùng" */
create or replace function public.list_coworkers(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token);
begin
  return jsonb_build_object('users', coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'full_name', x.full_name, 'team', x.team)
           order by array_position(private.teams(), x.team) nulls last, x.full_name)
      from private.users x where x.status = 'active' and x.role <> 'manager'), '[]'::jsonb)); -- Quản lý không làm cùng; Admin vẫn hiện
end $$;

-- ===== Dung lượng, sao lưu & xóa dữ liệu cũ (Admin) =====
create table if not exists private.purge_tickets (
  ticket_hash text primary key,                         -- phiếu "đã tải sao lưu", hiệu lực 30 phút
  user_id     bigint not null references private.users (id) on delete cascade,
  before_date date not null,
  created_at  timestamptz not null default now()
);

create table if not exists private.purge_log (
  id          bigint generated always as identity primary key,
  user_id     bigint not null references private.users (id),
  before_date date not null,
  reports     int not null,
  entries     int not null,
  audit_rows  int not null,
  created_at  timestamptz not null default now()
);

create or replace function private.vn_today()
returns date language sql stable set search_path = '' as $$
  select (now() at time zone 'Asia/Ho_Chi_Minh')::date
$$;

/** Chỉ cho xóa dữ liệu cũ hơn 15 ngày */
create or replace function private.max_purge_before()
returns date language sql stable set search_path = '' as $$
  select private.vn_today() - 15
$$;

create or replace function private.check_purge_date(d date)
returns void language plpgsql set search_path = '' as $$
begin
  if d > private.max_purge_before() then
    perform private.err(400, 'Chỉ được xóa dữ liệu cũ hơn 15 ngày (chọn ngày không sau '
                             || to_char(private.max_purge_before(), 'DD/MM/YYYY') || ').');
  end if;
end $$;

/** Dữ liệu sao lưu. p_before = null → toàn bộ; có ngày → chỉ các báo cáo trước ngày đó */
create or replace function private.backup_data(p_before date)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'generated_at', private.vn(now()),
    'before', p_before,
    'users', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'username', x.username, 'full_name', x.full_name,
               'role', x.role, 'team', x.team, 'status', x.status, 'manager_all', x.manager_all,
               'manager_teams', to_jsonb(x.manager_teams), 'created_at', private.vn(x.created_at)) order by x.id)
        from private.users x), '[]'::jsonb),
    'reports', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'date', r.report_date, 'team', r.team, 'shift', r.shift, 'status', r.status,
               'approved_by', ap.full_name, 'approved_at', private.vn(r.approved_at),
               'entries', (select count(*) from private.entries e where e.report_id = r.id))
             order by r.report_date, array_position(private.teams(), r.team), array_position(private.shifts(), r.shift))
        from private.reports r left join private.users ap on ap.id = r.approved_by
       where p_before is null or r.report_date < p_before), '[]'::jsonb),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'date', r.report_date, 'team', r.team, 'shift', r.shift, 'report_status', r.status,
               'user_name', ow.full_name, 'coworker_names', private.user_names(e.coworker_ids),
               'machine', e.machine, 'description', e.description, 'start_at', e.start_at, 'end_at', e.end_at,
               'completion', e.completion, 'note', e.note,
               'created_at', private.vn(e.created_at), 'updated_at', private.vn(e.updated_at))
             order by r.report_date, array_position(private.teams(), r.team), array_position(private.shifts(), r.shift),
                      coalesce(e.start_at, '9999'), e.id)
        from private.entries e join private.reports r on r.id = e.report_id join private.users ow on ow.id = e.user_id
       where p_before is null or r.report_date < p_before), '[]'::jsonb),
    'audit_log', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'created_at', private.vn(a.created_at), 'date', r.report_date,
               'team', r.team, 'shift', r.shift, 'user_name', au.full_name, 'action', a.action, 'after_approval', a.after_approval,
               'entry_id', a.entry_id, 'old_value', a.old_value, 'new_value', a.new_value) order by a.id)
        from private.audit_log a
        left join private.reports r on r.id = a.report_id
        join private.users au on au.id = a.user_id
       where p_before is null or r.report_date < p_before), '[]'::jsonb))
$$;

create or replace function public.admin_storage(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token);
begin
  perform private.require_admin(u);
  return jsonb_build_object(
    -- Supabase tính hạn mức 500 MB (Free) = tổng mọi database trên máy chủ (postgres + template0 + template1),
    -- đơn vị thập phân (1 MB = 1.000.000 byte) → khớp số "Database Size" ở trang Usage
    'db_bytes', (select sum(pg_catalog.pg_database_size(d.oid))::bigint from pg_catalog.pg_database d),
    'app_bytes', coalesce((select sum(pg_catalog.pg_total_relation_size(c.oid))::bigint
                             from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                            where n.nspname = 'private' and c.relkind = 'r'), 0),
    'limit_bytes', 500 * 1000 * 1000,
    'users', (select count(*) from private.users),
    'reports', (select count(*) from private.reports),
    'entries', (select count(*) from private.entries),
    'audit_log', (select count(*) from private.audit_log),
    'first_date', (select min(report_date) from private.reports),
    'last_date', (select max(report_date) from private.reports),
    'max_purge_before', private.max_purge_before(),
    'last_purge', (select jsonb_build_object('created_at', private.vn(l.created_at), 'user_name', pu.full_name,
                            'before', l.before_date, 'reports', l.reports, 'entries', l.entries)
                     from private.purge_log l join private.users pu on pu.id = l.user_id
                    order by l.id desc limit 1));
end $$;

/** Toàn bộ dữ liệu để sao lưu ra Excel (KHÔNG gồm mật khẩu / phiên đăng nhập) */
create or replace function public.admin_backup(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token);
begin
  perform private.require_admin(u);
  return private.backup_data(null);
end $$;

/** Xem trước: số dữ liệu sẽ bị xóa nếu xóa các báo cáo trước p_before */
create or replace function public.admin_purge_preview(p_token text, p_before text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_before);
begin
  perform private.require_admin(u);
  perform private.check_purge_date(d);
  return jsonb_build_object(
    'before', d,
    'reports', (select count(*) from private.reports where report_date < d),
    'entries', (select count(*) from private.entries e join private.reports r on r.id = e.report_id where r.report_date < d),
    'audit_log', (select count(*) from private.audit_log a join private.reports r on r.id = a.report_id where r.report_date < d),
    'first_date', (select min(report_date) from private.reports where report_date < d),
    'last_date', (select max(report_date) from private.reports where report_date < d));
end $$;

/** Sao lưu phần sắp xóa + cấp "phiếu" chứng nhận đã sao lưu (bắt buộc khi xóa) */
create or replace function public.admin_purge_backup(p_token text, p_before text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_before); v_ticket text;
begin
  perform private.require_admin(u);
  perform private.check_purge_date(d);
  delete from private.purge_tickets where created_at < now() - interval '1 day';
  v_ticket := encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.purge_tickets (ticket_hash, user_id, before_date) values (private.hash_token(v_ticket), u.id, d);
  return private.backup_data(d) || jsonb_build_object('ticket', v_ticket);
end $$;

/** Xóa vĩnh viễn các báo cáo trước p_before (kèm dòng công việc và lịch sử của chúng) */
create or replace function public.admin_purge(p_token text, p_before text, p_ticket text, p_confirm text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_before);
        n_rep int; n_ent int; n_aud int;
begin
  perform private.require_admin(u);
  perform private.check_purge_date(d);
  if coalesce(p_confirm, '') <> 'XOA' then
    perform private.err(400, 'Vui lòng gõ đúng chữ XOA để xác nhận.');
  end if;
  if p_ticket is null or not exists (
       select 1 from private.purge_tickets t
        where t.ticket_hash = private.hash_token(p_ticket) and t.user_id = u.id
          and t.before_date = d and t.created_at > now() - interval '30 minutes') then
    perform private.err(400, 'Bạn cần tải bản sao lưu của phần dữ liệu này trước khi xóa (bản sao lưu có hiệu lực 30 phút).');
  end if;

  delete from private.audit_log a using private.reports r where a.report_id = r.id and r.report_date < d;
  get diagnostics n_aud = row_count;
  select count(*) into n_ent from private.entries e join private.reports r on r.id = e.report_id where r.report_date < d;
  delete from private.reports where report_date < d;            -- dòng công việc tự xóa theo (on delete cascade)
  get diagnostics n_rep = row_count;

  delete from private.purge_tickets where user_id = u.id;
  insert into private.purge_log (user_id, before_date, reports, entries, audit_rows) values (u.id, d, n_rep, n_ent, n_aud);
  return jsonb_build_object('ok', true, 'reports', n_rep, 'entries', n_ent, 'audit_log', n_aud,
    'message', 'Đã xóa ' || n_rep || ' báo cáo, ' || n_ent || ' dòng công việc trước ngày ' || to_char(d, 'DD/MM/YYYY') || '.');
end $$;

-- ===== Báo cáo tổng hợp (Quản lý / Admin) =====
create or replace function public.reports_of_day(p_token text, p_date text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_date);
begin
  perform private.require_manager(u);
  -- mỗi nhóm: các ca có dữ liệu; nhóm chưa có gì thì hiện 1 báo cáo trống ca Hành chính
  return jsonb_build_object('date', d, 'reports', coalesce((
    select jsonb_agg(private.report_payload(u, d, x.team, x.shift)
                     order by array_position(private.teams(), x.team), array_position(private.shifts(), x.shift))
      from (
        select t as team, s as shift
          from unnest(private.viewable_teams(u)) t cross join unnest(private.shifts()) s
         where exists (select 1 from private.reports r where r.report_date = d and r.team = t and r.shift = s
                         and (r.status = 'approved' or exists (select 1 from private.entries e where e.report_id = r.id)))
            or (s = 'Hành chính' and not exists (
                  select 1 from private.reports r where r.report_date = d and r.team = t
                     and (r.status = 'approved' or exists (select 1 from private.entries e where e.report_id = r.id))))
      ) x), '[]'::jsonb));
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
      select day, jsonb_object_agg(team, jsonb_build_object('status', status, 'count', cnt)) as teams from (
        -- gộp các ca của 1 nhóm: "approved" khi mọi ca có dữ liệu đều đã duyệt
        select to_char(r.report_date, 'YYYY-MM-DD') as day, r.team,
               case when bool_and(r.status = 'approved') then 'approved' else 'draft' end as status, sum(c.cnt) as cnt
          from private.reports r
          join lateral (select count(*) as cnt from private.entries e where e.report_id = r.id) c on c.cnt > 0
         where r.report_date >= v_start and r.report_date < (v_start + interval '1 month')
           and r.team = any (private.viewable_teams(u))
         group by r.report_date, r.team) t
       group by day) s), '{}'::jsonb));
end $$;

drop function if exists public.report_history(text, text, text);
create or replace function public.report_history(p_token text, p_date text, p_team text, p_shift text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_date);
        v_shift text := private.check_shift(p_shift);
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
     where r.report_date = d and r.team = p_team and r.shift = v_shift), '[]'::jsonb));
end $$;

drop function if exists public.approve_report(text, text, text);
create or replace function public.approve_report(p_token text, p_date text, p_team text, p_shift text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_date); r private.reports;
        v_shift text := private.check_shift(p_shift);
begin
  perform private.require_manager(u);
  perform private.check_team(p_team);
  perform private.require_team(u, p_team);
  select * into r from private.reports where report_date = d and team = p_team and shift = v_shift for update;
  if not found or not exists (select 1 from private.entries where report_id = r.id) then
    perform private.err(400, 'Báo cáo chưa có dòng công việc nào.');
  end if;
  if r.status = 'approved' then perform private.err(400, 'Báo cáo đã được phê duyệt trước đó.'); end if;
  update private.reports set status = 'approved', approved_by = u.id, approved_at = now() where id = r.id;
  perform private.log(r.id, null, u.id, 'approve', false, null, null);
  return jsonb_build_object('ok', true, 'message', 'Đã phê duyệt báo cáo nhóm ' || p_team || ' (' || v_shift || ').');
end $$;

drop function if exists public.unapprove_report(text, text, text);
create or replace function public.unapprove_report(p_token text, p_date text, p_team text, p_shift text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_date); r private.reports;
        v_shift text := private.check_shift(p_shift);
begin
  perform private.require_manager(u);
  perform private.check_team(p_team);
  select * into r from private.reports where report_date = d and team = p_team and shift = v_shift for update;
  if not found or r.status <> 'approved' then perform private.err(400, 'Báo cáo chưa được phê duyệt.'); end if;
  -- chỉ người đã bấm phê duyệt (hoặc Admin) được hủy
  if u.role <> 'admin' and r.approved_by is distinct from u.id then
    perform private.err(403, 'Chỉ người đã phê duyệt báo cáo này (hoặc Admin) mới hủy được phê duyệt.');
  end if;
  update private.reports set status = 'draft', approved_by = null, approved_at = null where id = r.id;
  perform private.log(r.id, null, u.id, 'unapprove', true, null, null);
  return jsonb_build_object('ok', true, 'message', 'Đã hủy phê duyệt, nhân viên nhóm ' || p_team || ' (' || v_shift || ') có thể sửa lại.');
end $$;

/** Dữ liệu để xuất Excel – chỉ trả về khi báo cáo đầy đủ */
drop function if exists public.report_export(text, text, text);
create or replace function public.report_export(p_token text, p_date text, p_team text, p_shift text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u private.users := private.auth_user(p_token); d date := private.check_date(p_date); v jsonb;
        v_shift text := private.check_shift(p_shift);
begin
  perform private.require_manager(u);
  perform private.check_team(p_team);
  perform private.require_team(u, p_team);
  v := private.report_payload(u, d, p_team, v_shift);
  if jsonb_array_length(v -> 'entries') = 0 then
    perform private.err(400, 'Báo cáo chưa có dòng công việc nào để xuất.');
  end if;
  if jsonb_array_length(v -> 'missing') > 0 then
    perform private.err(400, 'Báo cáo chưa đầy đủ, chưa thể xuất Excel.', (v -> 'missing')::text);
  end if;
  -- chữ ký của người đã bấm phê duyệt (chỉ khi báo cáo đã duyệt)
  return v || coalesce((
    select jsonb_build_object('approved_by_signature', au.signature,
                              'approved_by_sign_name', coalesce(au.signature_name, au.full_name))
      from private.reports rp join private.users au on au.id = rp.approved_by
     where rp.report_date = d and rp.team = p_team and rp.shift = v_shift and rp.status = 'approved'),
    jsonb_build_object('approved_by_signature', null, 'approved_by_sign_name', null));
end $$;

-- ---------------------------------------------------------------------
--  PHÂN QUYỀN GỌI HÀM
-- ---------------------------------------------------------------------
do $$
declare f record;
        api text[] := array['register', 'login', 'logout', 'me', 'change_password', 'update_profile',
                            'admin_list_users', 'admin_set_status', 'admin_update_user', 'admin_reset_password',
                            'my_entries', 'add_entry', 'add_entries', 'update_entry', 'delete_entry',
                            'reports_of_day', 'reports_month', 'report_history', 'approve_report',
                            'unapprove_report', 'report_export', 'list_coworkers', 'admin_storage', 'admin_backup',
                            'admin_purge_preview', 'admin_purge_backup', 'admin_purge', 'admin_set_signature', 'set_my_signature'];
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

-- Bật RLS cho mọi bảng nội bộ (thêm 1 lớp bảo vệ; các hàm API chạy với quyền chủ sở hữu nên không bị ảnh hưởng)
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'private' loop
    execute format('alter table private.%I enable row level security', t.tablename);
  end loop;
end $$;
revoke all on all sequences in schema private from public;

-- Báo PostgREST (Supabase) tải lại danh sách hàm
notify pgrst, 'reload schema';
