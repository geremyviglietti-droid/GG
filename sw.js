/* ================================================================
   SERVICE WORKER — Adhésion CRM PWA  v2
   Stratégie robuste offline-first
   ================================================================ */

const CACHE_NAME = 'adhesion-crm-v4';
const SYNC_TAG   = 'sync-adhesions';

const LOCAL_ASSETS = [
  'index.html',
  'dashboard.html',
  'admin.html',
  'register.html',
  'manifest.json',
  'pwa.js',
  'libs/react.min.js',
  'libs/react-dom.min.js',
  'libs/babel.min.js',
  'libs/fonts.css',
];

const CDN_ASSETS = []; // Libs maintenant locales dans /libs/

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Hors-ligne</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0f0e1a;font-family:system-ui,sans-serif;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:24px;padding:48px 40px;text-align:center;max-width:400px;width:100%}.icon{font-size:56px;margin-bottom:24px;display:block}h1{font-size:24px;font-weight:700;margin-bottom:12px}p{color:rgba(255,255,255,.5);font-size:15px;line-height:1.6;margin-bottom:28px}.links{display:flex;flex-direction:column;gap:10px}a{background:linear-gradient(135deg,#4c1d95,#6d28d9);color:#fff;text-decoration:none;padding:14px 24px;border-radius:12px;font-weight:700;font-size:14px}.note{margin-top:20px;font-size:12px;color:rgba(255,255,255,.3);line-height:1.6}@keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#ef4444;margin-right:6px;animation:pulse 1.4s infinite}</style>
</head><body><div class="card"><span class="icon">📵</span><h1>Vous êtes hors-ligne</h1><p><span class="dot"></span>Cette page n'est pas disponible sans connexion.<br>Vérifiez votre connexion internet puis réessayez.</p><div class="links"><a href="/index.html">📋 Formulaire d'adhésion</a><a href="/dashboard.html">📊 Tableau de bord</a></div><p class="note">Les pages déjà visitées sont disponibles hors-ligne.<br>Vos dossiers en attente seront synchronisés au retour de la connexion.</p></div><script>window.addEventListener('online',()=>window.location.reload());</script></body></html>`;

// ── INSTALL ──────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Toujours stocker la page offline inline
    await cache.put('offline.html', new Response(OFFLINE_HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    }));

    // Assets locaux
    await Promise.allSettled(LOCAL_ASSETS.map(url =>
      fetch(url).then(r => { if (r.ok) return cache.put(url, r); }).catch(() => {})
    ));

    // CDN avec no-cors (réponses opaques — OK pour offline)
    await Promise.allSettled(CDN_ASSETS.map(url =>
      fetch(new Request(url, { mode: 'no-cors' })).then(r => {
        if (r.status === 0 || r.ok) return cache.put(url, r);
      }).catch(() => {})
    ));

    await self.skipWaiting();
  })());
});

// ── ACTIVATE ─────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ── FETCH ─────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  // Supabase GET → network-first
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // CDN → cache-first strict (jamais de rechargement inutile)
  if (
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Local → stale-while-revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
});

// ── STRATÉGIES ───────────────────────────────────────────────────────

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const r = await fetch(new Request(req.url, { mode: 'no-cors' }));
    if (r.status === 0 || r.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req.url, r.clone());
    }
    return r;
  } catch {
    return offline(req);
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);

  const fetchPromise = fetch(req).then(r => {
    if (r.ok) cache.put(req, r.clone());
    return r;
  }).catch(() => null);

  return cached || (await fetchPromise) || offline(req);
}

async function networkFirst(req) {
  try {
    const r = await fetch(req);
    if (r.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, r.clone());
    }
    return r;
  } catch {
    return (await caches.match(req)) || offline(req);
  }
}

async function offline(req) {
  if (req.mode === 'navigate') {
    return (await caches.match('offline.html')) || new Response('<h1>Hors-ligne</h1>', { headers: { 'Content-Type': 'text/html' } });
  }
  return new Response('/* offline */', { status: 503, headers: { 'Content-Type': 'application/javascript' } });
}

// ── BACKGROUND SYNC ───────────────────────────────────────────────────
self.addEventListener('sync', (e) => {
  if (e.tag === SYNC_TAG) e.waitUntil(processQueue());
});
self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'periodic-sync-adhesions') e.waitUntil(processQueue());
});

async function processQueue() {
  const db = await openDB();
  const items = await getAll(db, 'syncQueue');
  if (!items.length) return;

  const results = await Promise.allSettled(items.map(item => pushToSupabase(item)));

  let synced = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      await del(db, 'syncQueue', items[i].localId);
      notify({ type: 'SYNC_SUCCESS', localId: items[i].localId });
      synced++;
    }
  }
  if (synced > 0) notify({ type: 'ALL_SYNCED', count: synced });
}

async function pushToSupabase({ table, data, supabaseUrl, supabaseKey }) {
  const r = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function notify(msg) {
  self.clients.matchAll().then(cs => cs.forEach(c => c.postMessage(msg)));
}

// ── MESSAGES ─────────────────────────────────────────────────────────
self.addEventListener('message', async (event) => {
  const { type, payload } = event.data;

  if (type === 'QUEUE_SUBMISSION') {
    const db = await openDB();
    await put(db, 'syncQueue', {
      ...payload,
      localId: payload.localId || Date.now().toString(),
      queuedAt: new Date().toISOString()
    });
    try { await processQueue(); } catch {}
  }

  if (type === 'GET_QUEUE_COUNT') {
    const db = await openDB();
    const items = await getAll(db, 'syncQueue');
    event.source.postMessage({ type: 'QUEUE_COUNT', count: items.length });
  }

  if (type === 'SKIP_WAITING') self.skipWaiting();

  if (type === 'RECACHE_CDN') {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(CDN_ASSETS.map(url =>
      fetch(new Request(url, { mode: 'no-cors' }))
        .then(r => { if (r.status === 0 || r.ok) return cache.put(url, r); })
        .catch(() => {})
    ));
    notify({ type: 'CDN_CACHED' });
  }
});

// ── INDEXEDDB ─────────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('adhesion-crm-db', 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('syncQueue'))
        db.createObjectStore('syncQueue', { keyPath: 'localId' }).createIndex('queuedAt', 'queuedAt');
      if (!db.objectStoreNames.contains('cachedData'))
        db.createObjectStore('cachedData', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function getAll(db, store) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}
function put(db, store, data) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(data);
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
}
function del(db, store, key) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
}
