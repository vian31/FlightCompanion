/* =====================================================================
   Vian32 — Aviation · service worker

   Stratégie : réseau d'abord, cache de secours.
     - dès qu'il y a du réseau, la page vient du serveur : pas de vieille
       version figée comme avec l'ancien cache-first ;
     - sans réseau (en vol), la dernière version chargée est resservie ;
     - au bout de NET_TIMEOUT, on n'attend plus le réseau et on sert le
       cache : une liaison qui accepte la connexion sans répondre ne doit
       pas laisser l'écran blanc.

   Seul l'origine du site est interceptée. Les appels météo (avwx.rest)
   passent directement au réseau et ne sont jamais mis en cache : une
   observation périmée servie depuis un cache serait dangereuse.
   ===================================================================== */

const CACHE = 'aviation-shell';
const PAGE = './index.html';
const NET_TIMEOUT = 6000;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.add(new Request(PAGE, { cache: 'reload' })))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Purge les caches des versions précédentes (dont « aviation-v1 »).
    const noms = await caches.keys();
    await Promise.all(noms.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Un rechargement demandé depuis la page force la reprise immédiate.
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

// estPage : on redemande le document au serveur sans passer par le cache
// HTTP du navigateur, sinon une copie encore « fraîche » à ses yeux masque
// la version qui vient d'être publiée.
function reseauAvecDelai(request, estPage) {
  const ctl = new AbortController();
  const minuteur = setTimeout(() => ctl.abort(), NET_TIMEOUT);
  const p = estPage
    ? fetch(request.url, { cache: 'no-store', credentials: 'same-origin', signal: ctl.signal })
    : fetch(request, { signal: ctl.signal });
  return p.finally(() => clearTimeout(minuteur));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;   // météo & co : non interceptés

  // Toutes les navigations partagent une seule entrée de cache : la page
  // rechargée avec « ?maj=… » retrouve donc bien le secours hors ligne.
  const estPage = req.mode === 'navigate' || req.destination === 'document';
  const cle = estPage ? PAGE : req;

  e.respondWith((async () => {
    try {
      const res = await reseauAvecDelai(req, estPage);
      if (res && res.ok) {
        const copie = res.clone();
        caches.open(CACHE).then((c) => c.put(cle, copie)).catch(() => {});
      }
      return res;
    } catch (err) {
      const c = await caches.open(CACHE);
      const secours = (await c.match(cle)) || (estPage ? await c.match(PAGE) : null);
      if (secours) return secours;
      throw err;
    }
  })());
});
