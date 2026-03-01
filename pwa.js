/* ================================================================
   pwa.js — À inclure dans chaque page HTML
   Gère :
   - Enregistrement du Service Worker
   - Bannière d'installation (Add to Home Screen)
   - Détection hors-ligne / en-ligne
   - Interception des soumissions Supabase pour la sync queue
   - Toast de statut connexion
   ================================================================ */

(function () {
  'use strict';

  // ── CONFIG (sera surchargée par chaque page si besoin) ──────────────
  window.PWA = window.PWA || {};

  // ── SERVICE WORKER ──────────────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .then(reg => {
          window.PWA.swRegistration = reg;

          // Écouter les mises à jour disponibles
          // Déclencher le cache CDN dès que le SW est actif
          if (navigator.onLine) {
            navigator.serviceWorker.ready.then(reg => {
              if (reg.active) reg.active.postMessage({ type: 'RECACHE_CDN' });
            });
          }

          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                showToast('🔄 Mise à jour disponible — Rechargez la page', 'info', 6000);
              }
            });
          });
        })
        .catch(err => console.warn('[PWA] SW registration failed:', err));

      // Écouter les messages du SW
      navigator.serviceWorker.addEventListener('message', (event) => {
        const { type, count, localId } = event.data;

        if (type === 'SYNC_SUCCESS') {
          showToast('✅ Dossier synchronisé avec succès', 'success');
          window.dispatchEvent(new CustomEvent('pwa:sync-success', { detail: { localId } }));
        }
        if (type === 'ALL_SYNCED') {
          showToast(`✅ ${count} dossier${count > 1 ? 's' : ''} synchronisé${count > 1 ? 's' : ''}`, 'success');
          updateQueueBadge(0);
        }
        if (type === 'QUEUE_COUNT') {
          updateQueueBadge(event.data.count);
        }
      });
    });
  }

  // ── OFFLINE / ONLINE DETECTION ──────────────────────────────────────
  function handleOnline() {
    hideOfflineBanner();
    showToast('📶 Connexion rétablie — Synchronisation...', 'success');
    triggerBackgroundSync();
    // Re-cacher les assets CDN maintenant qu'on est en ligne
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'RECACHE_CDN' });
    }
  }

  function handleOffline() {
    showOfflineBanner();
    showToast('📵 Mode hors-ligne — Vos dossiers seront envoyés dès le retour de la connexion', 'warning', 5000);
  }

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);

  // Vérifier l'état au chargement
  if (!navigator.onLine) {
    window.addEventListener('DOMContentLoaded', () => setTimeout(showOfflineBanner, 500));
  }

  // ── BACKGROUND SYNC ─────────────────────────────────────────────────
  function triggerBackgroundSync() {
    if (window.PWA.swRegistration && 'sync' in window.PWA.swRegistration) {
      window.PWA.swRegistration.sync.register('sync-adhesions').catch(() => {});
    }
    // Fallback : demander au SW de traiter la queue via message
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'GET_QUEUE_COUNT' });
    }
  }

  // ── ENQUEUE SOUMISSION (à appeler à la place de fetch POST Supabase) ─
  window.PWA.queueOrSubmit = async function({ table, data, supabaseUrl, supabaseKey }) {
    const localId = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const payload = { localId, table, data, supabaseUrl, supabaseKey };

    if (navigator.onLine) {
      // Essayer directement
      try {
        const res = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Prefer': 'return=representation'
          },
          body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error(await res.text());
        return { success: true, online: true, result: await res.json() };
      } catch (err) {
        // Réseau dispo mais erreur → mettre en queue quand même
        console.warn('[PWA] Submission failed, queuing:', err);
      }
    }

    // Hors-ligne ou erreur : mettre en queue via IndexedDB
    await enqueueViaIDB(payload);
    // Notifier le SW
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'QUEUE_SUBMISSION',
        payload
      });
    }
    // Mettre à jour le badge
    const count = await getQueueCount();
    updateQueueBadge(count);
    return { success: true, online: false, queued: true, localId };
  };

  // ── INDEXEDDB direct (fallback si SW pas encore actif) ──────────────
  function openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('adhesion-crm-db', 2);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('syncQueue')) {
          db.createObjectStore('syncQueue', { keyPath: 'localId' });
        }
        if (!db.objectStoreNames.contains('cachedData')) {
          db.createObjectStore('cachedData', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function enqueueViaIDB(payload) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('syncQueue', 'readwrite');
      const req = tx.objectStore('syncQueue').put({ ...payload, queuedAt: new Date().toISOString() });
      req.onsuccess = resolve;
      req.onerror = reject;
    });
  }

  async function getQueueCount() {
    try {
      const db = await openIDB();
      return new Promise((resolve) => {
        const tx = db.transaction('syncQueue', 'readonly');
        const req = tx.objectStore('syncQueue').count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(0);
      });
    } catch { return 0; }
  }

  // ── SAUVEGARDE LOCALE des dossiers (copie lisible) ──────────────────
  window.PWA.saveLocalDraft = async function(formData) {
    try {
      const db = await openIDB();
      const tx = db.transaction('cachedData', 'readwrite');
      tx.objectStore('cachedData').put({
        key: 'draft_' + Date.now(),
        data: formData,
        savedAt: new Date().toISOString()
      });
    } catch (e) {}
  };

  window.PWA.getLocalDrafts = async function() {
    try {
      const db = await openIDB();
      return new Promise((resolve) => {
        const tx = db.transaction('cachedData', 'readonly');
        const req = tx.objectStore('cachedData').getAll();
        req.onsuccess = () => resolve((req.result || []).filter(r => r.key.startsWith('draft_')));
        req.onerror = () => resolve([]);
      });
    } catch { return []; }
  };

  // ── INSTALL PROMPT (Add to Home Screen) ─────────────────────────────
  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    // Afficher la bannière d'installation après 3 secondes
    setTimeout(showInstallBanner, 3000);
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideInstallBanner();
    showToast('🎉 Application installée !', 'success');
  });

  window.PWA.install = async function() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      showToast('📲 Installation en cours...', 'info');
    }
    deferredPrompt = null;
    hideInstallBanner();
  };

  // ── UI : BANNIÈRE HORS-LIGNE ─────────────────────────────────────────
  function showOfflineBanner() {
    if (document.getElementById('pwa-offline-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'pwa-offline-banner';
    banner.innerHTML = `
      <div style="
        position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
        background: linear-gradient(90deg, #92400e, #b45309);
        color: white; padding: 10px 20px;
        display: flex; align-items: center; justify-content: center; gap: 10px;
        font-family: 'DM Sans', sans-serif; font-size: 13px; font-weight: 600;
        box-shadow: 0 2px 12px rgba(0,0,0,0.3);
        animation: slideDown 0.3s ease;
      ">
        <span style="font-size:16px">📵</span>
        <span>Mode hors-ligne — Les dossiers seront synchronisés au retour de la connexion</span>
        <span id="pwa-queue-badge" style="
          background: rgba(255,255,255,0.2); border-radius: 12px;
          padding: 2px 10px; font-size: 11px; display: none;
        "></span>
      </div>
    `;
    document.body.insertBefore(banner, document.body.firstChild);
    // Ajuster le body pour éviter le chevauchement
    document.body.style.paddingTop = (parseInt(document.body.style.paddingTop || '0') + 44) + 'px';
  }

  function hideOfflineBanner() {
    const banner = document.getElementById('pwa-offline-banner');
    if (banner) {
      banner.remove();
      document.body.style.paddingTop = '';
    }
  }

  function updateQueueBadge(count) {
    const badge = document.getElementById('pwa-queue-badge');
    if (!badge) return;
    if (count > 0) {
      badge.style.display = 'inline';
      badge.textContent = `${count} en attente`;
    } else {
      badge.style.display = 'none';
    }
  }

  // ── UI : BANNIÈRE D'INSTALLATION ─────────────────────────────────────
  function showInstallBanner() {
    // Ne pas montrer si déjà installé ou si bannière déjà là
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    if (document.getElementById('pwa-install-banner')) return;
    if (!deferredPrompt) {
      // iOS : afficher instructions manuelles
      showIOSInstallBanner();
      return;
    }

    const banner = document.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.innerHTML = `
      <div style="
        position: fixed; bottom: 70px; left: 16px; right: 16px; z-index: 9998;
        background: linear-gradient(135deg, #1e1b4b, #3b0764);
        border: 1px solid rgba(167,139,250,0.3);
        border-radius: 18px; padding: 16px 18px;
        display: flex; align-items: center; gap: 14px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        font-family: 'DM Sans', sans-serif;
        animation: slideUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
      ">
        <div style="
          width: 48px; height: 48px; border-radius: 12px; flex-shrink: 0;
          background: linear-gradient(135deg, #4c1d95, #6d28d9);
          display: flex; align-items: center; justify-content: center;
          font-size: 24px;
        ">📋</div>
        <div style="flex: 1; min-width: 0;">
          <div style="color: white; font-size: 14px; font-weight: 700; margin-bottom: 2px;">Installer l'application</div>
          <div style="color: rgba(255,255,255,0.55); font-size: 12px;">Accès hors-ligne · Synchronisation auto</div>
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px; flex-shrink: 0;">
          <button onclick="window.PWA.install()" style="
            background: linear-gradient(135deg, #6d28d9, #7c3aed);
            color: white; border: none; border-radius: 10px;
            padding: 8px 16px; font-size: 13px; font-weight: 700;
            cursor: pointer; font-family: 'DM Sans', sans-serif;
            white-space: nowrap;
          ">Installer</button>
          <button onclick="document.getElementById('pwa-install-banner').remove()" style="
            background: transparent; color: rgba(255,255,255,0.4);
            border: none; font-size: 12px; cursor: pointer;
            font-family: 'DM Sans', sans-serif; padding: 4px;
          ">Plus tard</button>
        </div>
      </div>
    `;
    document.body.appendChild(banner);
  }

  function showIOSInstallBanner() {
    // Vérifier si c'est iOS et pas déjà installé
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (!isIOS) return;

    const banner = document.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.innerHTML = `
      <div style="
        position: fixed; bottom: 0; left: 0; right: 0; z-index: 9998;
        background: rgba(30, 27, 75, 0.98);
        border-top: 1px solid rgba(167,139,250,0.3);
        padding: 16px 20px 28px;
        font-family: 'DM Sans', sans-serif;
        backdrop-filter: blur(20px);
        animation: slideUp 0.4s ease;
      ">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
          <div style="color: white; font-size: 15px; font-weight: 700;">📲 Installer sur votre iPhone</div>
          <button onclick="document.getElementById('pwa-install-banner').remove()" style="
            background: rgba(255,255,255,0.1); border: none; color: rgba(255,255,255,0.6);
            border-radius: 50%; width: 28px; height: 28px; font-size: 16px;
            cursor: pointer; display: flex; align-items: center; justify-content: center;
          ">×</button>
        </div>
        <div style="color: rgba(255,255,255,0.65); font-size: 13px; line-height: 1.7;">
          1. Appuyez sur <span style="color: #a78bfa; font-weight: 600;">Partager</span> <span style="font-size:16px">⬆️</span> en bas de Safari<br>
          2. Faites défiler et appuyez sur <span style="color: #a78bfa; font-weight: 600;">« Sur l'écran d'accueil »</span> <span style="font-size:16px">➕</span><br>
          3. Confirmez avec <span style="color: #a78bfa; font-weight: 600;">Ajouter</span>
        </div>
      </div>
    `;
    document.body.appendChild(banner);
    setTimeout(() => { const b = document.getElementById('pwa-install-banner'); if (b) b.remove(); }, 15000);
  }

  function hideInstallBanner() {
    const banner = document.getElementById('pwa-install-banner');
    if (banner) banner.remove();
  }

  // ── UI : TOAST ────────────────────────────────────────────────────────
  function showToast(message, type = 'info', duration = 3500) {
    const colors = {
      success: { bg: 'linear-gradient(135deg,#064e3b,#065f46)', border: 'rgba(52,211,153,0.3)', icon: '✅' },
      warning: { bg: 'linear-gradient(135deg,#78350f,#92400e)', border: 'rgba(251,191,36,0.3)', icon: '⚠️' },
      info:    { bg: 'linear-gradient(135deg,#1e1b4b,#312e81)', border: 'rgba(167,139,250,0.3)', icon: 'ℹ️' },
      error:   { bg: 'linear-gradient(135deg,#7f1d1d,#991b1b)', border: 'rgba(248,113,113,0.3)', icon: '❌' },
    };
    const style = colors[type] || colors.info;

    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed; top: 60px; right: 16px; z-index: 10000;
      background: ${style.bg};
      border: 1px solid ${style.border};
      border-radius: 14px; padding: 14px 18px;
      display: flex; align-items: center; gap: 10px;
      max-width: 340px; min-width: 200px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      font-family: 'DM Sans', sans-serif; font-size: 13px;
      color: white; font-weight: 500; line-height: 1.4;
      animation: slideInRight 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
      transition: opacity 0.3s ease;
    `;
    toast.innerHTML = `<span style="font-size:16px;flex-shrink:0">${style.icon}</span><span>${message}</span>`;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  window.PWA.showToast = showToast;

  // ── INJECT ANIMATIONS CSS ─────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideDown { from { transform: translateY(-100%); opacity:0; } to { transform: translateY(0); opacity:1; } }
    @keyframes slideUp { from { transform: translateY(100%); opacity:0; } to { transform: translateY(0); opacity:1; } }
    @keyframes slideInRight { from { transform: translateX(120%); opacity:0; } to { transform: translateX(0); opacity:1; } }
  `;
  document.head.appendChild(style);

  // ── INITIALISATION ─────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', async () => {
    // Afficher le count de la queue si hors-ligne
    if (!navigator.onLine) {
      const count = await getQueueCount();
      if (count > 0) {
        showOfflineBanner();
        setTimeout(() => updateQueueBadge(count), 100);
      }
    }
  });

})();
