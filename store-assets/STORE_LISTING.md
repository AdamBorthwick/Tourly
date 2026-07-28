# Chrome Web Store listing — copy/paste reference

## Single purpose (required field)
Build and preview guided, scroll-synced video tours for a webpage, then export an embeddable
snippet for that page.

## Short description (max 132 chars)
Build guided, scroll-synced video tours for your webpages — edit visually, export one embed snippet.
(97 chars)

## Detailed description
Tourly lets you build "guided tours" for your website: a small narrator video pins to the corner
of the page, and as it plays the page automatically scrolls to match what's being talked about —
like a scroll-synced screen recording, but live and interactive.

**What the extension does**
Open Tourly on any page you want to build a tour for. A timeline editor appears where you can:
- Add a vidzflow video and scrub through it in real time
- Drop scroll points that sync specific moments in the video to specific spots on the page
- Add highlights that draw attention to elements as the narration reaches them
- Add subtitles manually, or auto-generate them from the video's audio
- Customize the video's position, corner radius, and other styling

Everything previews live on the real page, so what you see while editing is exactly what ships.

**Exporting**
When you're done, Export gives you a single snippet to paste into your site's custom code — no
build tools, no separate hosting to set up on your end.

**Syncing**
Tours are saved automatically as you edit (locally, and to the cloud if available) so you can
close the tab and come back later, or find a page's tour again from the extension's popup.

**Permissions, plainly**
Tourly only runs on a page when you explicitly open it from the extension's toolbar icon — it
never runs automatically or in the background on pages you haven't opened it on.

## Category
Productivity (or: Web Development)

## Language
English

---

## Permission justifications (for the CWS "Privacy practices" tab)

**activeTab**
Used to identify the current tab when you click "Open editor on this page," so the editor and
tour runtime can be injected into exactly that page.

**scripting**
Used to inject the timeline editor UI and the tour runtime engine into the page you're actively
building a tour for. This only happens when you explicitly click "Open editor" in the popup —
never automatically.

**storage**
Used to locally cache the tour you're currently editing (so in-progress work survives a reload)
and to remember export settings (e.g. the CDN URL used in exported embed code).

**tabs**
Used only to open the page associated with a saved tour when you click it in the popup's "My
tours" list.

**Host permissions (`<all_urls>`)**
Tourly is a general-purpose page-authoring tool: a user can build a tour for any page on any
site (their own Webflow project, a client's site, etc.), so the exact set of sites isn't knowable
in advance. The editor is never active by default on any page — it only runs on a page after the
user explicitly opens it via the toolbar popup, and only until they close the tab or dismiss it.

**Remote code**
Tourly does not execute remote code. All extension logic (background service worker, popup, the
injected editor and tour-runtime scripts) ships as local files inside the extension package. The
extension does make network requests (to Supabase for saving tours, to vidzflow/GitHub/Cloudflare
for resolving video info and the published tour runtime, and — only when the user clicks
"Auto-generate subtitles" — to send that video's audio to OpenAI's Whisper API for transcription),
but none of these responses are ever loaded as executable code into the extension's own context.

**Data usage disclosure**
- Collects: user-authored content (tour configuration — video reference, timing, subtitle text,
  page element selectors, style choices) and a randomly generated per-install identifier used to
  keep each install's tours separate. No name, email, address, or payment info is collected.
- Does not sell or transfer data to third parties for advertising. Does not track browsing
  activity outside of pages the user explicitly opens the editor on.
- Privacy policy URL: https://claude.ai/code/artifact/2840aa44-c394-439c-8881-66ac2e8c1ede
  (⚠ this Artifact is private by default — click its Share button before submitting, or host
  `privacy-policy.html` yourself, e.g. via GitHub Pages on the `Tourly` repo, for a permanent URL)
