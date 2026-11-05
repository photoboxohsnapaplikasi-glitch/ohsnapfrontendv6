/* OH SNAP! - Klien Cloud Bersama v6
 * Supabase (REST + Auth + Storage) + helper halaman bersama.
 * Perubahan utama v6: login Supabase Auth, simpan dengan cek versi (anti-timpa),
 * timeout jaringan, sanitasi HTML & URL dari CMS (anti-XSS), helper nav/slider/sinkron bersama.
 */
(function () {
  'use strict';

  const SUPABASE_URL = 'https://kbkayevpbeijuuufnrgt.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_AG1wxrYq1moobWYJjC6htQ_TB-Siffl';
  const TABLE = 'cms_settings';
  const BUCKET = 'ohsnap-media';
  const FETCH_TIMEOUT = 8000;               // ms, baca/simpan data
  const UPLOAD_TIMEOUT = 15 * 60 * 1000;    // ms, upload video besar
  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
  const SESSION_KEY = 'ohsnap_sb_session';
  const LS_CMS = 'ohsnap_cms_data';

  // ---------- penyimpanan browser yang aman (tidak melempar error) ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  const sstore = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) {} }
  };

  // ---------- fetch dengan batas waktu ----------
  async function tfetch(url, opts, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms || FETCH_TIMEOUT);
    try {
      return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  // ====================================================================
  //  AUTH (Supabase Auth, sesi disimpan per-tab di sessionStorage)
  // ====================================================================
  function readSession() {
    try { return JSON.parse(sstore.get(SESSION_KEY)); } catch (e) { return null; }
  }
  function writeSession(s) { sstore.set(SESSION_KEY, JSON.stringify(s)); }
  function clearSession() { sstore.del(SESSION_KEY); }

  async function authCall(path, body) {
    const res = await tfetch(SUPABASE_URL + '/auth/v1/' + path, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    let json = {};
    try { json = await res.json(); } catch (e) {}
    if (!res.ok) {
      const err = new Error(json.error_description || json.msg || json.message || ('HTTP ' + res.status));
      err.status = res.status;
      err.code = json.error_code || json.error || '';
      throw err;
    }
    return json;
  }

  function sessionFromResponse(j, fallbackEmail) {
    return {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
      email: (j.user && j.user.email) || fallbackEmail || ''
    };
  }

  const auth = {
    async signIn(email, password) {
      const j = await authCall('token?grant_type=password', { email: String(email).trim(), password: password });
      const s = sessionFromResponse(j, email);
      writeSession(s);
      return s;
    },
    hasSession() { const s = readSession(); return !!(s && s.access_token); },
    email() { const s = readSession(); return s ? s.email : ''; },
    // token valid (diperbarui otomatis bila hampir habis); null bila tidak ada sesi
    async getToken() {
      const s = readSession();
      if (!s || !s.access_token) return null;
      if (Date.now() < s.expires_at - 60000) return s.access_token;
      if (!s.refresh_token) { clearSession(); return null; }
      try {
        const j = await authCall('token?grant_type=refresh_token', { refresh_token: s.refresh_token });
        const n = sessionFromResponse(j, s.email);
        writeSession(n);
        return n.access_token;
      } catch (e) {
        if (e.status === 400 || e.status === 401 || e.status === 403) clearSession();
        return null;
      }
    },
    // verifikasi ke server bahwa sesi benar-benar sah
    async verify() {
      const token = await auth.getToken();
      if (!token) return false;
      try {
        const res = await tfetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token } });
        if (res.status === 401 || res.status === 403) { clearSession(); return false; }
        return res.ok;
      } catch (e) {
        // jaringan bermasalah: jangan paksa keluar, anggap sesi masih ada
        return true;
      }
    },
    async signOut() {
      const s = readSession();
      clearSession();
      if (s && s.access_token) {
        try {
          await tfetch(SUPABASE_URL + '/auth/v1/logout', { method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + s.access_token } }, 4000);
        } catch (e) {}
      }
    },
    async changePassword(newPassword) {
      const token = await auth.getToken();
      if (!token) { const e = new Error('Sesi login habis'); e.status = 401; throw e; }
      const res = await tfetch(SUPABASE_URL + '/auth/v1/user', {
        method: 'PUT',
        headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword })
      });
      let j = {};
      try { j = await res.json(); } catch (e) {}
      if (!res.ok) {
        const err = new Error(j.msg || j.message || j.error_description || ('HTTP ' + res.status));
        err.status = res.status;
        throw err;
      }
      return true;
    }
  };

  function anonHeaders() {
    return { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
  }
  function userHeaders(token) {
    return { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token };
  }

  // ====================================================================
  //  DATA CMS
  // ====================================================================
  let cache = null, cacheAt = 0;
  let serverUpdatedAt = null;   // versi baris di server (untuk cek konflik saat simpan)

  function cleanRemote(data) {
    // password admin lama TIDAK boleh ikut dibawa/di-cache di browser mana pun
    if (data && typeof data === 'object') { delete data.admins; }
    return data;
  }

  async function load(force) {
    if (!force && cache && Date.now() - cacheAt < 4000) return cache;
    const res = await tfetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.1&select=data,updated_at`, {
      headers: anonHeaders(),
      cache: 'no-store'
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
    const rows = await res.json();
    if (Array.isArray(rows) && rows[0] && rows[0].data && Object.keys(rows[0].data).length > 0) {
      cache = cleanRemote(rows[0].data);
      serverUpdatedAt = rows[0].updated_at || null;
      if (!cache.lastUpdated && rows[0].updated_at) {
        cache.lastUpdated = new Date(rows[0].updated_at).getTime();
      }
    } else {
      cache = null;
      serverUpdatedAt = (Array.isArray(rows) && rows[0]) ? (rows[0].updated_at || null) : null;
    }
    cacheAt = Date.now();
    return cache;
  }

  function readLocalCMS() {
    try { const v = JSON.parse(store.get(LS_CMS)); return (v && typeof v === 'object') ? v : null; } catch (e) { return null; }
  }

  // Dipakai semua halaman publik: ambil data terbaru dari cloud tanpa menimpa draft admin aktif
  async function pullIfNewer() {
    try {
      const remote = await load(true);
      if (!remote || Object.keys(remote).length === 0) return null;
      const local = readLocalCMS();
      const remoteTime = Number(remote.lastUpdated || 0);
      const localTime = Number((local && local.lastUpdated) || 0);
      const isAdminSession = auth.hasSession();
      if (!isAdminSession || !local || remoteTime >= localTime) {
        store.set(LS_CMS, JSON.stringify(remote));
        if (remoteTime) store.set('ohsnap_cloud_synced_at', String(remoteTime));
        return remote;
      }
      return local;
    } catch (e) {
      console.warn('[OhSnapCloud] gagal ambil data cloud:', e.message || e);
      return null;
    }
  }

  // Simpan ke cloud. Memakai cek versi: bila admin lain sudah mengubah data lebih dulu,
  // simpan ditolak dengan error status 409 (code 'conflict') kecuali opts.force = true.
  async function save(data, opts) {
    opts = opts || {};
    const token = await auth.getToken();
    if (!token) {
      const e = new Error('Sesi login habis, silakan login ulang');
      e.status = 401;
      throw e;
    }
    const payloadData = Object.assign({}, data, { lastUpdated: Date.now() });
    delete payloadData.admins;
    const headers = Object.assign({}, userHeaders(token), {
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    });
    const nowIso = new Date().toISOString();
    let res;
    if (serverUpdatedAt) {
      let url = `${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.1`;
      if (!opts.force) url += '&updated_at=eq.' + encodeURIComponent(serverUpdatedAt);
      res = await tfetch(url, { method: 'PATCH', headers, body: JSON.stringify({ data: payloadData, updated_at: nowIso }) });
    } else {
      // belum ada baris: buat baru (POST biasa, bukan upsert, agar tidak menimpa baris yang mungkin ada)
      res = await tfetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, { method: 'POST', headers, body: JSON.stringify({ id: 1, data: payloadData, updated_at: nowIso }) });
    }
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 160));
      err.status = res.status;
      if (res.status === 409) err.code = 'conflict';
      throw err;
    }
    let rows = [];
    try { rows = await res.json(); } catch (e) {}
    if (!Array.isArray(rows) || rows.length === 0) {
      // PATCH tidak mengenai baris mana pun => versi di server sudah berubah (atau izin ditolak)
      const err = new Error('Data di Cloud sudah diubah oleh admin lain');
      err.status = 409;
      err.code = 'conflict';
      throw err;
    }
    serverUpdatedAt = rows[0].updated_at || serverUpdatedAt;
    cache = payloadData;
    cacheAt = Date.now();
    return payloadData;
  }

  // Upload gambar/video ke Supabase Storage, hasilnya URL publik
  async function upload(fileOrBlob, folder, ext) {
    const token = await auth.getToken();
    if (!token) { const e = new Error('Sesi login habis, silakan login ulang'); e.status = 401; throw e; }
    const type = String(fileOrBlob.type || '');
    if (!/^(image|video)\//i.test(type)) throw new Error('Hanya file gambar atau video yang diizinkan');
    if (fileOrBlob.size > MAX_UPLOAD_BYTES) throw new Error('Ukuran file maksimal 50 MB');
    const cleanExt = (ext || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
    const cleanFolder = String(folder || 'misc').replace(/[^a-z0-9_-]/gi, '') || 'misc';
    const path = `${cleanFolder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${cleanExt}`;
    const res = await tfetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: Object.assign({}, userHeaders(token), { 'Content-Type': type, 'x-upsert': 'true' }),
      body: fileOrBlob
    }, UPLOAD_TIMEOUT);
    if (!res.ok) {
      const err = new Error('Upload HTTP ' + res.status + ': ' + (await res.text()).slice(0, 160));
      err.status = res.status;
      throw err;
    }
    return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  }

  // Hapus file lama di Storage. Mengembalikan true bila benar-benar terhapus.
  async function removeFile(publicUrl) {
    try {
      const marker = `/storage/v1/object/public/${BUCKET}/`;
      if (!publicUrl || typeof publicUrl !== 'string' || !publicUrl.includes(marker)) return false;
      const filePath = publicUrl.split(marker)[1];
      if (!filePath) return false;
      const token = await auth.getToken();
      if (!token) return false;
      const res = await tfetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${filePath}`, { method: 'DELETE', headers: userHeaders(token) });
      return res.ok;
    } catch (e) { return false; }
  }

  async function ping() {
    const t0 = performance.now();
    const res = await tfetch(`${SUPABASE_URL}/rest/v1/${TABLE}?select=id&limit=1`, { headers: anonHeaders(), cache: 'no-store' });
    return { status: res.status, ms: Math.round(performance.now() - t0) };
  }

  // ====================================================================
  //  GOOGLE APPS SCRIPT (resend softcopy)
  // ====================================================================
  // Mengirim JSON sebagai text/plain (request sederhana, tanpa preflight). Respons dicoba dibaca:
  //  - {ok:true}  : server menjawab sukses
  //  - {ok:false} : server menjawab gagal (HTTP error / JSON error)
  //  - {ok:null}  : terkirim tetapi jawaban tidak bisa dibaca (CORS) -> status tidak pasti
  async function postScript(url, payload) {
    let res;
    try {
      res = await tfetch(url, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'text/plain;charset=utf-8' } }, 20000);
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: null, reason: 'timeout' };
      // TypeError bisa berarti jaringan putus ATAU jawaban diblokir CORS; coba tebak lewat jalur no-cors
      try {
        await fetch(url, { method: 'POST', mode: 'no-cors', body: JSON.stringify(payload), headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
        return { ok: null, reason: 'opaque' };
      } catch (e2) {
        return { ok: false, reason: 'network' };
      }
    }
    if (!res.ok) return { ok: false, reason: 'http', status: res.status };
    let text = '';
    try { text = await res.text(); } catch (e) {}
    try {
      const j = JSON.parse(text);
      if (j && (j.status === 'error' || j.success === false || j.error)) return { ok: false, reason: 'server', message: j.message || j.error || '' };
      return { ok: true, data: j };
    } catch (e) {
      return { ok: null, reason: 'unreadable' };
    }
  }

  // ====================================================================
  //  UTIL: sanitasi, escape, URL aman
  // ====================================================================
  function escHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
  }

  // URL aman. kind: 'link' (http, https, mailto, tel) | 'img' (http, https, data:image raster) | 'media' (http, https)
  function safeUrl(u, kind) {
    if (u === null || u === undefined) return '';
    let s = String(u).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
    if (!s) return '';
    const probe = s.replace(/\s+/g, '');
    if (!/^[a-z][a-z0-9+.\-]*:/i.test(probe)) return s;   // relatif atau //host
    const proto = probe.slice(0, probe.indexOf(':') + 1).toLowerCase();
    if (proto === 'http:' || proto === 'https:') return s;
    if (kind === 'link' && (proto === 'mailto:' || proto === 'tel:')) return s;
    if (kind === 'img' && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(probe)) return s;
    return '';
  }

  function cssUrl(u) {
    const s = safeUrl(u, 'img');
    if (!s) return 'none';
    return 'url("' + s.replace(/["\\\n\r\f()']/g, c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')) + '")';
  }

  function colorOk(v) {
    return typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v.trim());
  }

  // HTML kaya terbatas untuk judul (hanya <span>, <br>, <b>, <strong>, <i>, <em> tanpa atribut)
  const RICH_ALLOWED = { SPAN: 1, BR: 1, B: 1, STRONG: 1, I: 1, EM: 1 };
  function sanitizeRichInto(el, html) {
    el.textContent = '';
    const doc = new DOMParser().parseFromString('<body>' + String(html == null ? '' : html) + '</body>', 'text/html');
    const frag = document.createDocumentFragment();
    (function walk(src, dst) {
      src.childNodes.forEach(n => {
        if (n.nodeType === 3) { dst.appendChild(document.createTextNode(n.nodeValue)); return; }
        if (n.nodeType !== 1) return;
        const tag = n.nodeName.toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IFRAME' || tag === 'OBJECT' || tag === 'EMBED' || tag === 'TEMPLATE') return;
        if (RICH_ALLOWED[tag]) {
          const c = document.createElement(tag.toLowerCase());
          walk(n, c);
          dst.appendChild(c);
        } else {
          walk(n, dst); // tag tak dikenal: buang tag-nya, simpan teksnya
        }
      });
    })(doc.body, frag);
    el.appendChild(frag);
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el && value !== undefined && value !== null) el.textContent = value;
    return el;
  }

  function applyColors(cms) {
    if (!cms || !cms.colors) return;
    const c = cms.colors, r = document.documentElement.style;
    r.setProperty('--primary', colorOk(c.primary) ? c.primary.trim() : '#ff1493');
    r.setProperty('--secondary', colorOk(c.secondary) ? c.secondary.trim() : '#2b4c7e');
    r.setProperty('--bg-main', colorOk(c.bg) ? c.bg.trim() : '#fff0f5');
    r.setProperty('--footer-bg', colorOk(c.footer) ? c.footer.trim() : '#18171d');
  }

  const FOOT_DEFAULT_TITLE = 'Find nearby OH SNAP! Studio';
  const FOOT_DEFAULT_DESC_EN = 'Find the nearest booth and studio in your city to capture your special moments today!';
  const FOOT_DEFAULT_DESC_ID = 'Temukan booth dan studio terdekat di kotamu untuk abadikan momen serumu hari ini!';

  function applyFooter(cms, lang) {
    if (!cms || !cms.footer) return;
    const f = cms.footer;
    setText('fBrand', f.brand);
    setText('fBranches', f.branches);
    const ig = setText('fIg', f.igName);
    if (ig) ig.href = safeUrl(f.igUrl, 'link') || '#';
    const tt = setText('fTt', f.ttName);
    if (tt) tt.href = safeUrl(f.ttUrl, 'link') || '#';
    const en = lang === 'en';
    setText('fCardTitle', en ? (f.cardTitleEn || FOOT_DEFAULT_TITLE) : (f.cardTitleId || FOOT_DEFAULT_TITLE));
    setText('fCardDesc', en ? (f.cardDescEn || FOOT_DEFAULT_DESC_EN) : (f.cardDescId || FOOT_DEFAULT_DESC_ID));
    setText('fCopy', f.copyright);
  }

  // ====================================================================
  //  UTIL: menu navigasi (hamburger) yang rapi untuk HP/tablet
  // ====================================================================
  function initNav() {
    const toggle = document.getElementById('menuToggle');
    const nav = document.getElementById('navContainer');
    if (!toggle || !nav) return;
    const header = document.querySelector('header');
    let overlay = document.getElementById('navOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'navOverlay';
      overlay.className = 'nav-overlay';
      document.body.appendChild(overlay);
    }
    toggle.setAttribute('aria-controls', 'navContainer');
    toggle.setAttribute('aria-expanded', 'false');
    if (!toggle.getAttribute('aria-label')) toggle.setAttribute('aria-label', 'Menu');
    function setOpen(open) {
      nav.classList.toggle('active', open);
      overlay.classList.toggle('active', open);
      if (header) header.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    toggle.addEventListener('click', () => setOpen(!nav.classList.contains('active')));
    overlay.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
    nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => setOpen(false)));
    window.addEventListener('resize', () => { if (window.innerWidth > 1100) setOpen(false); });
  }

  // ====================================================================
  //  UTIL: slider/carousel. alwaysShow=true => panah selalu tampil (perilaku lama beranda)
  // ====================================================================
  function initSlider(containerId, opts) {
    opts = opts || {};
    const c = document.getElementById(containerId);
    if (!c) return { update() {}, scroll() {} };
    const wrap = c.closest('.slider-wrapper');
    const btns = wrap ? Array.from(wrap.querySelectorAll('.slider-btn')) : [];
    function update() {
      const overflow = c.scrollWidth > c.clientWidth + 2;
      const minCount = Number(opts.minCountForArrows || 0);
      const show = opts.alwaysShow || overflow || (minCount && c.children.length > minCount);
      btns.forEach(b => { b.style.display = show ? 'flex' : 'none'; });
    }
    function scroll(dir) {
      const first = c.firstElementChild;
      let step = 260;
      if (first) {
        const gap = parseFloat(getComputedStyle(c).columnGap || getComputedStyle(c).gap) || 16;
        step = first.getBoundingClientRect().width + gap;
      }
      c.scrollBy({ left: step * dir, behavior: 'smooth' });
    }
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(update);
      ro.observe(c);
    }
    window.addEventListener('resize', update);
    window.addEventListener('load', update);
    update();
    return { update, scroll };
  }

  // ====================================================================
  //  UTIL: kerangka halaman publik (bahasa, render, sinkron cloud)
  //  render(cms, lang) dipanggil tiap data/bahasa berubah. cms bisa null (pakai default halaman).
  // ====================================================================
  function createPage(render, opts) {
    opts = opts || {};
    let lang = store.get('siteLang');
    if (lang !== 'en' && lang !== 'id') lang = 'id';
    let cms = readLocalCMS();
    let sig = '';
    let lastSyncAt = 0;
    const root = document.documentElement;

    function setLangButtons() {
      const en = document.getElementById('btnEN'), id = document.getElementById('btnID');
      if (en) { en.classList.toggle('active', lang === 'en'); en.setAttribute('aria-pressed', lang === 'en' ? 'true' : 'false'); }
      if (id) { id.classList.toggle('active', lang === 'id'); id.setAttribute('aria-pressed', lang === 'id' ? 'true' : 'false'); }
    }
    function signature(c) { try { return JSON.stringify(c) + '_' + lang; } catch (e) { return String(Date.now()); } }

    function draw() {
      root.lang = lang;
      setLangButtons();
      // teks statis dari HTML sendiri (aman), mis. menu & label
      document.querySelectorAll('[data-en]').forEach(el => {
        const t = el.getAttribute('data-' + lang);
        if (t !== null) el.innerHTML = t;
      });
      applyColors(cms);
      try { render(cms, lang); } catch (e) { console.error('[render]', e); }
      applyFooter(cms, lang);
      sig = signature(cms);
    }

    function reveal() { root.classList.remove('awaiting-first-cloud'); }

    async function sync(force) {
      const now = Date.now();
      if (!force && now - lastSyncAt < 10000) return;
      lastSyncAt = now;
      const remote = await pullIfNewer();
      if (remote && signature(remote) !== sig) { cms = remote; draw(); }
      reveal();
    }

    window.setLanguage = function (l) {
      lang = (l === 'en') ? 'en' : 'id';
      store.set('siteLang', lang);
      draw();
    };

    initNav();
    draw();
    // kunjungan pertama (belum ada cache): tahan tampil sebentar agar tidak berkedip/menampilkan data bawaan
    if (root.classList.contains('awaiting-first-cloud')) setTimeout(reveal, opts.revealAfter || 2000);
    window.addEventListener('storage', e => { if (!e.key || e.key === LS_CMS) sync(true); });
    window.addEventListener('focus', () => sync(false));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(false); });
    sync(true);
    return { redraw: draw, getLang: () => lang, getCMS: () => cms };
  }

  window.OhSnapCloud = {
    load, pullIfNewer, save, upload, removeFile, ping, URL: SUPABASE_URL,
    auth, postScript,
    store, sstore,
    util: { escHtml, safeUrl, cssUrl, colorOk, sanitizeRichInto, setText, applyColors, applyFooter, initNav, initSlider, createPage, readLocalCMS, tfetch }
  };
})();
