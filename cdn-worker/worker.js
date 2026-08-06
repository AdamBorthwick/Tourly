// Tourly CDN proxy — a stable, first-party URL for the tour runtime (engine.js).
//
// Every exported tour embed points at THIS worker's URL, never directly at jsDelivr/GitHub.
// Serves a BUNDLE: Player.js (required by engine.js's live vidzflow-iframe adapter — without it
// a video renders but is completely uncontrollable) concatenated with engine.js itself, so a
// concise export's single <script src="…/engine.js"> tag is fully self-sufficient — nothing else
// needs to be pasted or loaded separately. Both pieces are fetched from jsDelivr (which mirrors
// the public GitHub repo below) and edge-cached. Later, swap the upstream fetches for Cloudflare
// R2/KV to host the source privately — the public URL never changes, so no customer's
// already-pasted embed code breaks.

var GH_REPO = 'AdamBorthwick/Tourly';
var PINNED_TAG = 'v0.4.8';                      // bump + redeploy to roll an update out to every live tour
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
    // Include the pin in the cache key so bumping PINNED_TAG + redeploying never serves a
    // stale bundle for up to EDGE_CACHE_SECONDS.
    var cacheKey = new Request(url.origin + url.pathname + '?pin=' + PINNED_TAG, request);
    var cached = await cache.match(cacheKey);
    if (cached) return cached;

    var base = 'https://cdn.jsdelivr.net/gh/' + GH_REPO + '@' + PINNED_TAG + '/';
    var playerjsUrl = base + 'tourly-extension/lib/playerjs.min.js';
    var engineUrl = base + 'engine.js';

    var playerjsRes, engineRes;
    try {
      [playerjsRes, engineRes] = await Promise.all([
        fetch(playerjsUrl, { cf: { cacheTtl: EDGE_CACHE_SECONDS, cacheEverything: true } }),
        fetch(engineUrl, { cf: { cacheTtl: EDGE_CACHE_SECONDS, cacheEverything: true } })
      ]);
    } catch (e) {
      return unavailable('upstream fetch failed');
    }
    if (!playerjsRes.ok || !engineRes.ok) {
      return unavailable('upstream unavailable (' + playerjsRes.status + '/' + engineRes.status + ')');
    }

    var playerjsBody = await playerjsRes.text();
    var engineBody = await engineRes.text();
    // Explicit ";" separator between the two independent, self-terminating IIFEs — guards
    // against ASI hazards if either file's minified tail doesn't end in a semicolon.
    var body = playerjsBody + '\n;\n' + engineBody;

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

function unavailable(reason) {
  return new Response('/* Tourly: ' + reason + ' */', {
    status: 502,
    headers: Object.assign({ 'Content-Type': 'application/javascript; charset=utf-8' }, corsHeaders())
  });
}

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*' };
}
