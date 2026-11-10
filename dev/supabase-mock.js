'use strict';
/**
 * Giả lập Supabase để CHẠY THỬ và TEST trên máy, không cần tài khoản Supabase.
 * - Chạy đúng file supabase/schema.sql trên PostgreSQL nhúng (PGlite).
 * - Nhận POST /rest/v1/rpc/<hàm> giống PostgREST của Supabase, gọi hàm với vai trò "anon".
 * - Lỗi mã PTxxx → HTTP status xxx, body { code, message, details }.
 */
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');

const SCHEMA_FILE = path.join(__dirname, '..', 'supabase', 'schema.sql');

async function createMockSupabase({ dataDir } = {}) {
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const db = new PGlite({ ...(dataDir ? { dataDir } : {}), extensions: { pgcrypto } });
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;`);
  await db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));

  // Danh sách tham số của từng hàm API (giống PostgREST đọc từ pg_proc)
  const { rows } = await db.query(`
    select p.proname as name, p.proargnames as args,
           array(select format_type(t, null) from unnest(p.proargtypes) t) as types
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`);
  const fns = new Map(rows.map((r) => [r.name, r.args.map((a, i) => ({ name: a, type: r.types[i] }))]));

  async function rpc(name, body) {
    const sig = fns.get(name);
    if (!sig) return { status: 404, body: { code: 'PGRST202', message: `Không tìm thấy hàm ${name}` } };
    const params = [];
    const args = sig.map((a, i) => {
      let v = body[a.name];
      if (v === undefined) v = null;
      if (a.type === 'jsonb') v = v === null ? null : JSON.stringify(v);
      else if (a.type === 'text[]') v = v === null ? null : JSON.stringify(v);
      else if (v !== null && a.type === 'text') v = typeof v === 'string' ? v : JSON.stringify(v);
      // boolean / bigint: giữ nguyên kiểu JSON
      params.push(v);
      const p = `$${i + 1}`;
      const expr = a.type === 'text[]' ? `(select array(select jsonb_array_elements_text(${p}::jsonb)))` : `${p}::${a.type}`;
      return `${a.name} => ${expr}`;
    });
    try {
      const result = await db.transaction(async (tx) => {
        await tx.exec('set local role anon');
        return tx.query(`select public.${name}(${args.join(', ')}) as r`, params);
      });
      return { status: 200, body: result.rows[0].r };
    } catch (e) {
      const m = /^PT(\d{3})$/.exec(e.code || '');
      const status = m ? Number(m[1]) : e.code === '42501' ? 401 : 400;
      return { status, body: { code: e.code, message: e.message, details: e.detail || null, hint: null } };
    }
  }

  /** Middleware http: trả true nếu đã xử lý */
  async function handle(req, res) {
    const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(req.url.split('?')[0]);
    if (!m) return false;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, apikey, authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return true; }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 500_000) { res.writeHead(413); res.end(); return true; }
    }
    let body;
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = null; }
    const out = body && typeof body === 'object' ? await rpc(m[1], body) : { status: 400, body: { message: 'JSON không hợp lệ' } };
    res.writeHead(out.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out.body));
    return true;
  }

  /** Tạo/đặt lại Admin (tương đương chạy select private.create_admin(...) trong SQL Editor) */
  async function createAdmin(username, fullName, password) {
    const r = await db.query('select private.create_admin($1, $2, $3) as msg', [username, fullName, password]);
    return r.rows[0].msg;
  }

  return { db, rpc, handle, createAdmin, close: () => db.close() };
}

module.exports = { createMockSupabase };
