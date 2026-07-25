# Tourly CDN worker

Gives every exported tour a stable, first-party runtime URL
(`https://tourly-cdn.<your-subdomain>.workers.dev/engine.js`) instead of a bare jsDelivr link.
Today it proxies + edge-caches `engine.js` from jsDelivr (which mirrors the public `tourly`
GitHub repo). Later you can swap the fetch in `worker.js` for Cloudflare R2/KV to host the
source privately — the public URL never changes, so no already-deployed tour breaks.

## One-time setup

1. Push the `engine.js` you want to serve to a **public** GitHub repo (e.g. `github.com/<you>/tourly`),
   and tag the commit (`git tag v1 && git push --tags`).
2. Edit `worker.js`: set `GH_REPO` to `<your-github-username>/tourly`.
3. `npm install -g wrangler` (or use `npx wrangler` for every command below).
4. `wrangler login` — opens a browser to authorize your **free** Cloudflare account.
5. From this folder: `wrangler deploy`.
6. Copy the printed URL (e.g. `https://tourly-cdn.abcd1234.workers.dev`) into the Tourly
   extension's **Export tab → CDN URL** field. Every tour you export from then on uses it.

## Rolling out an engine.js update to every live tour

1. Commit + push the change to the `tourly` repo, tag a new version (e.g. `v2`).
2. In `worker.js`, bump `PINNED_TAG` to `'v2'`.
3. `wrangler deploy`.

Every tour using this worker's URL picks up the new `engine.js` within `EDGE_CACHE_SECONDS`
(5 minutes by default) — no re-pasting the embed code on any customer site.

## Later: move off jsDelivr entirely

Replace the `fetch(upstream, …)` call in `worker.js` with a read from Cloudflare R2/KV (or any
private store) and redeploy. The `/engine.js` URL customers already embedded doesn't change, so
this is a backend swap, not a migration.
