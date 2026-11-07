-- ============================================================================
-- OH SNAP! PHOTOBOX - SUPABASE SECURE SETUP (RLS + SERVER-SIDE AUTH RPC)
-- Tempel seluruh skrip ini di Supabase Dashboard -> SQL Editor -> Run
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

-- 2. Tabel Privat Akun Admin & Sesi Login (100% Tertutup dari Akses Publik/Anon)
create table if not exists public.cms_admins (
  id bigserial primary key,
  name text not null,
  username text not null unique,
  pass_hash text not null,
  created_at timestamptz default now()
);

create table if not exists public.cms_admin_sessions (
  token text primary key,
  admin_id bigint references public.cms_admins(id) on delete cascade,
  username text not null,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

alter table public.cms_admins enable row level security;
alter table public.cms_admin_sessions enable row level security;

revoke all on table public.cms_admins from anon, authenticated;
revoke all on table public.cms_admin_sessions from anon, authenticated;
grant all on table public.cms_admins to service_role;
grant all on table public.cms_admin_sessions to service_role;

-- 3. Buat Akun Super Admin Bawaan (Username: admin | Password: ohsnap)
do $$
begin
  if not exists (select 1 from public.cms_admins) then
    insert into public.cms_admins (name, username, pass_hash)
    values ('Super Admin', 'admin', crypt('ohsnap', gen_salt('bf')));
  end if;
end $$;

-- 4. Fungsi Helper & RPC Keamanan Server-Side (SECURITY DEFINER)
create or replace function public.has_active_admin_session()
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.cms_admin_sessions
    where expires_at > now()
  );
$$;

create or replace function public.verify_admin_login(p_username text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_admin public.cms_admins%rowtype;
  v_token text;
  v_sha256 text;
begin
  delete from public.cms_admin_sessions where expires_at <= now();

  select * into v_admin
  from public.cms_admins
  where lower(username) = lower(trim(coalesce(p_username, '')))
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Username atau Password salah!');
  end if;

  v_sha256 := 'sha256:' || encode(digest('ohsnap_salt_' || coalesce(p_password, ''), 'sha256'), 'hex');

  if v_admin.pass_hash = crypt(coalesce(p_password, ''), v_admin.pass_hash)
     or v_admin.pass_hash = crypt(v_sha256, v_admin.pass_hash) then
    if v_admin.pass_hash = crypt(v_sha256, v_admin.pass_hash) then
      update public.cms_admins
      set pass_hash = crypt(coalesce(p_password, ''), gen_salt('bf'))
      where id = v_admin.id;
    end if;

    v_token := encode(gen_random_bytes(32), 'hex');
    insert into public.cms_admin_sessions (token, admin_id, username, expires_at)
    values (v_token, v_admin.id, v_admin.username, now() + interval '12 hours');

    return jsonb_build_object(
      'ok', true,
      'token', v_token,
      'resendKey', 'ohsnap_resend_sec_2026',
      'user', jsonb_build_object('id', v_admin.id, 'name', v_admin.name, 'username', v_admin.username)
    );
  end if;

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
  delete from public.cms_admin_sessions where token = coalesce(p_token, '');
  return true;
end;
$$;

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

  select data into v_current from public.cms_settings where id = 1;
  v_current_time := coalesce((v_current->>'lastUpdated')::bigint, 0);

  if p_expected_min_time > 0 and v_current_time > p_expected_min_time then
    raise exception 'CONFLICT: Data di Cloud lebih baru (diubah oleh admin/perangkat lain). Muat ulang halaman terlebih dahulu.';
  end if;

  v_new_time := (extract(epoch from now()) * 1000)::bigint;
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
begin
  if not exists (select 1 from public.cms_admin_sessions where token = coalesce(p_token, '') and expires_at > now()) then
    raise exception 'UNAUTHORIZED: Sesi admin tidak valid.';
  end if;

  v_clean_user := lower(trim(coalesce(p_username, '')));
  if v_clean_user = '' or trim(coalesce(p_name, '')) = '' or trim(coalesce(p_password, '')) = '' then
    raise exception 'Semua kolom (Nama, Username, Password) wajib diisi.';
  end if;

  if exists (select 1 from public.cms_admins where lower(username) = v_clean_user) then
    raise exception 'Username tersebut sudah terdaftar.';
  end if;

  insert into public.cms_admins (name, username, pass_hash)
  values (trim(p_name), v_clean_user, crypt(trim(p_password), gen_salt('bf')));

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

grant execute on function public.has_active_admin_session() to anon, authenticated;
grant execute on function public.verify_admin_login(text, text) to anon, authenticated;
grant execute on function public.logout_admin_session(text) to anon, authenticated;
grant execute on function public.save_cms_secure(text, jsonb, bigint) to anon, authenticated;
grant execute on function public.list_admins_secure(text) to anon, authenticated;
grant execute on function public.add_admin_secure(text, text, text, text) to anon, authenticated;
grant execute on function public.delete_admin_secure(text, bigint) to anon, authenticated;

-- 5. Bucket Storage ohsnap-media (Batas 50MB, Hanya Gambar/Video, Tulis/Hapus Wajib Sesi Admin Aktif)
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
    and (storage.foldername(name))[1] in ('img', 'video')
    and (auth.role() = 'authenticated' or public.has_active_admin_session())
  );

create policy "media admin update" on storage.objects
  for update to public
  using (
    bucket_id = 'ohsnap-media'
    and (storage.foldername(name))[1] in ('img', 'video')
    and (auth.role() = 'authenticated' or public.has_active_admin_session())
  );

create policy "media admin delete" on storage.objects
  for delete to public
  using (
    bucket_id = 'ohsnap-media'
    and (storage.foldername(name))[1] in ('img', 'video')
    and (auth.role() = 'authenticated' or public.has_active_admin_session())
  );
