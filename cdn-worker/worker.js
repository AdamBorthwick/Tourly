// Tourly CDN proxy — a stable, first-party URL for the tour runtime (engine.js).
//
// Every exported tour embed points at THIS worker's URL, never directly at jsDelivr/GitHub.
// Today the worker fetches + edge-caches engine.js from jsDelivr (which mirrors the public
// GitHub repo below). Later, swap the upstream fetch for Cloudflare R2/KV to host the source
// privately — the public URL never changes, so no customer's already-pasted embed code breaks.

var GH_REPO = 'AdamBorthwick/Tourly';
var PINNED_TAG = 'v1';                      // bump + redeploy to roll an engine.js update out to every live tour
var EDGE_CACHE_SECONDS = 300;               // how fast an update propagates to already-loaded tours

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (url.pathname !== '/engine.js') {
      return new Response('Not found', { status: 404 });
    }

    var cache = caches.default;
    var cacheKey = new Request(url.toString(), request);
    var cached = await cache.match(cacheKey);
    if (cached) return cached;

    var upstream = 'https://cdn.jsdelivr.net/gh/' + GH_REPO + '@' + PINNED_TAG + '/engine.js';
    var upstreamRes;
    try {
      upstreamRes = await fetch(upstream, { cf: { cacheTtl: EDGE_CACHE_SECONDS, cacheEverything: true } });
    } catch (e) {
      return new Response('/* Tourly: upstream fetch failed */', {
        status: 502,
        headers: Object.assign({ 'Content-Type': 'application/javascript; charset=utf-8' }, corsHeaders())
      });
    }
    if (!upstreamRes.ok) {
      return new Response('/* Tourly: upstream engine.js unavailable (' + upstreamRes.status + ') */', {
        status: 502,
        headers: Object.assign({ 'Content-Type': 'application/javascript; charset=utf-8' }, corsHeaders())
      });
    }

    var body = await upstreamRes.text();
    var res = new Response(body, {
      status: 200,
      headers: Object.assign({
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=' + EDGE_CACHE_SECONDS
      }, corsHeaders())
    });

    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }
};

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*' };
}
