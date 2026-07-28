# Tourly — Engineering Handoff

Guided video tours for Webflow case-study pages. A small narrator video pins to a corner of the
page; as it plays the page **auto-scrolls** to match what's being narrated, the user's scroll is
locked (with a "pause to explore" toast), and subtitles show at the bottom. You build/tweak tours
with a **Chrome extension timeline editor** injected onto the live page, then export an embed
snippet into Webflow's per-page custom code.

This doc is the cold-start guide for anyone continuing the work. For **open work items**, see
`BACKLOG.md` (local, gitignored).

---

## Repo layout

```
engine.js                     ← THE runtime (single source of truth). Shared by editor + live tour.
sync-engine.js                ← `node sync-engine.js` copies engine.js → tourly-extension/content/engine.js
serve.js                      ← dev server on :8777 (+ /resolve, /transcribe stubs for harness)
test-harness.html             ← plays a finished tour on a fake page (live-mode preview)
editor-harness.html           ← loads the editor on a fake page WITHOUT the extension
tourly-extension/             ← the Chrome extension (MV3)
  manifest.json
  background.js                ← service worker: MP4 resolve, anonymous + email auth, Supabase proxy
  supabase-config.js           ← baked-in shared project URL + anon key (owner sets once, gitignored)
  supabase-config.example.js
  popup/popup.html, popup.js   ← toolbar popup: open editor, account badge, my tours list
  account/account.html, account.js ← email/code flow in a full tab (popup closes on focus loss)
  lib/playerjs.min.js          ← vendored Player.js for the live iframe adapter
  content/engine.js            ← COPY of root engine.js (sync via sync-engine.js — DO NOT edit directly)
  content/editor.js            ← timeline editor (injected content script)
  content/editor.css
supabase/
  schema.sql
  migrations/                  ← incremental SQL (profiles, public read, force RLS, …)
  functions/transcribe/        ← Edge Function: Whisper + cache + per-user quota
cdn-worker/                    ← Cloudflare Worker: first-party URL proxying pinned engine.js
store-assets/                  ← Chrome Web Store listing, privacy policy, zip helpers
BACKLOG.md                     ← local backlog (gitignored)
```

**Important:** `engine.js` at the repo root is canonical. After editing it, run `node sync-engine.js`.
`editor.js` / `editor.css` live only in the extension.

---

## Architecture

Three parts, **one shared engine** so the editor preview matches the shipped tour:

```
engine.js  (window.Tourly)
   ├─ live tour:   vidzflow <iframe> via Player.js (postMessage)
   ├─ editor preview: native <video> (vidzflow direct MP4)
   └─ exported snippet: config + engine.js (CDN or inlined)
```

### 1. `engine.js` — the runtime

- **Mount:** `window.Tourly.mount(config, opts)` → controller. `opts.mode`: `'live'` or `'edit'`.
  `opts.previewVideoUrl` → native `<video>` for editor preview.
- **Scroll engine:** keyframes `{time, ease, easing, target}`; eased tweens between points.
- **Scroll lock + toast:** wheel/touch/key blocked while playing; sustained attempts auto-pause.
- **Subtitles:** custom bottom overlay (not native `<track>` on cross-origin iframe).
- **Highlights:** `{start, end, target, color, animation}` → fixed overlay layer with SVG ring
  shell (does not mutate page element `overflow`). Animations: `outline`, `sweep`, `pulse`,
  `text-glow`, `box-glow` (legacy `fade-in` → `outline`, `glow` → text/box split).
  **Text glow** uses CSS `text-shadow` on text nodes — locked approach, do not replace with
  inline blur divs. Box glow / pulse use outward `box-shadow` halo + crisp SVG ring.
- **Timing:** non-pulse anims use clip duration (25% / 50% / 25% phases); pulse loops ~1.35s.
  Playhead scrub cooldown ~280ms after seek to avoid animation retrigger glitches.

### 2. `tourly-extension/content/editor.js` — the editor

Injected via popup → `chrome.scripting`. Toggle with `window.__tourlyEditor`. Falls back to
`localStorage` in `editor-harness.html`.

- **Two states:** setup card (first vidzflow URL) → editor body.
- **Fixed height:** `#tourly-editor` is **220px** (`EDITOR_H = 220`). Engine dock uses
  `offsetBottom = EDITOR_H + 12`. Do **not** reintroduce dynamic height sync.
- **Tabs:** **Editor** (default) · **Settings** · **Export**. Internal ids remain
  `scroll` / `theme` / `export`. Scroll points, highlights, and subtitles share one **motion
  timeline** under Editor. Settings and Export expand to `80vh` with a full-viewport backdrop.
- **Layout (top→bottom):**
  - Header: brand · tabs · hide × (no Change video in header — moved to Settings)
  - Optional Settings/Export panel (Settings hides timeline + transport via `updateTabLayout()`)
  - Transport + timeline (62px track) — **Editor tab only**
  - Bottom item editor (~50px): selected scroll point / highlight / subtitle, or lane placeholder
- **Bottom editor (Jul 2026):** lane icon + title (Scroll point / Highlight / Subtitle); time
  fields use `M:SS` text inputs; scroll points use **End point** (not duration); Delete shows
  trash icon. Cloud "synced" indicator removed — saves happen silently on change.
- **Settings tab:** **Tour video** (embed URL, name, Update video — keeps timeline, see BACKLOG
  for safety UX) + **Player appearance** (width, radius, margin, position).
- **Motion timeline — three lanes:** Scroll → Highlight → Subtitles. One lane expanded, others
  compact (12px). Focus via selection, `focusedLane`, `lastFocusedLane`, compact-lane click.
- **Transport (Editor only):** `[Play][Preview] | [Add ▾] | contextual lane actions`. Add menu
  is `position: fixed` on `document.body`. Subtitles flyout: Auto-generate · Add subtitle.
- **Export tab:** mode selector — **Concise** (default): tiny snippet + CDN `engine.js`, fetches
  tour by id at runtime; **Self-contained**: inlines config + Player.js + engine.js. CDN URL
  persisted under `tourly:cdnUrl`.
- **Storage:** `chrome.storage.local` per pathname + Supabase cloud sync when configured.

**Key symbols:** `applyMotionLaneLayout`, `motionFocusLane`, `focusCompactLane`, `selectCue` /
`selectPoint` / `selectHighlight`, `applyVideoChange`, `updateTabLayout`, `fmt` / `timeInput`,
`renderThemeTab`, `syncTrackLabelContrast`.

### 3. Auth & cloud (Phase 3–6)

- **Anonymous auth** on install → JWT in `chrome.storage`; RLS on `auth.uid()`.
- **Phase 5 — Email:** Flow A (add email to current session) and Flow B (sign in on new device)
  via 6-digit code in `account/account.html`. Popup shows signed-in vs anonymous badge.
- **Phase 6 — Profiles:** `profiles` table + transcription quota in `transcribe` edge function
  (`free` / `pro` limits in code). Global daily circuit breaker in `usage_global`.
- **Login-before-editor gate:** discussed, **not enforced** yet — see BACKLOG.

### 4. Export / delivery

**Default: Concise export** — small embed references tour id + loads `engine.js` from CDN worker.
Requires tour saved to Supabase and `20260727000000_public_read_tours_for_concise_export` policy.

**Alternative: Self-contained** — one `<script>` with config + Player.js + engine.js inlined;
zero runtime dependencies; larger paste size.

Both modes inline **Player.js** (required for live vidzflow control).

---

## vidzflow specifics

- Live iframe uses Player.js postMessage; editor preview uses direct MP4 from `r2.vidzflow.com`
  (background resolves embed HTML → MP4 URL).
- `controls=false` hides bar but not vidzflow's center play button when paused — Start overlay
  covers it in live mode; editor uses own `<video>` without that button.

---

## Dev & testing workflow

```
node serve.js          # http://localhost:8777 (+ /resolve, /transcribe stub)
node sync-engine.js    # after editing root engine.js
```

- **Live tour:** http://localhost:8777/test-harness.html
- **Editor:** http://localhost:8777/editor-harness.html
- **Extension:** load unpacked `tourly-extension/` at `chrome://extensions`, reload after changes.

**Test video:** `https://app.vidzflow.com/v/YnLsk0eNer?...` (≈25.6s).

---

## Status

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Player.js × vidzflow spike | Done |
| 1 | engine.js runtime | Done |
| 2 | Extension editor + motion timeline | Done, heavily iterated |
| 2b | Editor UX polish (2025 sessions) | Done — see below |
| 3 | Shared Supabase + anonymous auth | Code complete |
| 3b | Auto-generate subtitles (Whisper) | Code complete — **pending live verify** |
| 4 | CDN worker + export modes | Code complete — owner deploy steps |
| 5 | Email auth (account page, Flow A/B) | Code complete — **pending E2E verify** |
| 6 | Profiles + transcription quotas | Code complete — **pending migration verify** |
| 7–9 | Stripe, gating UI, store updates | Not started — see BACKLOG |

### Owner setup (once)

**Supabase:** enable Anonymous sign-ins → run `schema.sql` + migrations → `supabase-config.js` →
`supabase functions deploy transcribe` + `OPENAI_API_KEY` secret.

**CDN:** push public repo, tag, `wrangler deploy`, paste worker URL in Export tab.

**Email auth:** configure Supabase email templates + Resend/domain (`tourly.tours`).

---

## Recent editor iteration

### Jul 2025 (pre-GitHub)

Motion timeline lanes, highlights, Add menu + flyout, transport contextual actions, compact lane
focus, track label contrast fix, fixed 220px height, removed subtitle intro modal.

### Jul 2026 (this thread)

- Tabs renamed: **Editor / Settings / Export**
- Change video moved to Settings; timeline hidden on Settings tab
- Bottom editor: lane icons, colon timecodes, scroll End point, delete trash icon
- Removed static "synced" header; cloud save on `save()` remains
- Highlight animation engine: text-glow (text-shadow), box-glow halo, ring shell overlay,
  outline rename, pulse/sweep timing — **sweep/box-glow polish still open** (BACKLOG)
- Phase 5 account page + popup badge; Phase 6 profiles migration + quota in transcribe

---

## Accessibility & usability (audit considerations)

Not implemented yet — captured in `BACKLOG.md` under **Accessibility & usability**. Summary for
handoff:

**Live tour (`engine.js`):**
- Announce scroll-lock toast (`aria-live`)
- Respect `prefers-reduced-motion` for scroll tweens and highlight animations
- Better CC button name; tour discovery for screen reader users
- Optional config flag to force reduced motion for all visitors

**Extension editor:**
- Keyboard timeline editing (nudge, seek, delete) — today is mouse-first (drag/resize/ripple)
- Keyboard path to expand compact lanes; accessible element picker
- Focus trap in expanded Settings/Export overlay
- Optional high-contrast theme and larger hit targets for low-vision authors
- Reduce motion in editor preview when OS requests it

Run a full WCAG 2.1 AA pass on a real case-study page before public launch; file results into BACKLOG.

---

## Known limitations

- Anonymous install = new identity; orphaned tours if storage cleared (email flow helps recovery).
- vidzflow-only video provider (adapter isolated in `_initPlayer`).
- Transcription quota enforced server-side; editor UI for limit/upgrade is minimal.
- Mobile/responsive: structurally supported, desktop-only testing so far.
- Highlight sweep/box-glow visual polish incomplete (see BACKLOG).
- Update video in Settings does not confirm or clamp timeline timings.
- `HANDOFF.md` + `BACKLOG.md`: keep HANDOFF accurate for architecture; BACKLOG for open tasks.

---

## Likely next steps

See `BACKLOG.md` for prioritized list. Highest signal:

1. Highlight animation polish (sweep outward glow, ring fade sync)
2. Update-video safety UX in Settings
3. Run pending Supabase migrations + verify Phase 3b / 5 / 6 on prod
4. Accessibility audit kickoff (motion controls + keyboard editor)
