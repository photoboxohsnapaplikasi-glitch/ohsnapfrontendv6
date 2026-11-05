/* OH SNAP! - Klien Cloud Bersama (Supabase 1GB Storage & Global Sync Ready) */
(function () {
  const SUPABASE_URL = 'https://wiatbabvafjktwrdirys.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_miaUyHiO1kYUCyu7FxvGYg_RslVJWPx';
  const TABLE = 'cms_settings';
  const BUCKET = 'ohsnap-media';
  const BASE_HEADERS = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY
  };

  let cache = null, cacheAt = 0;

  function escHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Sanitasi judul: hanya izinkan tag <span>...</span> dan <br>, blokir semua script/event handler XSS
  function safeTitleHtml(str) {
    if (str === null || str === undefined) return '';
    return escHtml(str)
      .replace(/&lt;span&gt;/gi, '<span>')
      .replace(/&lt;\/span&gt;/gi, '</span>')
      .replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  }

  // Sanitasi URL: hanya izinkan http://, https://, atau path lokal yang aman (blokir javascript: dan data:text/html)
  function safeUrl(url, fallback) {
    const fb = fallback !== undefined ? fallback : '#';
    if (!url || typeof url !== 'string') return fb;
    const clean = url.trim();
    if (!clean || clean === '#') return fb;
    if (/^https?:\/\//i.test(clean)) return clean;
    if (/^(images\/|blob:|data:image\/|data:video\/)/i.test(clean)) return clean;
    return fb;
  }

  function stripSensitiveForPublic(dataObj) {
    if (!dataObj || typeof dataObj !== 'object') return dataObj;
    const copy = JSON.parse(JSON.stringify(dataObj));
    delete copy.admins;
    delete copy.resendOverrides;
    return copy;
  }

  function getAdminToken() {
    try { return sessionStorage.getItem('ohsnap_admin_token') || ''; } catch (e) { return ''; }
  }

  // Ambil data CMS dari cloud dengan timeout 8 detik
  async function load(force) {
    if (!force && cache && Date.now() - cacheAt < 4000) return cache;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.1&select=data,updated_at`, {
        headers: BASE_HEADERS,
        cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
      const rows = await res.json();
      if (Array.isArray(rows) && rows[0] && rows[0].data && Object.keys(rows[0].data).length > 0) {
        cache = stripSensitiveForPublic(rows[0].data);
        if (!cache.lastUpdated && rows[0].updated_at) {
          cache.lastUpdated = new Date(rows[0].updated_at).getTime();
        }
      } else {
        cache = null;
      }
      cacheAt = Date.now();
      return cache;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Dipakai semua halaman frontend: ambil data terbaru dari cloud & bersihkan dari properti sensitif
  async function pullIfNewer() {
    try {
      const remote = await load(true);
      if (!remote || Object.keys(remote).length === 0) return null;
      const publicClean = stripSensitiveForPublic(remote);
      const remoteTime = Number(remote.lastUpdated || 0);
      try {
        localStorage.setItem('ohsnap_cms_data', JSON.stringify(publicClean));
        if (remoteTime) {
          localStorage.setItem('ohsnap_cloud_synced_at', String(remoteTime));
        }
      } catch (e) {}
      return publicClean;
    } catch (e) {
      console.warn('[OhSnapCloud] gagal ambil data cloud:', e.message || e);
      return null;
    }
  }

  // Login Admin Server-Side via RPC verify_admin_login
  async function loginAdmin(username, password) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/verify_admin_login`, {
      method: 'POST',
      headers: Object.assign({}, BASE_HEADERS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ p_username: username, p_password: password })
    });
    if (!res.ok) {
      const errText = await res.text();
      const err = new Error('HTTP ' + res.status + ': ' + errText.slice(0, 160));
      err.status = res.status;
      throw err;
    }
    return await res.json();
  }

  async function logoutAdminSession() {
    const token = getAdminToken();
    if (!token) return;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/logout_admin_session`, {
        method: 'POST',
        headers: Object.assign({}, BASE_HEADERS, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ p_token: token })
      });
    } catch (e) {}
  }

  // Simpan data CMS ke cloud melalui RPC terautentikasi token (save_cms_secure)
  async function save(data, expectedMinTime) {
    const token = getAdminToken();
    const cleanPayload = stripSensitiveForPublic(data);
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/save_cms_secure`, {
      method: 'POST',
      headers: Object.assign({}, BASE_HEADERS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        p_token: token,
        p_data: cleanPayload,
        p_expected_min_time: Number(expectedMinTime || 0)
      })
    });

    if (rpcRes.ok) {
      const savedData = await rpcRes.json();
      cache = savedData;
      cacheAt = Date.now();
      return savedData;
    }

    const errBody = await rpcRes.text();
    if (errBody.includes('CONFLICT:')) {
      const conflictErr = new Error('Data di Cloud lebih baru (diubah oleh admin/perangkat lain). Muat ulang halaman terlebih dahulu.');
      conflictErr.code = 'CONFLICT';
      throw conflictErr;
    }
    if (errBody.includes('UNAUTHORIZED:')) {
      const authErr = new Error('Sesi login telah berakhir. Silakan login kembali.');
      authErr.status = 401;
      throw authErr;
    }

    const err = new Error('HTTP ' + rpcRes.status + ': ' + errBody.slice(0, 160));
    err.status = rpcRes.status;
    throw err;
  }

  // Kelola Akun Admin via Server-Side RPC (password tidak pernah dikirim balik ke klien)
  async function listAdmins() {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/list_admins_secure`, {
      method: 'POST',
      headers: Object.assign({}, BASE_HEADERS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ p_token: getAdminToken() })
    });
    if (!res.ok) throw new Error('Gagal memuat daftar admin (' + res.status + ')');
    return await res.json();
  }

  async function addAdmin(name, username, password) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/add_admin_secure`, {
      method: 'POST',
      headers: Object.assign({}, BASE_HEADERS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        p_token: getAdminToken(),
        p_name: name,
        p_username: username,
        p_password: password
      })
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(msg.slice(0, 180));
    }
    return await res.json();
  }

  async function deleteAdmin(adminId) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/delete_admin_secure`, {
      method: 'POST',
      headers: Object.assign({}, BASE_HEADERS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        p_token: getAdminToken(),
        p_admin_id: Number(adminId)
      })
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(msg.slice(0, 180));
    }
    return await res.json();
  }

  // Upload gambar/video ke Supabase Storage (1GB) dengan validasi ekstensi
  async function upload(fileOrBlob, folder, ext) {
    const cleanExt = (ext || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
    const allowedExts = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm', 'mov'];
    if (!allowedExts.includes(cleanExt)) {
      throw new Error('Format file tidak didukung: ' + cleanExt);
    }
    const safeFolder = (folder === 'video') ? 'video' : 'img';
    const path = `${safeFolder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${cleanExt}`;
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

  // Hapus file lama di Supabase Storage setelah simpan database sukses
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

  async function ping() {
    const t0 = performance.now();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?select=id&limit=1`, {
      headers: BASE_HEADERS,
      cache: 'no-store'
    });
    return { status: res.status, ms: Math.round(performance.now() - t0) };
  }

  window.OhSnapCloud = {
    load,
    pullIfNewer,
    loginAdmin,
    logoutAdminSession,
    save,
    listAdmins,
    addAdmin,
    deleteAdmin,
    upload,
    removeFile,
    ping,
    escHtml,
    safeTitleHtml,
    safeUrl,
    stripSensitiveForPublic,
    URL: SUPABASE_URL
  };
})();
