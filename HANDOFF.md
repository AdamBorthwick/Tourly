# Tourly — Engineering Handoff

Guided video tours for Webflow case-study pages. A small narrator video pins to a corner of the
page; as it plays the page **auto-scrolls** to match what's being narrated, the user's scroll is
locked (with a "pause to explore" toast), and subtitles show at the bottom. You build/tweak tours
with a **Chrome extension timeline editor** injected onto the live page, then export a single embed
snippet into Webflow's per-page custom code.

This doc is the cold-start guide for anyone continuing the work.

---

## Repo layout

```
engine.js                     ← THE runtime (single source of truth). Shared by editor + live tour.
sync-engine.js                ← `node sync-engine.js` copies engine.js → tourly-extension/content/engine.js
serve.js                      ← dev server on :8777 (+ /resolve endpoint that mirrors the extension's MP4 resolver)
test-harness.html             ← plays a finished tour on a fake page (live-mode preview)
editor-harness.html           ← loads the editor on a fake page WITHOUT the extension (for testing editor.js)
tourly-extension/             ← the Chrome extension (MV3)
  manifest.json
  background.js                ← service worker: MP4 resolve, anonymous auth, Supabase proxy
  supabase-config.js           ← baked-in shared project URL + anon key (owner sets once)
  supabase-config.example.js   ← template for supabase-config.js
  popup/popup.html, popup.js   ← toolbar popup: "Open editor on this page" (+ Phase 3 settings/list)
  lib/playerjs.min.js          ← vendored Player.js (embed.ly) for the live iframe adapter
  content/engine.js            ← COPY of root engine.js (kept in sync via sync-engine.js — DO NOT edit directly)
  content/editor.js            ← the timeline editor (injected as a content script)
  content/editor.css           ← editor styles (light theme)
supabase/schema.sql            ← (Phase 3) table + notes for the user's Supabase project
supabase/functions/transcribe/ ← (Phase 3b) Edge Function: Whisper transcription + cache
cdn-worker/                     ← (Phase 4) Cloudflare Worker: first-party URL that proxies engine.js from jsDelivr
  worker.js, wrangler.toml, README.md
```

**Important:** `engine.js` at the repo root is canonical. After editing it, run `node sync-engine.js`
so the extension's copy updates. `editor.js`/`editor.css` live only in the extension (no copy).

---

## Architecture

Three parts, **one shared engine** so the editor preview is byte-identical to the shipped tour:

```
engine.js  (window.Tourly)
   ├─ live tour:   vidzflow <iframe> driven via Player.js (postMessage)
   ├─ editor preview: our own <video> (vidzflow direct MP4) via a native adapter
   └─ exported snippet: config JSON + <script src=your-cdn-worker…/engine.js>
```

### 1. `engine.js` — the runtime
- **Mount:** `window.Tourly.mount(config, opts)` → returns a controller. `window.Tourly._instances` is the list.
  - `opts.mode`: `'live'` (default) or `'edit'`.
  - `opts.previewVideoUrl`: if set, the engine renders a native `<video src=…>` (no player chrome) instead of the vidzflow iframe. Used by the editor.
  - Auto-mounts on load if `window.TOURLY_CONFIG` exists (this is how the exported snippet works).
- **Controller API:** `play() pause() toggle() close() seek(sec) getTime() getDuration() setConfig(cfg) captureManualTarget() previewPoint(i) on/off/once(evt,cb) destroy()`.
  - Events: `ready`, `timeupdate(t)`, `play`, `pause`, `ended`, `statechange(s)`, `close`, `configchange`.
- **Clock:** dead-reckoning. On each Player.js `timeupdate`/`seeked` it records `(seconds, performance.now())`; while playing, `getTime() = anchor + (now-anchorNow)/1000`. This gives sub-100ms precision (meets the 0.2s target) without polling latency.
- **Scroll engine (`_syncScroll`):** scroll points are keyframes `{time, ease(duration s), easing, target}`. The active point is the last one with `time ≤ currentTime`. Crossing into a new point starts an eased scroll tween (`_startTween`) to the point's resolved Y; between points the page holds. `idx === -1` (before the first point) holds at the top.
- **Easing presets:** `EASINGS = { ease: easeInOutCubic, linear, 'ease-in': easeInCubic, 'ease-out': easeOutCubic }`. Each point has an `easing` name; `_startTween(targetY, dur, easeFn, onDone)`.
- **Target resolution (responsive):** `element` mode → `el.getBoundingClientRect()` + `viewportAnchor` (top/center) + `offsetPx`, re-resolved on resize. `manual` mode → `manualPercent/100 * maxScrollY`. `captureManualTarget()` returns a manual target at the current scroll.
- **Scroll lock + toast:** non-passive `wheel`/`touchmove`/`keydown` handlers `preventDefault` while playing + `scrollLock`. A light nudge shows the centered-bottom toast; **sustained** attempts (weighted over a 1.4s window) auto-pause. Toast sits below the subtitle; both animate up; subtitle lifts above the toast when it shows.
- **Resume:** `play()` first pans the scroll to the correct position for the current time, **then** starts the video (so it never narrates over the wrong section).
- **Video UI (on the dock):** CC (subtitle toggle, bottom-left), volume (mute + slider, bottom-right), close × (top-right, live only), Start/Resume overlay (blurred), click-to-pause. **In `edit` mode the Start overlay AND close × are hidden.**
- **Subtitles:** JSON cues rendered as a custom bottom-center overlay (native `<track>` can't attach to a cross-origin iframe). Slide off-screen when paused; share the video's bottom gap; `offsetBottom` (theme.video) raises everything without changing the horizontal margin (the editor uses this to clear its bottom bar).
- **Highlights:** timed `{start, end, target, color, animation}` cues; during playback the engine draws pulsing overlays on matched page elements (`tourly-hi-layer` / `_syncHighlights`). Config field: `config.highlights[]` (sorted by start).
- **Native adapter (`makeNativeAdapter`):** wraps a `<video>` in the Player.js-shaped interface (`on/getDuration/getCurrentTime/getVolume/setCurrentTime/play/pause/mute/unmute/setVolume`). Volume is 0–100 to match Player.js.

### 2. `tourly-extension/content/editor.js` — the editor
Injected onto the live page (via the popup → `chrome.scripting`). Reuses `engine.js` in `edit` mode for a true WYSIWYG preview. Re-injecting toggles it (`window.__tourlyEditor`). Falls back to `localStorage` when run outside the extension (that's how `editor-harness.html` works).

- **Two states:** first-open **setup card** (paste vidzflow URL + optional name → Load) → then the **editor body**.
- **Fixed height:** `#tourly-editor` is **220px** tall (`EDITOR_H = 220` in `editor.js`). The engine's subtitle/video dock uses `offsetBottom = EDITOR_H + 12` so nothing clips behind the bar. Do **not** reintroduce dynamic height sync — it caused jumpiness.
- **Tabs:** **Motion** (default) · **Theme** · **Export**. There is no separate Subtitles tab anymore — scroll points, highlights, and subtitles all live on one **motion timeline** under the Motion tab. Theme/Export expand the panel to `80vh` with a full-viewport backdrop that blocks clicks to the page behind.
- **Layout (top→bottom):** slim header (brand · tabs · Change video · hide ×) → optional Theme/Export panel → **transport + timeline** (62px track) → **bottom item editor** (fixed ~50px; shows selected scroll point / highlight / subtitle, or a lane placeholder).
- **Motion timeline — three lanes in one track:** lanes appear only when they have content (`motionLaneList()`). Order is always **Scroll → Highlight → Subtitles**. One lane is **focused/expanded** at a time; the others collapse to **12px compact strips** (`MOTION_COMPACT_LANE`). Focus is driven by `motionFocusLane()` (selection > `focusedLane` > `lastFocusedLane`). Lane geometry is CSS-var driven (`--tly-lane-{scroll|highlight|subtitle}-top/height`) so bars, stripes, and hit targets animate in sync (0.2s).
  - **Click compact lane** (via invisible hit overlay or compact bar): `focusCompactLane(lane)` expands that lane without selecting an item.
  - **Click a bar** in compact mode: `focusLaneItem()` expands the lane, selects the item, and seeks.
  - **Track labels** (Scroll / Highlight / Subtitles) hide when they overlap visible bar label/preview text (`syncTrackLabelContrast()` compares label element bounds, not whole bar rects).
- **Transport bar (Motion tab only):** `[Preview][Play] | [Add ▾] | [contextual actions…]`
  - Vertical separators between play/add and add/contextual groups.
  - **Add** opens an upward **fixed-position menu** appended to `document.body` (not clipped by editor overflow). Menu items: Scroll point · Highlight · **Subtitles ›** flyout.
  - **Subtitles flyout** (hover, not modal): **Auto-generate** · **Add subtitle**. Flyout is `position: fixed`, bottom-aligned to the Add menu bottom, with **150ms hover grace** on wrap + flyout so the cursor can cross the gap. Theme colors are defined on `.tly-add-menu` itself (menu is outside `#tourly-editor`).
  - **Contextual buttons** (right of Add, lane-specific): **Add scroll point** · **Add highlight** · **Add subtitles** · **Auto-generate**. Only the buttons for the active lane show (`updateTransportActions()` / `motionEditLane()`). Contextual **Add subtitles** always calls `addSubtitleManual()`; **Auto-generate** only appears on the subtitle lane.
  - **Transcribe status** is an inline `<span class="tly-transcribe-status">` in the transport (e.g. "Generating subtitles…", "11 subtitles generated" for 4s) — not a bottom banner.
- **Adding content:** Scroll point / Highlight still use the **element picker** (`startPick`). Subtitles from the Add flyout or contextual buttons call `addSubtitleManual()` / `autoGenerateSubtitles()`. After adding from the Subtitles flyout, **`selectCue(id)`** runs so the subtitle lane expands and the new cue is selected (clears scroll/highlight selection — important when another lane was focused).
- **Timeline interaction:** press to seek, drag playhead to scrub. Bars are draggable (move/resize handles). **Delete** removes selected item (scroll point / highlight / subtitle depending on selection). Element picker: `html.tly-picking` forces crosshair.
- **Video preview:** resolves vidzflow **direct MP4** (`resolveVideo` → background/`/resolve`) and mounts the engine with `previewVideoUrl` (native `<video>`, no vidzflow chrome).
- **Export:** one `<script>` with `window.TOURLY_CONFIG` + `<script src="<cdnUrl>/engine.js">`. `cdnUrl` stored under `tourly:cdnUrl`. Embed URLs normalized (`controls=false&ctp=false&ap=false&playsinline=true`).
- **Storage:** `chrome.storage.local` keyed by `tourly:<pathname>` (with `localStorage` fallback). Phase 3 adds Supabase.

**Key editor symbols (for grep):** `applyMotionLaneLayout`, `motionFocusLane`, `focusCompactLane`, `focusLaneItem`, `selectCue` / `selectPoint` / `selectHighlight`, `addMenuFlyout`, `positionAddMenu`, `positionAddMenuFlyout`, `updateTransportActions`, `syncTrackLabelContrast`, `setAutoSubBusy`, `setTranscribeStatus`.

### 3. Export / delivery — single self-contained embed by default

**Default export is ONE `<script>` tag with everything inlined**: the tour config, Player.js (the
vidzflow iframe control library), and the full `engine.js` runtime — concatenated as three
independent, self-terminating IIFEs (`configLine; playerjs-source; engine-source`, each separated
by an explicit `;` to avoid ASI hazards between minified/unminified blocks). Zero external
requests, so a pasted tour can never break if any CDN, GitHub, or third-party host goes down —
this was the original requirement and is restored as the default (an earlier pass briefly made a
CDN-hosted two-tag form the default, which was a regression; fixed).

**Player.js is required, not optional**: the live vidzflow iframe adapter (`_initPlayer` in
`engine.js`) needs `window.playerjs` to exist or it silently no-ops (`console.warn` and returns) —
without it a live tour's video would render but be completely uncontrollable (no scroll-sync, no
play/pause). Both export modes below always inline it.

`renderExportTab()`/`snippet()` in `editor.js` build this by fetching the raw source of
`content/engine.js` + `lib/playerjs.min.js` once (`loadEmbedSources()` — via
`chrome.runtime.getURL()` in the extension, or the dev-server paths in the harness) and string-
concatenating them. Verified end-to-end: generated a real export, pasted it into a bare HTML page
with **no other scripts at all**, and confirmed `window.Tourly`/`window.playerjs` both load, the
vidzflow iframe mounts, Player.js connects (`_playerReady: true`, real duration read from the
video), and `play()` genuinely drives playback state via postMessage — zero console errors.

**Advanced/optional: hosted CDN mode.** The Export tab has a toggle ("load the runtime from a
hosted CDN instead") for people who want to update *every* exported tour's engine at once without
re-pasting anywhere — this is what `cdn-worker/` (a Cloudflare Worker proxying
`cdn.jsdelivr.net/gh/<repo>@<PINNED_TAG>/engine.js`, deployed free to
`https://tourly-cdn.<subdomain>.workers.dev`) is for. When enabled, `cdnUrl` (persisted under
`tourly:cdnUrl`, toggle state under `tourly:useHostedCdn`) is used for engine.js via
`<script src>`, while Player.js is still always inlined. Off by default. To roll an engine.js fix
out to every tour using hosted mode: push + tag the repo, bump `PINNED_TAG` in `worker.js`,
`wrangler deploy` — no re-pasting needed for *those* tours specifically (default-mode tours still
need re-export, since they're fully self-contained by design).

---

## vidzflow specifics (important constraints)

- The embed is **video.js over a plain `<video>`** with a **direct MP4** on `r2.vidzflow.com`, and the page loads **Player.js** (`window.playerjs`) — so the live iframe is fully controllable via postMessage.
- `controls=false` removes vidzflow's control **bar** but **NOT** its big center play button, which shows whenever the video is **paused**. It's cross-origin, so we can't restyle it. That's why the **editor preview uses the direct MP4 in our own `<video>`** (the background script fetches the vidzflow page HTML and extracts `…_576p_…mp4`). The MP4 has no hotlink protection and supports range requests.
- Live tours still use the vidzflow **iframe** (keeps vidzflow hosting/analytics; our Start overlay covers the paused button there).

---

## Dev & testing workflow

```
node serve.js          # dev server on http://localhost:8777 (also serves /resolve?url=<vidzflow embed>)
```
- **Live tour preview:** http://localhost:8777/test-harness.html
- **Editor preview:** http://localhost:8777/editor-harness.html  (drives editor.js without the extension)
- **Real extension:** load `tourly-extension/` unpacked at `chrome://extensions` (Developer mode → Load unpacked). Reload it there after engine/background changes. Click the toolbar icon → "Open editor on this page".
- After editing root `engine.js`: **`node sync-engine.js`**.

**Test video used throughout:** `https://app.vidzflow.com/v/YnLsk0eNer?...` (≈25.6s).

### Gotchas when testing via an automated/headless browser
- `requestAnimationFrame` and timers are **frozen/throttled when the tab is hidden** — scroll tweens and the engine loop won't advance. Shim `rAF`→`setTimeout` for logic tests, or test in a real visible browser.
- `vh` units in the embedded browser pane resolve against a small real viewport (so `80vh` reads oddly); it's correct in a normal browser.
- Muted/hidden video playback is unreliable in the pane; verify playback feel in a real browser.

---

## Status

- **Phase 0** (Player.js × vidzflow spike) — done. `spike/playerjs-spike.html` proved postMessage control.
- **Phase 1** (engine.js runtime) — done. Scroll sync, lock, subtitles, theme, volume, resume-pan, mobile-conscious structure.
- **Phase 2** (Chrome extension editor) — done and heavily iterated. Setup flow, unified motion timeline (scroll + highlight + subtitle lanes), transport bar with Add menu + contextual actions, lane focus/compact mode, element picker, subtitles auto-generate, theme/export tabs, expand+backdrop, light theme, native-video preview.
- **Phase 2b** (editor UX polish, Jul 2025) — done in Cursor sessions before first GitHub push. See **"Recent editor iteration"** below.
- **Phase 3** (Shared Supabase backend) — CODE COMPLETE. One project baked into `supabase-config.js`; each install silently signs in with **Anonymous Auth** (JWT in chrome.storage). RLS on `auth.uid()` isolates tours — users never paste keys. Popup shows sync status + "My tours" list. Local storage still works if cloud is unavailable.
- **Phase 3b** (Auto-generate subtitles) — CODE COMPLETE, pending live verification. Supabase Edge Function `transcribe` calls OpenAI Whisper; results cached in `transcription_cache` by vidzflow `videoId`. In the editor: **Auto-generate** lives in the Add menu Subtitles flyout and as a contextual transport button when the subtitle lane is focused (not in the top-level Add menu). Auto cues use `source:"auto"` (blue on timeline), manual cues use `source:"manual"` (gold). Re-run replaces only auto cues; manual cues are kept.
- **Phase 4** (publish) — CODE COMPLETE, pending your manual steps (repo push + Cloudflare deploy, see below). `cdn-worker/` (Worker + `wrangler.toml` + README) is built; the editor's Export tab now saves/uses a `cdnUrl` pointing at it instead of a raw jsDelivr link.

### Phase 4 setup (owner, once)

1. `git init`, push this repo to a **public** GitHub repo (e.g. `github.com/<you>/tourly`), then
   `git tag v1 && git push --tags`.
2. `cdn-worker/worker.js`: set `GH_REPO` to `<your-github-username>/tourly`.
3. `npm install -g wrangler` → `wrangler login` (free Cloudflare account) → from `cdn-worker/`, `wrangler deploy`.
4. Copy the printed `https://tourly-cdn.<subdomain>.workers.dev` URL into the extension's
   **Export tab → CDN URL** field on any tour — it's saved once and reused for future exports.
5. To ship an `engine.js` fix to every live tour later: push + tag a new version, bump
   `PINNED_TAG` in `worker.js`, `wrangler deploy` again. No customer re-pastes anything.

### Shared backend setup (owner, once)

1. Create one Supabase project.
2. **Authentication → Providers → enable Anonymous sign-ins.**
3. Run `supabase/schema.sql` (fresh) or `supabase/migrate-shared-backend.sql` (if you had the old `device_id` table).
4. Copy `supabase-config.example.js` → `supabase-config.js`, paste URL + **anon public** key (`sb_publishable_…` or legacy `eyJ…`). **`supabase-config.js` is gitignored** — never commit it.
5. Deploy edge function + Whisper secret (see below).
6. Ship the extension — end users install and sync works automatically.

### Auto-generate subtitles setup

1. Run the updated `supabase/schema.sql` (adds `transcription_cache` table).
2. Deploy the edge function:
   ```
   supabase functions deploy transcribe
   supabase secrets set OPENAI_API_KEY=sk-...
   ```
3. Ensure `supabase-config.js` has your anon key (no popup setup needed).
4. In the editor → focus the **Subtitles** lane → **Auto-generate** (transport or Add → Subtitles flyout).

**Dev without Supabase:** `node serve.js` exposes `POST /transcribe` with fake segments; `editor-harness.html` uses this automatically.

---

## Recent editor iteration (Jul 2025 — pre-GitHub push)

Work done in Cursor before the repo went to GitHub. All changes are in `tourly-extension/content/editor.js` and `editor.css` unless noted.

### Motion timeline & lanes
- Replaced separate Scroll / Subtitles tabs with a single **Motion** tab and a **three-lane timeline** (scroll, highlight, subtitle). Lanes stack vertically inside the 62px track; one lane expands, others compact to 12px.
- Added **highlights** as a first-class lane + config field (`config.highlights[]`); engine renders them as page overlays during playback (`engine.js` `_syncHighlights`).
- Lane stripes, hit targets, and bars share CSS vars (`--tly-lane-*-top/height`) with unified 0.2s transitions — fixes out-of-sync lane animation when switching focus.
- Compact lane click → expand; compact bar click → expand + select + seek. `lastFocusedLane` + `focusedLane` preserve focus after deletes.

### Transport & Add menu
- Transport layout: contextual lane actions left-aligned after Add, with vertical separators.
- **Add** button + dropdown (opens upward, `position: fixed` on `document.body`) with icons per action type.
- **Subtitles** is a hover flyout (Auto-generate / Add subtitle), replacing an earlier modal intro overlay (`subIntroOverlay` — removed).
- Flyout positioning: bottom aligned to Add menu bottom; 150ms hover grace so cursor can reach flyout without it closing.
- Contextual buttons show only for the active lane; Auto-generate removed from top-level Add menu (subtitle flyout + contextual only).
- Transcribe progress/success shown inline in transport (`tly-transcribe-status`), not a bottom banner.

### Layout & polish fixes
- Editor fixed at **220px**; bottom item editor fixed height — stops grow/shrink when selection changes.
- Add menu theme colors defined on `.tly-add-menu` (required because menu lives outside `#tourly-editor`).
- Track label overlap: `syncTrackLabelContrast()` uses **visible label element bounds** so "Highlight" etc. hide correctly when bars start at the left but text is centered.
- Adding from Subtitles flyout calls **`selectCue()`** so the subtitle lane is focused and the new cue selected (fixes stale scroll/highlight selection keeping the wrong lane expanded).

### Removed / don't resurrect
- `subIntroOverlay` and subtitle intro modal flow.
- Dynamic `syncEditorHeight` / height-mismatch bottom gap hacks.
- Auto-generate as a direct Add-menu row (now flyout-only at top level).

### Likely next steps (not done)
- Same `selectPoint` / `selectHighlight` cleanup after Add menu pick completes (scroll/highlight may still leave stale cross-lane selection in edge cases).
- Mobile / narrow-viewport pass on flyout + transport.
- Live verification of Phase 3b transcription on deployed Supabase.

---

## Known limitations / TODO
- Anonymous auth is per-browser-install; clearing extension storage creates a new identity (tours on old identity are orphaned). Add email magic-link later for cross-device recovery (`linkIdentity`).
- Provider is vidzflow-only. The engine's player interaction is isolated to `_initPlayer` + the native adapter, so adding a Vimeo/YouTube adapter is a contained change (see the "expand to other players" discussion).
- Auto-transcription requires OpenAI secret on the edge function; add per-user rate limits before wide public release.
- Mobile is structurally supported but only desktop has been exercised.
- Fully-inlined (no-CDN) export variant not built yet.
