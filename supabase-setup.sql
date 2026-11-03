-- 1. Pastikan tabel cms_settings bebas hambatan RLS
create table if not exists public.cms_settings (
  id int primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
alter table public.cms_settings disable row level security;
grant all on table public.cms_settings to anon, authenticated, service_role;

-- 2. Buat & aktifkan bucket ohsnap-media (Public, maks 50MB per file sesuai batas Supabase Free 1GB)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ohsnap-media', 'ohsnap-media', true, 52428800, null)
on conflict (id) do update set 
  public = true, 
  file_size_limit = 52428800, 
  allowed_mime_types = null;

-- 3. Berikan izin penuh (Read, Upload, Update/Upsert, Delete) agar upload & hapus file lama berjalan lancar
drop policy if exists "media public read" on storage.objects;
drop policy if exists "media public upload" on storage.objects;
drop policy if exists "media public update" on storage.objects;
drop policy if exists "media public delete" on storage.objects;

create policy "media public read" on storage.objects for select to public using (bucket_id = 'ohsnap-media');
create policy "media public upload" on storage.objects for insert to public with check (bucket_id = 'ohsnap-media');
create policy "media public update" on storage.objects for update to public using (bucket_id = 'ohsnap-media');
create policy "media public delete" on storage.objects for delete to public using (bucket_id = 'ohsnap-media');