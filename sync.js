/* =====================================================================
   SYNC — carnet « Mes derniers vols » partagé entre appareils via un
   gist GitHub secret. Ne synchronise que les clés du registre SYNCED ;
   réglages, checklist, rappels, HDV en cours et jeton AVWX restent
   locaux à chaque appareil (délibéré : voir CLAUDE.md).

   Si le stockage local est refusé (HAS_LS faux), toute la fonction est
   désactivée : le repli cookie renverrait le jeton GitHub au serveur à
   chaque requête.
   ===================================================================== */
if (HAS_LS) (function () {

  const CFG_KEY = 'sync-config';
  STORE_KEYS.push(CFG_KEY);

  const MAX = 5; // même plafond que FLIGHTS

  /* ---- Fusion des vols : union par clé de tri, arbitrée par id ---- */
  const cleSort = f => String((f && f.sort) || '');
  const stamp = f => Number(String((f && f.id) || '').replace(/\D/g, '')) || 0;

  function mergeFlights(a, b) {
    const m = new Map();
    a.concat(b).forEach(f => {
      if (!f || !cleSort(f)) return;
      const vu = m.get(cleSort(f));
      if (!vu || stamp(f) > stamp(vu)) m.set(cleSort(f), f);
    });
    return Array.from(m.values())
      .sort((x, y) => cleSort(y).localeCompare(cleSort(x)))
      .slice(0, MAX);
  }

  /* ---- Registre des clés synchronisées ----
     aerodromes.json (régénéré par une Action GitHub sur le cycle AIRAC)
     n'y figure pas : il est identique sur tous les appareils par
     construction. */
  const SYNCED = [
    { key: 'hdv-flights', file: 'flights.json', merge: mergeFlights, refresh: () => { if (typeof FLIGHTS !== 'undefined') FLIGHTS.render(); } }
  ];

  /* ---- Config locale (jamais synchronisée) ---- */
  function getConfig() {
    const raw = load(CFG_KEY);
    if (!raw) return { token: '', gistId: '', last: 0 };
    try {
      const c = JSON.parse(raw);
      return { token: c.token || '', gistId: c.gistId || '', last: c.last || 0 };
    } catch (e) { return { token: '', gistId: '', last: 0 }; }
  }
  let selfWriting = false;
  function saveConfig(cfg) { store(CFG_KEY, JSON.stringify(cfg)); }

  /* ---- Enveloppe de `store` : une écriture sur une clé synchronisée
     programme un envoi différé, sauf quand c'est la synchro elle-même
     qui écrit (drapeau selfWriting). ---- */
  const baseStore = store;
  store = function (key, value) {
    baseStore(key, value);
    if (selfWriting) return;
    if (SYNCED.some(e => e.key === key)) scheduleDeferredSync();
  };
  function writeLocal(key, value) {
    selfWriting = true;
    try { store(key, value); } finally { selfWriting = false; }
  }

  let deferredTimer = null;
  function scheduleDeferredSync() {
    clearTimeout(deferredTimer);
    deferredTimer = setTimeout(() => runSync(false), 4000);
  }

  /* ---- Appels GitHub ---- */
  function ghFetch(url, opts, token) {
    const headers = Object.assign({
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }, (opts && opts.headers) || {});
    return fetch(url, Object.assign({}, opts, { headers }));
  }

  function ghError(status) {
    if (status === 401) return new Error('Jeton refusé (401) : vérifie le jeton dans les réglages.');
    if (status === 403) return new Error('Permission Gists manquante (403) : le jeton doit autoriser les Gists en lecture/écriture.');
    if (status === 404) return new Error('Gist introuvable (404) : il a peut-être été supprimé.');
    return new Error('Erreur réseau GitHub (' + status + ').');
  }

  async function resolveGistId(token) {
    const res = await ghFetch('https://api.github.com/gists?per_page=100', {}, token);
    if (!res.ok) throw ghError(res.status);
    const list = await res.json();
    const noms = SYNCED.map(e => e.file);
    for (const g of list) {
      if (g.files && noms.some(n => g.files[n])) return g.id;
    }
    return '';
  }

  async function fetchGist(id, token) {
    const res = await ghFetch('https://api.github.com/gists/' + id, {}, token);
    if (!res.ok) throw ghError(res.status);
    return res.json();
  }

  async function fetchRaw(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Erreur réseau GitHub (' + res.status + ').');
    return res.text();
  }

  async function patchGist(id, files, token) {
    const res = await ghFetch('https://api.github.com/gists/' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: files })
    }, token);
    if (!res.ok) throw ghError(res.status);
    return res.json();
  }

  async function createGist(files, token) {
    const res = await ghFetch('https://api.github.com/gists', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'Flight Companion — sync', public: false, files: files })
    }, token);
    if (!res.ok) throw ghError(res.status);
    const g = await res.json();
    return g.id;
  }

  /* ---- Cycle de synchro ---- */
  function parseArr(raw) {
    if (!raw) return [];
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  const sameArr = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  let syncing = false;

  async function runSync(manual) {
    const cfg = getConfig();
    if (!cfg.token) { if (manual) setStatus('Ajoute un jeton GitHub pour synchroniser.', true); return; }
    if (syncing) return;
    syncing = true;
    setStatus('Synchronisation…');
    try {
      let gistId = cfg.gistId;
      let remoteFiles = {};
      if (!gistId) gistId = await resolveGistId(cfg.token);
      if (gistId) {
        const gist = await fetchGist(gistId, cfg.token);
        remoteFiles = gist.files || {};
      }

      const toWriteRemote = {};
      for (const entry of SYNCED) {
        const localArr = parseArr(load(entry.key));
        let remoteArr = [];
        const rf = remoteFiles[entry.file];
        if (rf) {
          const content = rf.truncated ? await fetchRaw(rf.raw_url) : rf.content;
          remoteArr = parseArr(content);
        }
        const merged = entry.merge(localArr, remoteArr);
        if (!sameArr(merged, localArr)) {
          writeLocal(entry.key, JSON.stringify(merged));
          if (entry.refresh) entry.refresh();
        }
        if (!sameArr(merged, remoteArr)) {
          toWriteRemote[entry.file] = { content: JSON.stringify(merged, null, 2) };
        }
      }

      if (Object.keys(toWriteRemote).length) {
        if (gistId) await patchGist(gistId, toWriteRemote, cfg.token);
        else gistId = await createGist(toWriteRemote, cfg.token);
      }

      cfg.gistId = gistId;
      cfg.last = Date.now();
      saveConfig(cfg);
      setStatus(fmtLast(cfg.last));
    } catch (e) {
      setStatus((e && e.message) || 'Erreur de synchronisation.', true);
    } finally {
      syncing = false;
    }
  }

  /* ---- Réglages : bloc « Synchronisation des vols » ---- */
  function fmtLast(ts) {
    if (!ts) return 'Jamais synchronisé.';
    const d = new Date(ts);
    return 'Dernière synchro : ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function setStatus(text, isError) {
    const el = document.getElementById('syncStatus');
    if (!el) return;
    el.textContent = (isError ? 'Erreur — ' : '') + text;
  }

  function injectSettings() {
    const labels = document.querySelectorAll('.modal-pane[data-mpane="settings"] .setting-label');
    let appBlock = null;
    labels.forEach(l => { if (l.textContent.trim() === 'Application') appBlock = l.closest('.setting'); });
    if (!appBlock) return;

    const cfg = getConfig();
    const block = document.createElement('div');
    block.className = 'setting';
    block.innerHTML =
      '<div class="setting-label">Synchronisation des vols</div>' +
      '<input type="password" id="syncToken" placeholder="Jeton GitHub (Gists)" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
        'style="width:100%;box-sizing:border-box;font-size:16px;font-family:inherit;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:var(--paper);color:var(--ink);outline:none;margin-bottom:10px;">' +
      '<div style="display:flex;gap:8px;">' +
        '<button class="btn-update" id="syncNow" style="flex:1;">Synchroniser maintenant</button>' +
      '</div>' +
      '<button class="btn-update" id="syncUnlink" style="margin-top:8px;background:transparent;border-color:var(--muted);color:var(--muted);">Délier cet appareil</button>' +
      '<div class="setting-hint" id="syncStatus"></div>';
    appBlock.parentNode.insertBefore(block, appBlock);

    const tokenEl = block.querySelector('#syncToken');
    tokenEl.value = cfg.token;
    let tokenTimer = null;
    tokenEl.addEventListener('input', () => {
      clearTimeout(tokenTimer);
      tokenTimer = setTimeout(() => {
        const c = getConfig();
        c.token = tokenEl.value.trim();
        saveConfig(c);
        if (c.token) runSync(false);
      }, 600);
    });

    block.querySelector('#syncNow').addEventListener('click', () => runSync(true));
    block.querySelector('#syncUnlink').addEventListener('click', () => {
      drop(CFG_KEY);
      tokenEl.value = '';
      setStatus('Appareil délié. Le carnet local et le gist ne sont pas modifiés.');
    });

    setStatus(cfg.token ? fmtLast(cfg.last) : 'Aucun jeton configuré.');
  }

  function injectHelp() {
    const pane = document.querySelector('.modal-pane[data-mpane="help"]');
    if (!pane) return;
    const sub = document.createElement('div');
    sub.className = 'help-sub';
    sub.textContent = 'Synchronisation des vols';
    const ul = document.createElement('ul');
    ul.className = 'help-list';
    ul.innerHTML =
      '<li>Seul le carnet « Mes derniers vols » est partagé entre appareils ; réglages, checklist, rappels et jeton restent propres à chacun.</li>' +
      '<li>Le jeton se crée sur GitHub → Settings → Developer settings → Personal access tokens → Fine-grained, avec la seule permission de compte « Gists » en lecture/écriture. Il est révocable à tout moment depuis GitHub.</li>' +
      '<li>La synchro se déclenche à l\'ouverture de l\'app, au retour au premier plan, au retour du réseau, et quelques secondes après la clôture d\'un vol. Le bouton « Synchroniser maintenant » la force.</li>' +
      '<li>« Délier cet appareil » efface le jeton et l\'identifiant du gist sur ce téléphone ou cette tablette, sans toucher au carnet local ni au gist.</li>' +
      '<li>Le plafond de 5 vols s\'applique après fusion : si 5 vols sont clôturés sur un appareil sans synchroniser entre-temps, les plus anciens du gist sortent définitivement. Avec une synchro à chaque ouverture, le cas ne se présente pas.</li>';
    pane.appendChild(sub);
    pane.appendChild(ul);
  }

  injectSettings();
  injectHelp();

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') runSync(false); });
  window.addEventListener('online', () => runSync(false));
  runSync(false);

})();
