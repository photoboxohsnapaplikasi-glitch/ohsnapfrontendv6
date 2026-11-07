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
  let lastKnownCloudTime = 0;
  let saveQueue = Promise.resolve();

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

  // Sanitasi URL: hanya izinkan http://, https://, atau path lokal yang aman (blokir javascript:, vbscript:, data:text/html)
  function safeUrl(url, fallback) {
    const fb = fallback !== undefined ? fallback : '#';
    if (!url || typeof url !== 'string') return fb;
    const clean = url.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
    if (!clean || clean === '#') return fb;
    const probe = clean.replace(/\s+/g, '');
    if (/^[a-z][a-z0-9+.\-]*:/i.test(probe)) {
      if (/^https?:\/\//i.test(probe)) return clean;
      if (/^blob:/i.test(probe)) return clean;
      if (/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(probe)) return clean;
      if (/^data:video\/(mp4|webm|quicktime);base64,/i.test(probe)) return clean;
      return fb;
    }
    if (/^images\/[a-zA-Z0-9._\-/]+$/.test(clean) && !clean.includes('..')) return clean;
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

  function getKnownCloudTime() {
    return lastKnownCloudTime;
  }

  function setKnownCloudTime(t) {
    const n = Number(t || 0);
    if (n > lastKnownCloudTime) lastKnownCloudTime = n;
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
        if (cache.lastUpdated) setKnownCloudTime(cache.lastUpdated);
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

  // Logout Admin Server-Side: hapus sesi & izin storage di server sebelum keluar
  async function logoutAdminSession(explicitToken) {
    const token = explicitToken || getAdminToken();
    if (!token) return;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/logout_admin_session`, {
        method: 'POST',
        keepalive: true,
        headers: Object.assign({}, BASE_HEADERS, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ p_token: token })
      });
    } catch (e) {}
  }

  // Simpan data CMS ke cloud secara berurutan (antrean mutex) agar auto-save & klik Simpan tidak saling tabrakan
  function save(data, expectedMinTime) {
    if (expectedMinTime !== undefined && expectedMinTime !== null) {
      setKnownCloudTime(expectedMinTime);
    }
    const snapshot = stripSensitiveForPublic(data);
    const task = saveQueue.catch(() => {}).then(async () => {
      const token = getAdminToken();
      if (!token) {
        const authErr = new Error('Sesi login telah berakhir. Silakan login kembali.');
        authErr.status = 401;
        throw authErr;
      }
      const minTimeToUse = lastKnownCloudTime > 0 ? lastKnownCloudTime : Number(expectedMinTime || 0);
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/save_cms_secure`, {
        method: 'POST',
        headers: Object.assign({}, BASE_HEADERS, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          p_token: token,
          p_data: snapshot,
          p_expected_min_time: minTimeToUse
        })
      });

      if (rpcRes.ok) {
        const savedData = await rpcRes.json();
        if (savedData && savedData.lastUpdated) {
          lastKnownCloudTime = Number(savedData.lastUpdated);
        }
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
    });
    saveQueue = task.catch(() => {});
    return task;
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

  // Minta izin satu-kali-pakai untuk 1 file spesifik di Storage
  async function requestStoragePermit(op, objectPath) {
    const token = getAdminToken();
    if (!token) {
      const e = new Error('Sesi login telah berakhir. Silakan login kembali.');
      e.status = 401;
      throw e;
    }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/issue_storage_permit`, {
      method: 'POST',
      headers: Object.assign({}, BASE_HEADERS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        p_token: token,
        p_op: op,
        p_object_name: objectPath
      })
    });
    if (!res.ok) {
      const msg = await res.text();
      const err = new Error('Izin Storage ditolak (' + res.status + '): ' + msg.slice(0, 120));
      err.status = res.status;
      throw err;
    }
  }

  async function revokeStoragePermit(objectPath) {
    const token = getAdminToken();
    if (!token || !objectPath) return;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/revoke_storage_permit`, {
        method: 'POST',
        headers: Object.assign({}, BASE_HEADERS, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          p_token: token,
          p_object_name: objectPath
        })
      });
    } catch (e) {}
  }

  // Upload gambar/video ke Supabase Storage (1GB) dengan izin satu-kali-pakai per-file
  async function upload(fileOrBlob, folder, ext) {
    const cleanExt = (ext || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
    const allowedExts = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm', 'mov'];
    if (!allowedExts.includes(cleanExt)) {
      throw new Error('Format file tidak didukung: ' + cleanExt);
    }
    const safeFolder = (folder === 'video') ? 'video' : 'img';
    const path = `${safeFolder}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${cleanExt}`;

    await requestStoragePermit('insert', path);
    try {
      const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST',
        headers: Object.assign({}, BASE_HEADERS, {
          'Content-Type': fileOrBlob.type || 'application/octet-stream'
        }),
        body: fileOrBlob
      });
      if (!res.ok) throw new Error('Upload HTTP ' + res.status + ': ' + (await res.text()).slice(0, 160));
      return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
    } finally {
      await revokeStoragePermit(path);
    }
  }

  // Hapus file lama di Supabase Storage setelah simpan database sukses
  async function removeFile(publicUrl) {
    let filePath = '';
    try {
      const marker = `/storage/v1/object/public/${BUCKET}/`;
      if (!publicUrl || typeof publicUrl !== 'string' || !publicUrl.includes(marker)) return;
      filePath = publicUrl.split(marker)[1];
      if (!filePath) return;
      await requestStoragePermit('delete', filePath);
      await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${filePath}`, {
        method: 'DELETE',
        headers: BASE_HEADERS
      });
    } catch (e) {
    } finally {
      if (filePath) await revokeStoragePermit(filePath);
    }
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
    getAdminToken,
    getKnownCloudTime,
    setKnownCloudTime,
    URL: SUPABASE_URL
  };
})();
