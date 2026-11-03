/* OH SNAP! - Klien Cloud Bersama (Supabase 1GB Storage & Global Sync Ready) */
(function () {
  const SUPABASE_URL = 'https://kbkayevpbeijuuufnrgt.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_AG1wxrYq1moobWYJjC6htQ_TB-Siffl';
  const TABLE = 'cms_settings';
  const BUCKET = 'ohsnap-media';
  const BASE_HEADERS = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY
  };

  let cache = null, cacheAt = 0;

  // Ambil data CMS dari cloud
  async function load(force) {
    if (!force && cache && Date.now() - cacheAt < 4000) return cache;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.1&select=data,updated_at`, {
      headers: BASE_HEADERS,
      cache: 'no-store'
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
    const rows = await res.json();
    if (Array.isArray(rows) && rows[0] && rows[0].data && Object.keys(rows[0].data).length > 0) {
      cache = rows[0].data;
      if (!cache.lastUpdated && rows[0].updated_at) {
        cache.lastUpdated = new Date(rows[0].updated_at).getTime();
      }
    } else {
      cache = null;
    }
    cacheAt = Date.now();
    return cache;
  }

  // Dipakai semua halaman frontend: ambil data terbaru dari cloud tanpa menimpa draft admin aktif
  async function pullIfNewer() {
    try {
      const remote = await load(true);
      if (!remote || Object.keys(remote).length === 0) return null;
      let local = null;
      try { local = JSON.parse(localStorage.getItem('ohsnap_cms_data')); } catch (e) {}
      const remoteTime = Number(remote.lastUpdated || 0);
      const localTime = Number((local && local.lastUpdated) || 0);
      const isAdminSession = !!(sessionStorage.getItem('ohsnap_admin_logged') || localStorage.getItem('ohsnap_admin_logged'));

      if (!isAdminSession || !local || remoteTime >= localTime) {
        try {
          localStorage.setItem('ohsnap_cms_data', JSON.stringify(remote));
          if (remoteTime) {
            localStorage.setItem('ohsnap_cloud_synced_at', String(remoteTime));
          }
        } catch (e) {}
        return remote;
      }
      return local;
    } catch (e) {
      console.warn('[OhSnapCloud] gagal ambil data cloud:', e.message || e);
      return null;
    }
  }

  // Simpan data CMS ke cloud (insert/update baris id=1)
  async function save(data) {
    const payloadData = Object.assign({}, data, { lastUpdated: Date.now() });
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?on_conflict=id`, {
      method: 'POST',
      headers: Object.assign({}, BASE_HEADERS, {
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      }),
      body: JSON.stringify({
        id: 1,
        data: payloadData,
        updated_at: new Date().toISOString()
      })
    });
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 160));
      err.status = res.status;
      throw err;
    }
    cache = payloadData;
    cacheAt = Date.now();
    return payloadData;
  }

  // Upload gambar/video ke Supabase Storage (1GB), hasilnya URL publik
  async function upload(fileOrBlob, folder, ext) {
    const cleanExt = (ext || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
    const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${cleanExt}`;
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: Object.assign({}, BASE_HEADERS, {
        'Content-Type': fileOrBlob.type || 'application/octet-stream',
        'x-upsert': 'true'
      }),
      body: fileOrBlob
    });
    if (!res.ok) throw new Error('Upload HTTP ' + res.status + ': ' + (await res.text()).slice(0, 160));
    return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  }

  // Hapus file lama di Supabase Storage saat diganti agar kuota 1GB tetap hemat
  async function removeFile(publicUrl) {
    try {
      const marker = `/storage/v1/object/public/${BUCKET}/`;
      if (!publicUrl || typeof publicUrl !== 'string' || !publicUrl.includes(marker)) return;
      const filePath = publicUrl.split(marker)[1];
      if (!filePath) return;
      await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${filePath}`, {
        method: 'DELETE',
        headers: BASE_HEADERS
      });
    } catch (e) {}
  }

  // Tes koneksi sederhana
  async function ping() {
    const t0 = performance.now();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?select=id&limit=1`, {
      headers: BASE_HEADERS,
      cache: 'no-store'
    });
    return { status: res.status, ms: Math.round(performance.now() - t0) };
  }

  window.OhSnapCloud = { load, pullIfNewer, save, upload, removeFile, ping, URL: SUPABASE_URL };
})();