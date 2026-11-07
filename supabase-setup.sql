-- ============================================================================
-- OH SNAP! PHOTOBOX - SUPABASE SECURE SETUP (FINAL REVISI)
-- Jalankan seluruh skrip ini di Supabase Dashboard -> SQL Editor -> Run
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;
set search_path = public, extensions;

-- 1. Tabel Publik CMS Settings (Hanya Boleh Dibaca Publik, Tulis Wajib Token Admin)
create table if not exists public.cms_settings (
  id int primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);

alter table public.cms_settings enable row level security;

drop policy if exists "cms public read" on public.cms_settings;
drop policy if exists "cms anon write" on public.cms_settings;
drop policy if exists "cms anon update" on public.cms_settings;

create policy "cms public read" on public.cms_settings
  for select to anon, authenticated
  using (id = 1);

revoke all on table public.cms_settings from anon, authenticated;
grant select on table public.cms_settings to anon, authenticated;
grant all on table public.cms_settings to service_role;

-- 2. Tabel Privat Akun Admin, Sesi Login, Rate-Limit, & Izin Storage Satu-Kali-Pakai
create table if not exists public.cms_admins (
  id bigserial primary key,
  name text not null,
  username text not null unique,
  pass_hash text not null,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  created_at timestamptz default now()
);

alter table public.cms_admins add column if not exists failed_attempts int not null default 0;
alter table public.cms_admins add column if not exists locked_until timestamptz;

create table if not exists public.cms_login_guard (
  id int primary key default 1,
  failed_count int not null default 0,
  locked_until timestamptz
);

insert into public.cms_login_guard (id, failed_count, locked_until)
values (1, 0, null)
on conflict (id) do nothing;

create table if not exists public.cms_admin_sessions (
  token text primary key,
  admin_id bigint references public.cms_admins(id) on delete cascade,
  username text not null,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

create table if not exists public.cms_storage_permits (
  id bigserial primary key,
  session_token text references public.cms_admin_sessions(token) on delete cascade,
  object_name text not null,
  op text not null,
  expires_at timestamptz not null
);

alter table public.cms_admins enable row level security;
alter table public.cms_login_guard enable row level security;
alter table public.cms_admin_sessions enable row level security;
alter table public.cms_storage_permits enable row level security;

revoke all on table public.cms_admins from anon, authenticated;
revoke all on table public.cms_login_guard from anon, authenticated;
revoke all on table public.cms_admin_sessions from anon, authenticated;
revoke all on table public.cms_storage_permits from anon, authenticated;

grant all on table public.cms_admins to service_role;
grant all on table public.cms_login_guard to service_role;
grant all on table public.cms_admin_sessions to service_role;
grant all on table public.cms_storage_permits to service_role;

-- 3. Bersihkan daftar password lama dari JSON publik & siapkan akun admin awal (Bcrypt cost 10)
-- Catatan: Ganti password awal di bawah ini atau tambahkan admin baru lewat Dashboard Admin setelah login.
do $$
declare
  v_init_user text := 'admin';
  v_init_pass text := 'OhSnap#2026';
begin
  if exists (select 1 from public.cms_settings where id = 1) then
    update public.cms_settings
    set data = (data - 'admins') - 'resendOverrides'
    where id = 1 and (data ? 'admins' or data ? 'resendOverrides');
  end if;

  if not exists (select 1 from public.cms_admins) then
    insert into public.cms_admins (name, username, pass_hash)
    values ('Super Admin', v_init_user, crypt(v_init_pass, gen_salt('bf', 10)));
  end if;
end $$;

-- Hapus fungsi lama yang berisiko membocorkan status sesi ke anon
drop function if exists public.has_active_admin_session();

-- 4. Fungsi Izin Storage Spesifik Per-File & Satu-Kali-Pakai (Mencegah upload/hapus tanpa token admin)
create or replace function public.issue_storage_permit(
  p_token text,
  p_op text,
  p_object_name text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_clean_op text := lower(trim(coalesce(p_op, '')));
  v_clean_name text := trim(coalesce(p_object_name, ''));
  v_ttl interval;
begin
  delete from public.cms_storage_permits where expires_at <= now();

  if not exists (
    select 1 from public.cms_admin_sessions
    where token = coalesce(p_token, '') and expires_at > now()
  ) then
    raise exception 'UNAUTHORIZED: Sesi admin tidak valid.';
  end if;

  if v_clean_op not in ('insert', 'update', 'delete') then
    raise exception 'Operasi storage tidak valid.';
  end if;

  if not (v_clean_name like 'img/%' or v_clean_name like 'video/%') or v_clean_name like '%..%' then
    raise exception 'Path file storage tidak diizinkan.';
  end if;

  v_ttl := case when v_clean_name like 'video/%' then interval '10 minutes' else interval '60 seconds' end;

  insert into public.cms_storage_permits (session_token, object_name, op, expires_at)
  values (p_token, v_clean_name, v_clean_op, now() + v_ttl);

  return true;
end;
$$;

create or replace function public.revoke_storage_permit(
  p_token text,
  p_object_name text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if exists (
    select 1 from public.cms_admin_sessions
    where token = coalesce(p_token, '') and expires_at > now()
  ) then
    delete from public.cms_storage_permits
    where object_name = trim(coalesce(p_object_name, ''));
  end if;
  return true;
end;
$$;

create or replace function public.consume_storage_permit(
  p_op text,
  p_object_name text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_permit_id bigint;
begin
  delete from public.cms_storage_permits where expires_at <= now();

  select p.id into v_permit_id
  from public.cms_storage_permits p
  join public.cms_admin_sessions s on s.token = p.session_token
  where p.op = lower(trim(coalesce(p_op, '')))
    and p.object_name = trim(coalesce(p_object_name, ''))
    and p.expires_at > now()
    and s.expires_at > now()
  order by p.id desc
  limit 1;

  if v_permit_id is null then
    return false;
  end if;

  -- Langsung hanguskan izin begitu dipakai 1 kali agar tidak bisa dipakai ulang
  delete from public.cms_storage_permits where id = v_permit_id;
  return true;
end;
$$;

-- 5. Fungsi Verifikasi Token Sesi Admin (Dipakai juga oleh Google Apps Script Code.gs)
create or replace function public.verify_admin_token(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  delete from public.cms_admin_sessions where expires_at <= now();
  return exists (
    select 1 from public.cms_admin_sessions
    where token = coalesce(p_token, '')
      and length(coalesce(p_token, '')) >= 32
      and expires_at > now()
  );
end;
$$;

-- 6. Fungsi Login Admin Server-Side (Rate-Limit 5x Gagal = Kunci 5 Menit, Bcrypt Cost 10)
create or replace function public.verify_admin_login(p_username text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_guard public.cms_login_guard%rowtype;
  v_admin public.cms_admins%rowtype;
  v_token text;
  v_wait_sec int;
begin
  delete from public.cms_admin_sessions where expires_at <= now();

  select * into v_guard from public.cms_login_guard where id = 1 for update;
  if v_guard.locked_until is not null and v_guard.locked_until > now() then
    v_wait_sec := ceil(extract(epoch from (v_guard.locked_until - now())))::int;
    return jsonb_build_object(
      'ok', false,
      'error', 'Terlalu banyak percobaan login gagal. Coba lagi dalam ' || v_wait_sec || ' detik.'
    );
  end if;

  select * into v_admin
  from public.cms_admins
  where lower(username) = lower(trim(coalesce(p_username, '')))
  limit 1
  for update;

  if not found then
    update public.cms_login_guard
    set failed_count = failed_count + 1,
        locked_until = case when failed_count + 1 >= 5 then now() + interval '5 minutes' else null end
    where id = 1;
    return jsonb_build_object('ok', false, 'error', 'Username atau Password salah!');
  end if;

  if v_admin.locked_until is not null and v_admin.locked_until > now() then
    v_wait_sec := ceil(extract(epoch from (v_admin.locked_until - now())))::int;
    return jsonb_build_object(
      'ok', false,
      'error', 'Akun dikunci sementara karena terlalu banyak percobaan. Coba lagi dalam ' || v_wait_sec || ' detik.'
    );
  end if;

  if v_admin.pass_hash = crypt(coalesce(p_password, ''), v_admin.pass_hash) then
    update public.cms_login_guard set failed_count = 0, locked_until = null where id = 1;
    update public.cms_admins set failed_attempts = 0, locked_until = null where id = v_admin.id;

    v_token := encode(gen_random_bytes(32), 'hex');
    insert into public.cms_admin_sessions (token, admin_id, username, expires_at)
    values (v_token, v_admin.id, v_admin.username, now() + interval '12 hours');

    return jsonb_build_object(
      'ok', true,
      'token', v_token,
      'user', jsonb_build_object('id', v_admin.id, 'name', v_admin.name, 'username', v_admin.username)
    );
  end if;

  update public.cms_login_guard
  set failed_count = failed_count + 1,
      locked_until = case when failed_count + 1 >= 5 then now() + interval '5 minutes' else null end
  where id = 1;

  update public.cms_admins
  set failed_attempts = failed_attempts + 1,
      locked_until = case when failed_attempts + 1 >= 5 then now() + interval '5 minutes' else null end
  where id = v_admin.id;

  return jsonb_build_object('ok', false, 'error', 'Username atau Password salah!');
end;
$$;

create or replace function public.logout_admin_session(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  delete from public.cms_storage_permits where session_token = coalesce(p_token, '');
  delete from public.cms_admin_sessions where token = coalesce(p_token, '');
  return true;
end;
$$;

-- 7. Fungsi Simpan CMS dengan Kunci Baris & Proteksi Data Basi (Anti-Timpa)
create or replace function public.save_cms_secure(
  p_token text,
  p_data jsonb,
  p_expected_min_time bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_session public.cms_admin_sessions%rowtype;
  v_current jsonb;
  v_current_time bigint;
  v_new_time bigint;
  v_clean jsonb;
begin
  select * into v_session
  from public.cms_admin_sessions
  where token = coalesce(p_token, '') and expires_at > now()
  limit 1;

  if not found then
    raise exception 'UNAUTHORIZED: Sesi admin tidak valid atau sudah berakhir. Silakan login kembali.';
  end if;

  update public.cms_admin_sessions set expires_at = now() + interval '12 hours' where token = v_session.token;

  select data into v_current from public.cms_settings where id = 1 for update;
  v_current_time := coalesce((v_current->>'lastUpdated')::bigint, 0);

  -- Tolak simpan jika data di Cloud sudah ada tetapi klien mengirim expected_min_time <= 0 (data lokal basi/offline) atau lebih lama dari Cloud
  if v_current is not null and v_current_time > 0 then
    if coalesce(p_expected_min_time, 0) <= 0 or v_current_time > p_expected_min_time then
      raise exception 'CONFLICT: Data di Cloud lebih baru (diubah oleh admin/perangkat lain). Muat ulang halaman terlebih dahulu.';
    end if;
  end if;

  v_new_time := greatest((extract(epoch from now()) * 1000)::bigint, v_current_time + 1);
  v_clean := ((coalesce(p_data, '{}'::jsonb) - 'admins') - 'resendOverrides') || jsonb_build_object('lastUpdated', v_new_time);

  insert into public.cms_settings (id, data, updated_at)
  values (1, v_clean, now())
  on conflict (id) do update
  set data = excluded.data,
      updated_at = excluded.updated_at;

  return v_clean;
end;
$$;

create or replace function public.list_admins_secure(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not exists (select 1 from public.cms_admin_sessions where token = coalesce(p_token, '') and expires_at > now()) then
    raise exception 'UNAUTHORIZED: Sesi admin tidak valid.';
  end if;

  return coalesce(
    (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'username', username) order by id asc) from public.cms_admins),
    '[]'::jsonb
  );
end;
$$;

create or replace function public.add_admin_secure(p_token text, p_name text, p_username text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_clean_user text;
  v_clean_pass text;
begin
  if not exists (select 1 from public.cms_admin_sessions where token = coalesce(p_token, '') and expires_at > now()) then
    raise exception 'UNAUTHORIZED: Sesi admin tidak valid.';
  end if;

  v_clean_user := lower(trim(coalesce(p_username, '')));
  v_clean_pass := trim(coalesce(p_password, ''));

  if v_clean_user = '' or trim(coalesce(p_name, '')) = '' or v_clean_pass = '' then
    raise exception 'Semua kolom (Nama, Username, Password) wajib diisi.';
  end if;

  if length(v_clean_pass) < 8 then
    raise exception 'Password minimal harus 8 karakter.';
  end if;

  if exists (select 1 from public.cms_admins where lower(username) = v_clean_user) then
    raise exception 'Username tersebut sudah terdaftar.';
  end if;

  insert into public.cms_admins (name, username, pass_hash)
  values (trim(p_name), v_clean_user, crypt(v_clean_pass, gen_salt('bf', 10)));

  return public.list_admins_secure(p_token);
end;
$$;

create or replace function public.delete_admin_secure(p_token text, p_admin_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not exists (select 1 from public.cms_admin_sessions where token = coalesce(p_token, '') and expires_at > now()) then
    raise exception 'UNAUTHORIZED: Sesi admin tidak valid.';
  end if;

  if (select count(*) from public.cms_admins) <= 1 then
    raise exception 'Minimal harus tersisa 1 akun admin aktif!';
  end if;

  delete from public.cms_admins where id = p_admin_id;
  return public.list_admins_secure(p_token);
end;
$$;

grant execute on function public.issue_storage_permit(text, text, text) to anon, authenticated;
grant execute on function public.revoke_storage_permit(text, text) to anon, authenticated;
grant execute on function public.consume_storage_permit(text, text) to anon, authenticated;
grant execute on function public.verify_admin_token(text) to anon, authenticated;
grant execute on function public.verify_admin_login(text, text) to anon, authenticated;
grant execute on function public.logout_admin_session(text) to anon, authenticated;
grant execute on function public.save_cms_secure(text, jsonb, bigint) to anon, authenticated;
grant execute on function public.list_admins_secure(text) to anon, authenticated;
grant execute on function public.add_admin_secure(text, text, text, text) to anon, authenticated;
grant execute on function public.delete_admin_secure(text, bigint) to anon, authenticated;

-- 8. Bucket Storage ohsnap-media (Tulis/Ubah/Hapus Wajib Memiliki Izin Satu-Kali-Pakai Per-File)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ohsnap-media',
  'ohsnap-media',
  true,
  52428800,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime']
)
on conflict (id) do update set 
  public = true, 
  file_size_limit = 52428800, 
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'];

drop policy if exists "media public read" on storage.objects;
drop policy if exists "media public upload" on storage.objects;
drop policy if exists "media public update" on storage.objects;
drop policy if exists "media public delete" on storage.objects;
drop policy if exists "media admin upload" on storage.objects;
drop policy if exists "media admin update" on storage.objects;
drop policy if exists "media admin delete" on storage.objects;

create policy "media public read" on storage.objects
  for select to public
  using (bucket_id = 'ohsnap-media');

create policy "media admin upload" on storage.objects
  for insert to public
  with check (
    bucket_id = 'ohsnap-media'
    and public.consume_storage_permit('insert', name)
  );

create policy "media admin update" on storage.objects
  for update to public
  using (
    bucket_id = 'ohsnap-media'
    and public.consume_storage_permit('update', name)
  );

create policy "media admin delete" on storage.objects
  for delete to public
  using (
    bucket_id = 'ohsnap-media'
    and public.consume_storage_permit('delete', name)
  );
