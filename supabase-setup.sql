-- =====================================================================
--  OH SNAP! Photobox - SETUP KEAMANAN SUPABASE (v6)
--  Jalankan SEKALI di: Supabase Dashboard -> SQL Editor -> New query -> Run
--  Aman dijalankan ulang (idempotent).
--
--  YANG BERUBAH DIBANDINGKAN SCRIPT LAMA:
--    - RLS dinyalakan. Pengunjung (anon) hanya boleh MEMBACA konten.
--    - Hanya admin yang login (email terdaftar di tabel cms_admins) yang boleh
--      mengubah konten & mengunggah/menghapus file.
--    - Kolom "admins" (berisi password polos) dihapus dari data CMS yang sudah ada.
--    - updated_at diisi otomatis oleh server (dipakai untuk deteksi bentrok antar-admin).
--    - Bucket hanya menerima gambar & video; daftar isi bucket tidak bisa dilihat publik.
--
--  >>> WAJIB: ganti email di LANGKAH 2 dengan email admin Anda sebelum Run <<<
-- =====================================================================


-- ---------------------------------------------------------------------
-- LANGKAH 1. Tabel daftar admin (tidak bisa diakses lewat API publik)
-- ---------------------------------------------------------------------
create table if not exists public.cms_admins (
  email text primary key
);
alter table public.cms_admins enable row level security;   -- tanpa policy = tertutup untuk anon & authenticated
revoke all on table public.cms_admins from anon, authenticated;


-- ---------------------------------------------------------------------
-- LANGKAH 2. DAFTARKAN EMAIL ADMIN  (EDIT BAGIAN INI)
--   Email harus sama persis dengan akun yang Anda buat di
--   Authentication -> Users -> Add user. Boleh lebih dari satu:
--   array['admin1@gmail.com', 'admin2@gmail.com']
-- ---------------------------------------------------------------------
do $$
declare
  admin_emails text[] := array['GANTI-DENGAN-EMAIL-ADMIN@gmail.com'];   -- <<< EDIT DI SINI
begin
  if exists (select 1 from unnest(admin_emails) e where e ilike 'GANTI-DENGAN%') then
    raise exception 'Belum diedit: ganti GANTI-DENGAN-EMAIL-ADMIN@gmail.com dengan email admin Anda di LANGKAH 2, lalu Run lagi.';
  end if;
  insert into public.cms_admins (email)
  select lower(trim(e)) from unnest(admin_emails) e
  on conflict (email) do nothing;
end $$;


-- ---------------------------------------------------------------------
-- LANGKAH 3. Fungsi pengecek admin
-- ---------------------------------------------------------------------
create or replace function public.is_cms_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
    and exists (
      select 1 from public.cms_admins a
      where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    );
$$;
revoke all on function public.is_cms_admin() from public;
grant execute on function public.is_cms_admin() to authenticated;


-- ---------------------------------------------------------------------
-- LANGKAH 4. Tabel konten website (cms_settings)
-- ---------------------------------------------------------------------
create table if not exists public.cms_settings (
  id int primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Cadangan sekali jalan (TANPA kolom admins/password) - jaga-jaga bila ingin kembali ke data sebelumnya
create table if not exists public.cms_settings_backup_v5 as
  select id, (data - 'admins') as data, updated_at, now() as backed_up_at
  from public.cms_settings;
alter table public.cms_settings_backup_v5 enable row level security;
revoke all on table public.cms_settings_backup_v5 from anon, authenticated;

-- Hapus password admin lama yang tadinya tersimpan di dalam data CMS (dulu terbaca publik)
update public.cms_settings
   set data = data - 'admins' - 'resendOverrides'
 where data ? 'admins' or data ? 'resendOverrides';

-- updated_at diisi server, bukan jam perangkat admin
create or replace function public.cms_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cms_settings_touch on public.cms_settings;
create trigger cms_settings_touch
  before insert or update on public.cms_settings
  for each row execute function public.cms_touch_updated_at();

-- RLS: bersihkan semua policy lama lalu pasang yang baru
alter table public.cms_settings enable row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'cms_settings' loop
    execute format('drop policy %I on public.cms_settings', p.policyname);
  end loop;
end $$;

create policy "cms baca publik"   on public.cms_settings for select to anon, authenticated using (id = 1);
create policy "cms tambah admin"  on public.cms_settings for insert to authenticated with check (id = 1 and public.is_cms_admin());
create policy "cms ubah admin"    on public.cms_settings for update to authenticated using (id = 1 and public.is_cms_admin()) with check (id = 1 and public.is_cms_admin());
-- (tidak ada policy DELETE: baris konten tidak bisa dihapus lewat API)

revoke all on table public.cms_settings from anon, authenticated;
grant select on table public.cms_settings to anon;
grant select, insert, update on table public.cms_settings to authenticated;


-- ---------------------------------------------------------------------
-- LANGKAH 5. Storage bucket ohsnap-media
--   Publik untuk DIBACA lewat URL (agar gambar/video tampil), tapi hanya
--   admin yang boleh upload/ubah/hapus. Maks 50 MB per file.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ohsnap-media', 'ohsnap-media', true, 52428800,
  array['image/jpeg','image/png','image/webp','image/gif','video/*']
)
on conflict (id) do update set
  public = true,
  file_size_limit = 52428800,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif','video/*'];

-- Policy lama yang terbuka untuk semua orang
drop policy if exists "media public read"   on storage.objects;
drop policy if exists "media public upload" on storage.objects;
drop policy if exists "media public update" on storage.objects;
drop policy if exists "media public delete" on storage.objects;
-- Policy baru (aman dijalankan ulang)
drop policy if exists "ohsnap media admin select" on storage.objects;
drop policy if exists "ohsnap media admin insert" on storage.objects;
drop policy if exists "ohsnap media admin update" on storage.objects;
drop policy if exists "ohsnap media admin delete" on storage.objects;

-- Catatan: file di bucket publik tetap bisa dibuka lewat URL-nya tanpa policy select.
-- Policy select di bawah hanya untuk admin (dibutuhkan fitur upload-ganti/upsert) dan
-- mencegah orang asing melihat DAFTAR seluruh isi bucket.
create policy "ohsnap media admin select" on storage.objects for select to authenticated
  using (bucket_id = 'ohsnap-media' and public.is_cms_admin());
create policy "ohsnap media admin insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'ohsnap-media' and public.is_cms_admin());
create policy "ohsnap media admin update" on storage.objects for update to authenticated
  using (bucket_id = 'ohsnap-media' and public.is_cms_admin())
  with check (bucket_id = 'ohsnap-media' and public.is_cms_admin());
create policy "ohsnap media admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'ohsnap-media' and public.is_cms_admin());


-- ---------------------------------------------------------------------
-- LANGKAH 6. Pemeriksaan (hasil harus: rls_aktif = true, admin terdaftar muncul,
--            dan policy cms_settings berjumlah 3)
-- ---------------------------------------------------------------------
select
  (select relrowsecurity from pg_class where oid = 'public.cms_settings'::regclass) as rls_aktif,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'cms_settings') as jumlah_policy,
  (select string_agg(email, ', ') from public.cms_admins) as admin_terdaftar,
  (select (data ? 'admins') from public.cms_settings where id = 1) as masih_ada_password_di_data;
