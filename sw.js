/* ================================================================
   Bobine — Service Worker
   Stratégie :
   - index.html (app shell) → network-first : la dernière version publiée
     est toujours utilisée quand il y a du réseau ; le cache ne sert que de
     repli hors-ligne. Évite de rester bloqué sur une version périmée après
     une mise à jour.
   - Autres requêtes same-origin (polices, assets) → cache-first, elles
     changent rarement.
   - Requêtes TMDB (API + images) → network-first, avec repli sur le cache
     si hors-ligne, pour garder l'appli utilisable sans connexion.
   ================================================================ */

const CACHE_VERSION = "bobine-v2";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const TMDB_CACHE = `${CACHE_VERSION}-tmdb`;

const SHELL_URLS = [
  "./",
  "./index.html"
];

/* ----------------------------------------------------------------
   INSTALL — pré-cache l'app shell, active la nouvelle version tout de suite
   ---------------------------------------------------------------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

/* ----------------------------------------------------------------
   ACTIVATE — nettoie TOUTES les anciennes versions de cache (y compris
   les versions antérieures de bobine-v*, pas seulement celle en cours) et
   prend le contrôle des onglets déjà ouverts sans attendre leur fermeture.
   ---------------------------------------------------------------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("bobine-") && key !== SHELL_CACHE && key !== TMDB_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/* ----------------------------------------------------------------
   FETCH — routage selon le type de requête
   ---------------------------------------------------------------- */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if(request.method !== "GET") return;

  const url = new URL(request.url);
  const isTmdb = url.hostname.includes("themoviedb.org") || url.hostname.includes("tmdb.org");
  const isSameOrigin = url.origin === self.location.origin;
  const isHtmlNavigation = request.mode === "navigate" || url.pathname.endsWith("index.html") || url.pathname.endsWith("/");

  if(isTmdb){
    event.respondWith(networkFirst(request, TMDB_CACHE));
  }else if(isSameOrigin && isHtmlNavigation){
    // Le document HTML lui-même : toujours la version la plus fraîche possible.
    event.respondWith(networkFirst(request, SHELL_CACHE));
  }else if(isSameOrigin){
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
  }
  // Autres origines (polices Google, etc.) : laissées au comportement par défaut du navigateur.
});

/* ----------------------------------------------------------------
   STRATÉGIES DE CACHE
   ---------------------------------------------------------------- */
async function networkFirst(request, cacheName){
  const cache = await caches.open(cacheName);
  try{
    const response = await fetch(request, { cache: "no-store" });
    if(response && response.ok){
      cache.put(request, response.clone());
    }
    return response;
  }catch(err){
    const cached = await cache.match(request);
    if(cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName){
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if(response && response.ok){
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached || (await networkPromise) || new Response("Hors-ligne", { status: 503, statusText: "Offline" });
}
