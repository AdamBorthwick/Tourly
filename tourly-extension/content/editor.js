/* Tourly editor — injected onto the live page. Builds a bottom-docked timeline editor
 * that drives the shared engine (mode:"edit") for a true WYSIWYG preview.
 * Auto-initialises on load; re-injecting toggles it. Works in the extension (chrome.storage)
 * and in a plain page for testing (falls back to localStorage). */
(function () {
  'use strict';

  // toggle if already open
  if (window.__tourlyEditor) { window.__tourlyEditor.toggle(); return; }

  var EDITOR_H = 220;
  // Default export is a SINGLE self-contained <script> — engine.js and Player.js inlined
  // alongside the tour config, so a pasted embed has zero external dependency and can never
  // break if any CDN goes down. The deployed cdn-worker/ URL below only matters if the user
  // opts into "hosted" mode (Export tab toggle) for centrally-updating many tours at once.
  var DEFAULT_CDN = 'https://tourly-cdn.tourly567.workers.dev';

  // A tour's page identity must include the origin, not just the path — otherwise two different
  // sites sharing a path (e.g. two Webflow projects both at "/case-studies/acme") collide, both
  // locally and in the shared backend's unique (user_id, page_url) constraint.
  function pageKey() { return location.origin + location.pathname; }

  // ---- storage (chrome.storage in extension, localStorage when testing) ----
  var store = {
    key: 'tourly:' + pageKey(),
    cdnKey: 'tourly:cdnUrl',
    modeKey: 'tourly:exportMode',
    get: function (key, cb) {
      if (window.chrome && chrome.storage && chrome.storage.local) chrome.storage.local.get(key, function (r) { cb(r[key]); });
      else { try { cb(JSON.parse(localStorage.getItem(key) || 'null')); } catch (e) { cb(null); } }
    },
    set: function (key, val) {
      if (window.chrome && chrome.storage && chrome.storage.local) { var o = {}; o[key] = val; chrome.storage.local.set(o); }
      else localStorage.setItem(key, JSON.stringify(val));
    }
  };

  // ---- helpers ----
  function uuid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function fmt(t) { t = Math.max(0, t || 0); var m = Math.floor(t / 60), s = (t % 60); return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1).replace('.', ':'); }
  function h(tag, props, kids) {
    var e = document.createElement(tag);
    if (props) for (var k in props) {
      if (k === 'class') e.className = props[k];
      else if (k === 'text') e.textContent = props[k];
      else if (k === 'html') e.innerHTML = props[k];
      else if (k === 'style') Object.assign(e.style, props[k]);
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2).toLowerCase(), props[k]);
      else if (props[k] != null) e.setAttribute(k, props[k]);
    }
    (kids || []).forEach(function (c) { if (c == null) return; e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }

  // build a reasonably unique selector for an element
  function selectorFor(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';
    if (el.id) return '#' + cssEscape(el.id);
    var path = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      if (el.id) { path.unshift('#' + cssEscape(el.id)); break; }
      var tag = el.tagName.toLowerCase();
      var sibs = el.parentElement ? Array.prototype.filter.call(el.parentElement.children, function (c) { return c.tagName === el.tagName; }) : [el];
      if (sibs.length > 1) tag += ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')';
      path.unshift(tag);
      el = el.parentElement;
    }
    return path.join(' > ');
  }

  function truncateLabel(s, max) {
    max = max || 48;
    s = (s || '').trim();
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '\u2026';
  }

  function labelForElement(el) {
    if (!el || el.nodeType !== 1) return 'Element';
    if (el === document.body || el === document.documentElement) return 'Page';
    var aria = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    if (aria) return truncateLabel(aria);
    if (el.tagName === 'IMG') {
      var alt = (el.getAttribute('alt') || '').trim();
      if (alt) return truncateLabel('Image: ' + alt);
    }
    var tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      var heading = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (heading) return truncateLabel(heading);
      return tag.toUpperCase();
    }
    if (tag === 'button' || tag === 'a' || tag === 'label') {
      var btn = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (btn) return truncateLabel(btn);
    }
    if (el.id) return truncateLabel(el.id.replace(/[-_]+/g, ' '));
    if (el.classList && el.classList.length) {
      var cls = el.classList[0];
      if (cls && !/^(w-|h-|p-|m-|flex|grid|text-|bg-|border-)/.test(cls)) {
        return truncateLabel(tag + ' \u00b7 ' + cls.replace(/[-_]+/g, ' '));
      }
    }
    var snippet = (el.innerText || '').trim().replace(/\s+/g, ' ');
    if (snippet) return truncateLabel(snippet);
    return tag;
  }

  function simplifySelector(sel) {
    if (!sel) return 'Element';
    if (sel.charAt(0) === '#') return truncateLabel(sel.slice(1).replace(/[-_]+/g, ' '));
    var last = (sel.split(' > ').pop() || sel).replace(/:nth-of-type\(\d+\)/g, '').trim();
    if (last.charAt(0) === '#') return simplifySelector(last);
    return truncateLabel(last.split(/[.[]/)[0] || 'Element');
  }

  function displayNameForTarget(target) {
    if (!target) return 'Element';
    if (target.label) return target.label;
    if (target.selector) {
      try {
        var el = document.querySelector(target.selector);
        if (el) return labelForElement(el);
      } catch (err) {}
      return simplifySelector(target.selector);
    }
    return 'Element';
  }

  // ---- state ----
  var ED = {};
  var config = null, engine = null, duration = 0, cdnUrl = DEFAULT_CDN;
  // 'concise' (default): <script data-tourly-id src="cdnUrl/engine.js"> — tiny, always current,
  // needs the backend live at page-load. 'self-contained': everything inlined, zero dependency,
  // larger snippet. See snippet().
  var exportMode = 'concise';
  var embedSources = { engine: null, playerjs: null, loading: false };

  // Fetch the raw source of engine.js + Player.js once, so the default export can inline them
  // into a single <script> with zero external dependency. Extension context reads its own
  // bundled files directly; the dev-server harness fetches the equivalent local paths.
  function loadEmbedSources(cb) {
    if (embedSources.engine && embedSources.playerjs) { cb(embedSources); return; }
    if (embedSources.loading) { embedSources._waiters = (embedSources._waiters || []).concat(cb); return; }
    embedSources.loading = true;
    embedSources._waiters = [cb];
    var engineUrl, playerjsUrl;
    if (window.chrome && chrome.runtime && chrome.runtime.getURL) {
      engineUrl = chrome.runtime.getURL('content/engine.js');
      playerjsUrl = chrome.runtime.getURL('lib/playerjs.min.js');
    } else {
      engineUrl = '/engine.js';
      playerjsUrl = '/tourly-extension/lib/playerjs.min.js';
    }
    Promise.all([
      fetch(engineUrl).then(function (r) { return r.text(); }),
      fetch(playerjsUrl).then(function (r) { return r.text(); })
    ]).then(function (res) {
      embedSources.engine = res[0];
      embedSources.playerjs = res[1];
      embedSources.loading = false;
      var waiters = embedSources._waiters || [];
      embedSources._waiters = [];
      waiters.forEach(function (w) { w(embedSources); });
    }).catch(function () {
      embedSources.loading = false;
      var waiters = embedSources._waiters || [];
      embedSources._waiters = [];
      waiters.forEach(function (w) { w(null); });
    });
  }
  var activeTab = 'scroll';
  var pickContext = null; // { type: 'scroll'|'highlight', id: string }
  var previewActive = false;
  var addMenuOpen = false;
  var saveTimer = 0;
  var draggingMarker = false;
  var draggingHighlight = false;
  var draggingCue = false;
  var lastScrubAt = 0;
  var playheadScrubLockedUntil = 0;
  var PLAYHEAD_SCRUB_COOLDOWN_MS = 280;
  var selectedPointId = null;
  var selectedCueId = null;
  var selectedHighlightId = null;
  var focusedLane = 'scroll'; // 'scroll' | 'highlight' | 'subtitle' — keeps lane expanded after delete
  var lastFocusedLane = 'scroll';
  var LANE_HIT_TITLES = {
    scroll: 'Click to edit scroll points',
    highlight: 'Click to edit highlights',
    subtitle: 'Click to edit subtitles'
  };
  var transcribing = false;
  var EXPAND_TABS = { theme: true, export: true };
  var DEFAULT_HIGHLIGHT_COLOR = '#ff4d8d';
  var HIGHLIGHT_ANIMS_COMMON = ['outline', 'sweep', 'pulse'];

  function highlightAnimLabel(a) {
    if (a === 'text-glow') return 'Text glow';
    if (a === 'box-glow') return 'Box glow';
    if (a === 'outline') return 'Outline';
    if (a === 'fade-in') return 'Outline';
    return a;
  }

  function highlightAnimsFor(hl) {
    var anims = HIGHLIGHT_ANIMS_COMMON.slice();
    var hasText = !engine || !engine.highlightTargetHasText || engine.highlightTargetHasText(hl.target);
    if (hasText) anims.push('text-glow');
    anims.push('box-glow');
    return anims;
  }

  function normalizeHighlightAnim(hl) {
    if (!hl) return;
    if (hl.animation === 'glow') hl.animation = 'box-glow';
    if (hl.animation === 'fade-in') hl.animation = 'outline';
  }

  function newConfig() {
    return {
      id: uuid(), version: 1, name: 'Tour', pageUrl: pageKey(),
      video: { provider: 'vidzflow', embedUrl: '', videoId: null, duration: null },
      scrollPoints: [], subtitles: [], highlights: [],
      theme: { video: { radius: 8, width: 320, position: 'bottom-right', margin: 24 } },
      behavior: { scrollLock: true, pauseOnVideoClick: true, startTrigger: 'manual' }
    };
  }

  // cloud sync (shared Supabase backend via background; no-op when unavailable)
  var cloud = { configured: false, userId: null };
  function bg(msg, cb) {
    if (window.chrome && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage(msg, function (r) {
          if (chrome.runtime.lastError) { cb && cb(null); return; }
          cb && cb(r);
        });
        return;
      } catch (e) {}
    }
    // harness fallback: dev server stub for transcription
    if (msg && msg.type === 'transcribeSubtitles') {
      fetch('/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embedUrl: msg.embedUrl, videoId: msg.videoId })
      }).then(function (r) { return r.json(); }).then(function (j) { cb && cb(j); })
        .catch(function (e) { cb && cb({ ok: false, error: String(e && e.message || e) }); });
      return;
    }
    cb && cb(null);
  }

  function migrateConfig(c) {
    if (!c.highlights) c.highlights = [];
    return c;
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      store.set(store.key, config); store.set(store.cdnKey, cdnUrl); store.set(store.modeKey, exportMode);
      if (cloud.configured) bg({ type: 'toursSave', tour: { id: config.id, name: config.name, page_url: config.pageUrl || pageKey(), config: config } });
    }, 300);
  }

  // config adjusted for editing: clear the bottom bar and don't lock scrolling while authoring
  function editorVisible() {
    return !!(ED.root && !ED.root.classList.contains('tly-hidden'));
  }

  function mountedConfig() {
    var c = clone(config);
    if (previewActive) {
      c.behavior = Object.assign({}, c.behavior, {
        scrollLock: true,
        pauseOnVideoClick: true,
        startTrigger: 'manual',
        previewTour: true
      });
    } else {
      c.behavior = Object.assign({}, c.behavior, {
        scrollLock: false,
        startTrigger: 'manual',
        previewTour: false
      });
    }
    // raise the preview above the editor bar; sit lower when the footer is hidden (pick / preview)
    c.theme = c.theme || {};
    var ob = (editorVisible() && !pickContext) ? (EDITOR_H + 12) : 12;
    c.theme.video = Object.assign({}, c.theme.video, { offsetBottom: ob });
    return c;
  }

  function refreshPreview() { if (engine) engine.setConfig(mountedConfig()); }

  function mountEngine() {
    if (!config.video.embedUrl) return;
    if (engine) { engine.destroy(); engine = null; }
    // Resolve a direct MP4 so the preview uses our own <video> (no vidzflow play button, frame-accurate).
    resolveVideo(config.video.embedUrl, function (mp4) {
      if (engine) { engine.destroy(); engine = null; }
      engine = window.Tourly.mount(mountedConfig(), { mode: 'edit', previewVideoUrl: mp4 || undefined });
      engine.on('timeupdate', onTime);
      engine.on('ended', onPreviewEnded);
      engine.once('ready', function () { pollDuration(0); });
    });
  }

  // Get the direct MP4 for a vidzflow embed: via the extension background (real use), or the
  // dev server (harness testing). Falls back to the iframe if resolution fails.
  function resolveVideo(embedUrl, cb) {
    if (window.chrome && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage({ type: 'resolveVideo', url: embedUrl }, function (resp) { cb(resp && resp.mp4); });
        return;
      } catch (e) { /* fall through */ }
    }
    try {
      fetch('/resolve?url=' + encodeURIComponent(embedUrl))
        .then(function (r) { return r.json(); })
        .then(function (j) { cb(j && j.mp4); })
        .catch(function () { cb(null); });
    } catch (e) { cb(null); }
  }

  // duration arrives asynchronously from Player.js, so poll until it's known
  function pollDuration(tries) {
    var d = engine ? engine.getDuration() : 0;
    if (d && d > 0) { duration = d; renderTimeline(); renderTabs(); return; }
    if (tries < 40) setTimeout(function () { pollDuration(tries + 1); }, 150);
  }

  // ---- video id parse ----
  function parseVidzflow(url) {
    var m = url.match(/vidzflow\.com\/v\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  // Force our standard params so vidzflow's own controls/play button never show (preview + export).
  function normalizeEmbedUrl(url) {
    try {
      var u = new URL(url, location.href);
      u.searchParams.set('controls', 'false');
      u.searchParams.set('ctp', 'false');
      u.searchParams.set('ap', 'false');
      u.searchParams.set('playsinline', 'true');
      if (!u.searchParams.has('muted')) u.searchParams.set('muted', 'false');
      if (!u.searchParams.has('loop')) u.searchParams.set('loop', 'false');
      return u.toString();
    } catch (e) { return url; }
  }

  // =================== UI ===================
  var PREVIEW_EYE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  var ICON_ADD_TRACK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h13"/><path d="M4 12h13"/><path d="M4 17h9"/><path d="M18 10v6"/><path d="M15 13h6"/></svg>';
  var ICON_SCROLL_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/></svg>';
  var ICON_HIGHLIGHT_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H3v5"/><path d="M16 3h5v5"/><path d="M8 21H3v-5"/><path d="M16 21h5v-5"/></svg>';
  var ICON_SUBTITLE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h12"/><path d="M6 14h8"/></svg>';
  var ICON_AUTO_SUB_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 14a3 3 0 003-3V6a3 3 0 00-6 0v5a3 3 0 003 3z"/><path d="M8 11v1a4 4 0 008 0v-1"/><path d="M12 18v3"/><path d="M8 21h8"/><path d="M18 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2z"/></svg>';

  function labeledIconBtn(className, title, iconHtml, label, onclick) {
    return h('button', {
      class: className + ' tly-btn-labeled',
      title: title,
      html: '<span class="tly-btn-icon" aria-hidden="true">' + iconHtml + '</span><span class="tly-btn-text">' + label + '</span>',
      onclick: onclick
    });
  }

  function build() {
    ED.root = h('div', { id: 'tourly-editor' });

    // slim header: brand + tabs inline (no tour name label)
    ED.cloudNote = h('span', { class: 'tly-cloud', text: cloud.configured ? '☁ synced' : '' });
    ED.tabsBar = h('div', { class: 'tly-tabs' }, ['scroll', 'theme', 'export'].map(function (id) {
      return h('button', { class: 'tly-tab' + (id === activeTab ? ' tly-active' : ''), text: tabLabel(id), 'data-tab': id, onclick: function () { setTab(id); } });
    }));
    ED.head = h('div', { class: 'tly-head' }, [
      h('span', { class: 'tly-brand', html: 'Tour<span>ly</span>' }),
      ED.tabsBar,
      h('span', { class: 'tly-spacer' }),
      ED.cloudNote,
      h('button', { class: 'tly-btn tly-mini', text: 'Change video', onclick: showSetup }),
      h('button', { class: 'tly-close-editor', title: 'Hide editor', text: '×', onclick: function () { API.toggle(); } })
    ]);

    // first-open setup view: add/replace the tour video
    ED.setupUrl = h('input', { class: 'tly-url', placeholder: 'Paste vidzflow embed URL…', value: config.video.embedUrl || '' });
    ED.setupName = h('input', { class: 'tly-name', placeholder: 'Tour name (optional)', value: config.name && config.name !== 'Tour' ? config.name : '' });
    ED.setup = h('div', { class: 'tly-setup' }, [
      h('div', { class: 'tly-setup-card' }, [
        h('div', { class: 'tly-brand tly-setup-brand', html: 'Tour<span>ly</span>' }),
        h('div', { class: 'tly-setup-h', text: 'Add your tour video' }),
        h('div', { class: 'tly-setup-p', text: 'Paste the vidzflow embed link for this page to start building the tour.' }),
        h('div', { class: 'tly-setup-row' }, [ED.setupUrl, ED.setupName,
          h('button', { class: 'tly-btn tly-primary', text: 'Load video', onclick: loadVideo })])
      ])
    ]);

    // panel is only used by Theme / Export (Scroll points + Subtitles use the timeline + bottom editor)
    ED.panel = h('div', { class: 'tly-panel tly-hidden' });

    // timeline + transport (taller track)
    ED.previewBtn = h('button', { class: 'tly-btn tly-mini tly-icon-btn tly-btn-square', title: 'Preview tour from start', html: PREVIEW_EYE_SVG, onclick: startTourPreview });
    ED.playBtn = h('button', { class: 'tly-btn tly-mini tly-btn-square', text: '▶', onclick: togglePlay });
    ED.timeLabel = h('span', { class: 'tly-time', text: '0:00:0 / 0:00:0' });
    // add buttons live in the transport; visibility flips with the active tab
    ED.addPointBtn = labeledIconBtn('tly-btn tly-primary tly-mini', 'Add a scroll point anchored to a page element', ICON_SCROLL_SVG, 'Add scroll point', addElementPoint);
    ED.addSubBtn = labeledIconBtn('tly-btn tly-primary tly-btn-sub tly-mini', 'Add subtitles at the playhead', ICON_SUBTITLE_SVG, 'Add subtitles', addSubtitleManual);
    ED.addHiBtn = labeledIconBtn('tly-btn tly-primary tly-mini tly-hidden tly-btn-hi', 'Add a highlight on a page element', ICON_HIGHLIGHT_SVG, 'Add highlight', addHighlight);
    ED.autoSubBtn = labeledIconBtn('tly-btn tly-btn-sub-outline tly-mini', 'Auto-generate subtitles from video audio', ICON_AUTO_SUB_SVG, 'Auto-generate', autoGenerateSubtitles);
    ED.transcribeStatus = h('span', { class: 'tly-transcribe-status tly-hidden' });
    function closeAddMenu() {
      if (ED.addMenu) {
        ED.addMenu.classList.add('tly-hidden');
        Array.prototype.forEach.call(ED.addMenu.querySelectorAll('.tly-add-menu-flyout-wrap'), function (w) {
          w.classList.remove('tly-add-menu-flyout-open');
        });
        Array.prototype.forEach.call(ED.addMenu.querySelectorAll('.tly-add-menu-flyout'), function (f) {
          f.classList.add('tly-hidden');
        });
      }
      addMenuOpen = false;
    }
    function toggleAddMenu(e) {
      if (e) e.stopPropagation();
      if (!ED.addMenu) return;
      addMenuOpen = !addMenuOpen;
      ED.addMenu.classList.toggle('tly-hidden', !addMenuOpen);
      if (addMenuOpen) positionAddMenu();
      else closeAddMenu();
    }
    function positionAddMenuFlyout(flyout) {
      if (!ED.addMenu || !flyout) return;
      var menuRect = ED.addMenu.getBoundingClientRect();
      flyout.style.left = (menuRect.right + 2) + 'px';
      flyout.style.bottom = (window.innerHeight - menuRect.bottom) + 'px';
      flyout.style.top = 'auto';
    }
    function positionAddMenu() {
      if (!ED.addMenu || !ED.addMenuBtn || ED.addMenu.classList.contains('tly-hidden')) return;
      var r = ED.addMenuBtn.getBoundingClientRect();
      ED.addMenu.style.left = Math.max(8, r.left) + 'px';
      ED.addMenu.style.bottom = (window.innerHeight - r.top + 4) + 'px';
      ED.addMenu.style.top = 'auto';
      var openFlyout = ED.addMenu.querySelector('.tly-add-menu-flyout:not(.tly-hidden)');
      if (openFlyout) positionAddMenuFlyout(openFlyout);
    }
    function addMenuAction(label, cls, iconHtml, fn) {
      return h('button', {
        class: 'tly-add-menu-item' + (cls ? ' ' + cls : ''),
        html: '<span class="tly-add-menu-icon" aria-hidden="true">' + iconHtml + '</span><span class="tly-add-menu-text">' + label + '</span>',
        onclick: function (e) {
          e.stopPropagation();
          closeAddMenu();
          fn();
        }
      });
    }
    function addMenuFlyout(label, cls, iconHtml, actions) {
      var flyout = h('div', { class: 'tly-add-menu-flyout tly-hidden' }, actions);
      var trigger = h('div', {
        class: 'tly-add-menu-item tly-add-menu-flyout-trigger' + (cls ? ' ' + cls : ''),
        html: '<span class="tly-add-menu-icon" aria-hidden="true">' + iconHtml + '</span><span class="tly-add-menu-text">' + label + '</span><span class="tly-add-menu-chevron" aria-hidden="true">›</span>'
      });
      var wrap = h('div', { class: 'tly-add-menu-flyout-wrap' }, [trigger, flyout]);
      var hideTimer = null;
      function showFlyout() {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        wrap.classList.add('tly-add-menu-flyout-open');
        flyout.classList.remove('tly-hidden');
        positionAddMenuFlyout(flyout);
      }
      function scheduleHide() {
        hideTimer = setTimeout(function () {
          hideTimer = null;
          wrap.classList.remove('tly-add-menu-flyout-open');
          flyout.classList.add('tly-hidden');
        }, 150);
      }
      wrap.addEventListener('mouseenter', showFlyout);
      wrap.addEventListener('mouseleave', scheduleHide);
      flyout.addEventListener('mouseenter', showFlyout);
      flyout.addEventListener('mouseleave', scheduleHide);
      return wrap;
    }
    ED.addMenuBtn = labeledIconBtn('tly-btn tly-primary tly-mini', 'Add tour content', ICON_ADD_TRACK_SVG, 'Add', toggleAddMenu);
    ED.addMenu = h('div', { class: 'tly-add-menu tly-hidden' }, [
      addMenuAction('Scroll point', 'tly-add-menu-scroll', ICON_SCROLL_SVG, addElementPoint),
      addMenuAction('Highlight', 'tly-add-menu-hi', ICON_HIGHLIGHT_SVG, addHighlight),
      addMenuFlyout('Subtitles', 'tly-add-menu-sub', ICON_SUBTITLE_SVG, [
        addMenuAction('Auto-generate', 'tly-add-menu-sub-outline', ICON_AUTO_SUB_SVG, autoGenerateSubtitles),
        addMenuAction('Add subtitle', 'tly-add-menu-sub', ICON_SUBTITLE_SVG, addSubtitleManual)
      ])
    ]);
    ED.addMenuWrap = h('div', { class: 'tly-add-menu-wrap' }, [ED.addMenuBtn]);
    ED.transportPlaySpacer = h('span', { class: 'tly-transport-sep tly-transport-play-spacer tly-hidden' });
    ED.transportSep = h('span', { class: 'tly-transport-sep tly-hidden' });
    ED.transportContext = h('div', { class: 'tly-transport-context' }, [ED.addPointBtn, ED.addHiBtn, ED.addSubBtn, ED.autoSubBtn, ED.transcribeStatus]);
    if (!document._tlyAddMenuBound) {
      document._tlyAddMenuBound = true;
      document.addEventListener('mousedown', function (e) {
        if (!addMenuOpen || !ED.addMenuWrap) return;
        if (ED.addMenuWrap.contains(e.target)) return;
        if (ED.addMenu && ED.addMenu.contains(e.target)) return;
        closeAddMenu();
      });
    }
    if (!document._tlyAddMenuResizeBound) {
      document._tlyAddMenuResizeBound = true;
      window.addEventListener('resize', function () {
        if (addMenuOpen) positionAddMenu();
      });
    }
    ED.track = h('div', { class: 'tly-track', onmousedown: onTrackDown }, [
      h('div', { class: 'tly-track-ref' }),
      (ED.trackLabels = h('div', { class: 'tly-track-labels' }))
    ]);
    ED.playheadLine = h('div', { class: 'tly-playhead-line', style: { left: '0px' } });
    ED.playhead = h('div', { class: 'tly-playhead', style: { left: '0px' }, onmousedown: onPlayheadDown }, [
      h('div', { class: 'tly-playhead-knob' })
    ]);
    ED.trackWrap = h('div', { class: 'tly-track-wrap' }, [ED.track, ED.playheadLine, ED.playhead]);
    ED.timeWrap = h('div', { class: 'tly-timeline-wrap' }, [
      h('div', { class: 'tly-transport' }, [
        h('div', { class: 'tly-transport-left' }, [ED.playBtn, ED.previewBtn, ED.transportPlaySpacer, ED.addMenuWrap, ED.transportSep, ED.transportContext])
      ]),
      ED.trackWrap,
      ED.timeLabel
    ]);

    // selected scroll-point / subtitle editor (BELOW the timeline)
    ED.pointEditorBody = h('div', { class: 'tly-point-editor-body' });
    ED.pointEditor = h('div', { class: 'tly-point-editor tly-hidden' }, [ED.pointEditorBody]);

    ED.editorBody = h('div', { class: 'tly-editor-body' }, [ED.panel, ED.timeWrap, ED.pointEditor]);

    // backdrop that blocks clicks to the page behind the expanded (theme/export) overlay
    ED.backdrop = h('div', { id: 'tly-backdrop', class: 'tly-hidden', onclick: function () { setTab('scroll'); } });

    document.body.appendChild(ED.backdrop);
    document.body.appendChild(ED.addMenu);
    ED.root.appendChild(ED.head);
    ED.root.appendChild(ED.setup);
    ED.root.appendChild(ED.editorBody);
    document.body.appendChild(ED.root);

    // pick overlay
    ED.pickOverlay = h('div', { id: 'tly-pick-overlay' });
    document.body.appendChild(ED.pickOverlay);

    document.addEventListener('keydown', onKeyDown, true);
    bindTrackCueHover();
    renderMode();
  }

  function setTab(id) {
    activeTab = id;
    var expand = !!EXPAND_TABS[id];
    ED.root.classList.toggle('tly-expanded', expand);
    ED.backdrop.classList.toggle('tly-hidden', !expand);
    renderTimeline();      // scroll↔subtitle timeline layout depends on the active tab
    renderTabs();
    renderBottomEditor();
  }

  function bootstrapDefaultScroll() {
    if (activeTab !== 'scroll') return;
    if (selectedPointId || selectedHighlightId || selectedCueId) return;
    if (config.scrollPoints.length > 0) selectPoint(config.scrollPoints[0].id);
    else {
      setFocusedLane('scroll');
      applyMotionLaneLayout();
      renderBottomEditor();
      updateTransportActions();
    }
  }

  // the area below the timeline edits the selected scroll point, highlight, or subtitle.
  function clearPointEditorBody() {
    if (ED.pointEditorBody) ED.pointEditorBody.innerHTML = '';
  }

  function renderBottomEditor() {
    if (!ED.pointEditor) return;
    if (activeTab === 'theme' || activeTab === 'export') {
      ED.pointEditor.classList.add('tly-hidden');
      clearPointEditorBody();
      return;
    }
    if (selectedCueId) renderCueEditor();
    else if (selectedHighlightId) renderHighlightEditor();
    else if (selectedPointId) renderPointEditor();
    else if (focusedLane === 'scroll') renderBottomPlaceholder('Scroll section — use Add scroll point to add one.');
    else if (focusedLane === 'highlight') renderBottomPlaceholder('Highlight section — use Add highlight to add one.');
    else if (focusedLane === 'subtitle') renderBottomPlaceholder('Subtitles section — use Add subtitles or Auto-generate.');
    else renderBottomPlaceholder('Select scroll, highlight, or subtitle on the timeline — or use the add buttons above.');
  }

  function renderBottomPlaceholder(msg) {
    if (!ED.pointEditor || !ED.pointEditorBody) return;
    ED.pointEditor.classList.remove('tly-hidden');
    clearPointEditorBody();
    ED.pointEditorBody.appendChild(h('div', { class: 'tly-pe-row tly-pe-empty' }, [
      h('span', { class: 'tly-pe-placeholder', text: msg })
    ]));
  }

  // Toggle between the setup view (no video yet) and the editor body.
  function renderMode() {
    var hasVideo = !!config.video.embedUrl;
    ED.setup.classList.toggle('tly-hidden', hasVideo);
    ED.editorBody.classList.toggle('tly-hidden', !hasVideo);
    ED.head.classList.toggle('tly-hidden', !hasVideo);   // hide slim header during setup (card has its own brand)
    ED.root.classList.toggle('tly-setup-mode', !hasVideo);
    if (!hasVideo) { ED.root.classList.remove('tly-expanded'); ED.backdrop.classList.add('tly-hidden'); }
    if (hasVideo) { renderTimeline(); renderTabs(); renderBottomEditor(); bootstrapDefaultScroll(); }
  }

  function showSetup() {
    ED.setupUrl.value = config.video.embedUrl || '';
    ED.setupName.value = config.name && config.name !== 'Tour' ? config.name : '';
    ED.setup.classList.remove('tly-hidden');
    ED.editorBody.classList.add('tly-hidden');
    ED.head.classList.add('tly-hidden');
    ED.root.classList.add('tly-setup-mode');
  }

  function tabLabel(id) {
    return { scroll: 'Motion', theme: 'Theme', export: 'Export' }[id];
  }

  // ---- video load ----
  function loadVideo() {
    var url = ED.setupUrl.value.trim();
    if (!url) return;
    config.video.embedUrl = normalizeEmbedUrl(url);
    config.video.videoId = parseVidzflow(url);
    if (ED.setupName.value.trim()) config.name = ED.setupName.value.trim();
    save();
    renderMode();      // reveal the editor body
    mountEngine();
  }

  // ---- transport ----

  function hideEditorUI(hidePreview) {
    if (pickContext) stopPick();
    if (previewActive && hidePreview) stopTourPreview(true);
    ED.root.classList.add('tly-hidden');
    if (ED.backdrop) ED.backdrop.classList.add('tly-hidden');
    refreshPreview();
    if (hidePreview && engine) engine.setPreviewVisible(false);
  }

  function showEditorUI() {
    if (previewActive) stopTourPreview(true);
    ED.root.classList.remove('tly-hidden');
    refreshPreview();
    if (engine) {
      engine.setPreviewVisible(true);
      if (engine.state === 'playing') engine.pause();
      if (ED.playBtn) ED.playBtn.textContent = '▶';
    }
  }

  function showModeChrome(kind, text) {
    if (!ED.modeFrame) {
      ED.modeFrame = h('div', { id: 'tly-mode-frame', class: 'tly-hidden' });
      document.body.appendChild(ED.modeFrame);
    }
    var frameKind = kind.indexOf('pick') === 0 ? 'pick' : kind;
    ED.modeFrame.className = 'tly-mode-frame tly-mode-frame-' + frameKind;
    if (ED.banner) { ED.banner.remove(); ED.banner = null; }
    ED.banner = h('div', { id: 'tly-mode-banner', class: 'tly-mode-banner tly-mode-banner-' + kind, text: text });
    document.body.appendChild(ED.banner);
  }

  function hideModeChrome() {
    if (ED.modeFrame) ED.modeFrame.className = 'tly-mode-frame tly-hidden';
    if (ED.banner) { ED.banner.remove(); ED.banner = null; }
  }

  function stopTourPreview(pausePlayback) {
    if (!previewActive) return;
    previewActive = false;
    document.documentElement.classList.remove('tly-previewing');
    document.removeEventListener('keydown', previewKey, true);
    hideModeChrome();
    if (engine) {
      if (pausePlayback && engine.state === 'playing') engine.pause();
      refreshPreview();
    }
    if (ED.playBtn) ED.playBtn.textContent = '▶';
  }

  function previewKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      showEditorUI();
      return;
    }
    if ((e.key === ' ' || e.key === 'Spacebar') && previewActive && engine) {
      e.preventDefault();
      engine.toggle();
      updatePreviewBanner();
    }
  }

  function updatePreviewBanner() {
    if (!ED.banner || !previewActive || !engine) return;
    var playing = engine.state === 'playing';
    ED.banner.textContent = (playing ? 'Previewing · scroll to pause' : 'Paused · click video or Resume to continue') + ' · Esc for editor';
  }

  function startTourPreview() {
    if (!engine) return;
    previewActive = true;
    hideEditorUI(false);
    document.documentElement.classList.add('tly-previewing');
    showModeChrome('preview', 'Previewing · scroll to pause · Esc for editor');
    document.addEventListener('keydown', previewKey, true);
    refreshPreview();
    engine.setPreviewVisible(true);
    engine.seek(0);
    engine.play();
    updatePreviewBanner();
    if (engine._listeners && !engine._previewStateHook) {
      engine._previewStateHook = true;
      engine.on('statechange', updatePreviewBanner);
      engine.on('pause', updatePreviewBanner);
      engine.on('play', updatePreviewBanner);
    }
    if (ED.playBtn) ED.playBtn.textContent = '❚❚';
  }

  function onPreviewEnded() {
    if (!previewActive) return;
    showEditorUI();
  }

  function togglePlay() { if (!engine) return; engine.toggle(); ED.playBtn.textContent = engine.state === 'playing' ? '❚❚' : '▶'; }

  function trackScrubMetrics() {
    var r = ED.track.getBoundingClientRect();
    var cs = window.getComputedStyle(ED.track);
    var borderL = parseFloat(cs.borderLeftWidth) || 0;
    var borderR = parseFloat(cs.borderRightWidth) || 0;
    var contentW = Math.max(0, r.width - borderL - borderR);
    return { rect: r, borderL: borderL, borderR: borderR, contentW: contentW };
  }

  function startScrub(clientX) {
    if (!engine || !duration || !ED.track) return;
    var now0 = (performance && performance.now) ? performance.now() : Date.now();
    if (now0 < playheadScrubLockedUntil) return;
    if (engine.state === 'playing') {
      engine.pause();
      if (ED.playBtn) ED.playBtn.textContent = '▶';
    }
    function seekAt(cx, force) {
      var m = trackScrubMetrics();
      var ratio = m.contentW ? clamp((cx - m.rect.left - m.borderL) / m.contentW, 0, 1) : 0;
      var t = ratio * duration;
      updatePlayhead(t);
      var now = (performance && performance.now) ? performance.now() : Date.now();
      if (force || now - lastScrubAt > 55) { lastScrubAt = now; engine.seek(t); }
    }
    seekAt(clientX, true);
    function move(ev) { seekAt(ev.clientX, false); }
    function up(ev) {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      seekAt(ev.clientX, true);
      playheadScrubLockedUntil = (performance && performance.now ? performance.now() : Date.now()) + PLAYHEAD_SCRUB_COOLDOWN_MS;
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  function onPlayheadDown(e) {
    e.preventDefault();
    e.stopPropagation();
    startScrub(e.clientX);
  }

  // Press to seek, drag to scrub. The playhead only moves on click/drag (or playback) — never on hover.
  function onTrackDown(e) {
    if (e.target.classList.contains('tly-marker')) return;   // markers handle their own drag
    if (e.target.closest && e.target.closest('.tly-playhead')) return;
    if (!engine || !duration) return;
    e.preventDefault();
    startScrub(e.clientX);
  }
  function onTime(t) {
    var d = engine && engine.getDuration();
    if (d && d !== duration) { duration = d; renderTimeline(); }
    updatePlayhead(t);
    if (ED.playBtn) ED.playBtn.textContent = engine && engine.state === 'playing' ? '❚❚' : '▶';
  }
  function updatePlayhead(t) {
    if (!ED.track || !ED.playhead) return;
    var m = trackScrubMetrics();
    var ratio = duration ? clamp(t / duration, 0, 1) : 0;
    var lineX = ratio * m.contentW;
    var wrapX = m.borderL + lineX;
    var atStart = ratio <= 0.001;
    var atEnd = ratio >= 0.999;
    if (ED.playheadLine) {
      ED.playheadLine.style.left = wrapX + 'px';
      ED.playheadLine.classList.toggle('tly-playhead-at-start', atStart);
      ED.playheadLine.classList.toggle('tly-playhead-at-end', atEnd);
    }
    ED.playhead.style.left = wrapX + 'px';
    ED.playhead.classList.toggle('tly-playhead-at-start', atStart);
    ED.playhead.classList.toggle('tly-playhead-at-end', atEnd);
    ED.timeLabel.textContent = fmt(t) + ' / ' + fmt(duration);
  }

  var CUE_MIN_DUR = 0.1, CUE_SNAP_SEC = 0.15, CUE_ADJ_EPS = 0.05;
  var CUE_EDGE_IN = 30, CUE_MOVE_MIN = 22;
  var DEFAULT_SCROLL_EASE = 0.8;
  var LABEL_MIN_PX = 44;
  var PREVIEW_MIN_PX = 18;

  function compactPreviewText(text, max) {
    max = max || 14;
    text = (text || '').trim();
    if (!text) return '';
    return text.length <= max ? text : text.slice(0, max - 1) + '\u2026';
  }

  function setFocusedLane(lane) {
    if (lane) lastFocusedLane = lane;
    focusedLane = lane;
  }

  function syncBarLabel(el, widthPx) {
    if (!el) return;
    var label = el.querySelector('.tly-marker-label, .tly-hi-label, .tly-cue-label');
    var preview = el.querySelector('.tly-bar-preview');
    if (widthPx == null) widthPx = el.getBoundingClientRect().width;
    if (label) label.classList.toggle('tly-label-hidden', widthPx < LABEL_MIN_PX);
    if (preview) preview.classList.toggle('tly-label-hidden', widthPx < PREVIEW_MIN_PX);
  }

  function scrollPointDuration(p) {
    return (p && p.ease != null && p.ease >= 0) ? p.ease : DEFAULT_SCROLL_EASE;
  }

  function scrollPointEnd(p) {
    return p.time + scrollPointDuration(p);
  }

  function layoutScrollPointEl(p, el, trackWidth) {
    if (!p || !el) return;
    var w = trackWidth != null ? trackWidth : ED.track.getBoundingClientRect().width;
    var x1 = clamp(p.time / duration, 0, 1) * w;
    var x2 = clamp(scrollPointEnd(p) / duration, 0, 1) * w;
    el.style.left = x1 + 'px';
    el.style.width = Math.max(2, x2 - x1) + 'px';
    syncBarLabel(el, Math.max(2, x2 - x1));
    var ptName = isElementPoint(p) ? displayNameForTarget(p.target) : 'Scroll point';
    el.title = ptName + ' @ ' + fmt(p.time) + ' · ' + fmt(scrollPointDuration(p)) + 's';
  }

  // ---- timeline markers ----
  // Motion timeline: scroll, highlight, and subtitle lanes share one track with contextual heights.
  function isElementPoint(p) {
    return !!(p && p.target && p.target.mode === 'element' && p.target.selector);
  }

  var MOTION_COMPACT_LANE = 12;

  function motionLaneList() {
    var lanes = [];
    if (config.scrollPoints.length > 0) lanes.push('scroll');
    if (config.highlights.length > 0) lanes.push('highlight');
    if (config.subtitles.length > 0) lanes.push('subtitle');
    return lanes;
  }

  function laneBarBounds(name, b) {
    if (!b) return b;
    var lanes = motionLaneList();
    var idx = lanes.indexOf(name);
    if (idx < 0) return b;
    var top = b.top;
    var height = b.height;
    if (idx === lanes.length - 1 && height > 1) height -= 1;
    return { top: top, height: height };
  }

  function laneBgBounds(name, b) {
    if (!b) return b;
    var lanes = motionLaneList();
    var idx = lanes.indexOf(name);
    if (idx < 0) return b;
    var top = b.top;
    var height = b.height;
    if (idx === lanes.length - 1 && height > 1) height -= 1;
    return { top: top, height: height };
  }

  function trackSectionCount(hasScrolls, hasHighlights, hasSubtitles) {
    var n = 0;
    if (hasScrolls) n++;
    if (hasHighlights) n++;
    if (hasSubtitles) n++;
    return n;
  }

  function computeMotionLaneBounds(trackHeight, focus) {
    var lanes = motionLaneList();
    if (!lanes.length) return {};
    var H = Math.round(trackHeight || 62);
    var compact = MOTION_COMPACT_LANE;
    var focusIdx = focus ? lanes.indexOf(focus) : -1;
    var heights;
    if (focusIdx < 0) {
      var base = Math.floor(H / lanes.length);
      var rem = H - base * lanes.length;
      heights = lanes.map(function (_, i) { return base + (i < rem ? 1 : 0); });
    } else {
      var expanded = H - compact * (lanes.length - 1);
      heights = lanes.map(function (_, i) { return i === focusIdx ? expanded : compact; });
    }
    var bounds = {};
    var y = 0;
    lanes.forEach(function (name, i) {
      bounds[name] = { top: y, height: heights[i] };
      y += heights[i];
    });
    return bounds;
  }

  function motionFocusLane() {
    if (activeTab !== 'scroll') return null;
    if (draggingMarker) return 'scroll';
    if (draggingHighlight) return 'highlight';
    if (draggingCue) return 'subtitle';
    if (selectedPointId) return 'scroll';
    if (selectedHighlightId) return 'highlight';
    if (selectedCueId) return 'subtitle';
    if (focusedLane) return focusedLane;
    var lanes = motionLaneList();
    if (lastFocusedLane && lanes.indexOf(lastFocusedLane) >= 0) return lastFocusedLane;
    return lanes.length ? lanes[0] : null;
  }

  function motionEditLane() {
    if (activeTab !== 'scroll') return null;
    if (draggingMarker) return 'scroll';
    if (draggingHighlight) return 'highlight';
    if (draggingCue) return 'subtitle';
    if (selectedPointId) return 'scroll';
    if (selectedHighlightId) return 'highlight';
    if (selectedCueId) return 'subtitle';
    if (focusedLane) return focusedLane;
    if (lastFocusedLane) return lastFocusedLane;
    return 'scroll';
  }

  function ensureLaneStripes() {
    if (!ED.track) return;
    if (ED.track._laneStripes) return;
    ED.track._laneStripes = {};
    ['scroll', 'highlight', 'subtitle'].forEach(function (name) {
      var stripe = h('div', { class: 'tly-lane-stripe tly-lane-stripe-' + name });
      ED.track.insertBefore(stripe, ED.track.firstChild);
      ED.track._laneStripes[name] = stripe;
    });
  }

  function updateLaneStripes(bounds) {
    ensureLaneStripes();
    if (!ED.track || !ED.track._laneStripes) return;
    ['scroll', 'highlight', 'subtitle'].forEach(function (name) {
      var stripe = ED.track._laneStripes[name];
      var b = bounds[name];
      if (!stripe) return;
      if (b) {
        stripe.classList.add('tly-lane-stripe-visible');
        stripe.style.removeProperty('top');
        stripe.style.removeProperty('height');
      } else {
        stripe.classList.remove('tly-lane-stripe-visible');
        stripe.style.removeProperty('top');
        stripe.style.removeProperty('height');
      }
    });
  }

  function ensureLaneHits() {
    if (!ED.track) return;
    if (ED.track._laneHits) return;
    ED.track._laneHits = {};
    ['scroll', 'highlight', 'subtitle'].forEach(function (name) {
      var hit = h('div', { class: 'tly-lane-hit tly-lane-hit-' + name });
      hit.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        focusCompactLane(name);
      });
      hit.addEventListener('mouseenter', function () {
        if (ED.track && ED.track.classList.contains('tly-lane-compact-' + name)) {
          ED.track.classList.add('tly-lane-hover-' + name);
        }
      });
      hit.addEventListener('mouseleave', function () {
        if (ED.track) ED.track.classList.remove('tly-lane-hover-' + name);
      });
      ED.track.insertBefore(hit, ED.track.firstChild);
      ED.track._laneHits[name] = hit;
    });
  }

  function updateLaneHits(bounds, focus) {
    ensureLaneHits();
    if (!ED.track || !ED.track._laneHits) return;
    ['scroll', 'highlight', 'subtitle'].forEach(function (name) {
      var hit = ED.track._laneHits[name];
      var b = bounds[name];
      var isCompact = !!(focus && b && b.height <= MOTION_COMPACT_LANE + 0.5);
      if (!hit) return;
      ED.track.classList.remove('tly-lane-hover-' + name);
      if (b) {
        hit.classList.add('tly-lane-hit-visible');
        hit.style.removeProperty('top');
        hit.style.removeProperty('height');
        if (isCompact) {
          hit.classList.add('tly-lane-hit-active');
          hit.title = LANE_HIT_TITLES[name];
        } else {
          hit.classList.remove('tly-lane-hit-active');
          hit.title = '';
        }
      } else {
        hit.classList.remove('tly-lane-hit-visible', 'tly-lane-hit-active');
        hit.style.removeProperty('top');
        hit.style.removeProperty('height');
        hit.title = '';
      }
    });
  }

  function focusCompactLane(lane) {
    if (!lane || !isLaneCompact(lane)) return;
    selectedPointId = null;
    selectedHighlightId = null;
    selectedCueId = null;
    setFocusedLane(lane);
    Array.prototype.forEach.call(ED.track.querySelectorAll('.tly-marker,.tly-hi,.tly-cue'), function (m) {
      m.classList.remove('tly-selected');
    });
    applyMotionLaneLayout();
    renderBottomEditor();
  }

  function bindCompactLaneHover(el, lane) {
    el.addEventListener('mouseenter', function () {
      if (isLaneCompact(lane) && ED.track) ED.track.classList.add('tly-lane-hover-' + lane);
    });
    el.addEventListener('mouseleave', function () {
      if (ED.track) ED.track.classList.remove('tly-lane-hover-' + lane);
    });
  }

  function applyMotionLaneLayout() {
    if (!ED.track) return;
    if (activeTab !== 'scroll') {
      ED.track.classList.remove('tly-focus-scroll', 'tly-focus-highlight', 'tly-focus-subtitle', 'tly-lane-split-a', 'tly-lane-split-b', 'tly-lane-compact-scroll', 'tly-lane-compact-highlight', 'tly-lane-compact-subtitle');
      ['scroll', 'highlight', 'subtitle'].forEach(function (name) {
        ED.track.classList.remove('tly-lane-hover-' + name);
        ED.track.style.removeProperty('--tly-lane-' + name + '-top');
        ED.track.style.removeProperty('--tly-lane-' + name + '-bottom');
        ED.track.style.removeProperty('--tly-lane-' + name + '-height');
        if (ED.track._laneHits && ED.track._laneHits[name]) {
          var hit = ED.track._laneHits[name];
          hit.classList.remove('tly-lane-hit-active');
          hit.style.top = '';
          hit.style.height = '';
          hit.title = '';
        }
        if (ED.track._laneStripes && ED.track._laneStripes[name]) {
          var stripe = ED.track._laneStripes[name];
          stripe.classList.remove('tly-lane-stripe-visible');
          stripe.style.top = '';
          stripe.style.height = '';
        }
      });
      ED.track.style.removeProperty('--tly-split-a');
      ED.track.style.removeProperty('--tly-split-b');
      return;
    }
    var focus = motionFocusLane();
    ED.track.classList.toggle('tly-focus-scroll', focus === 'scroll');
    ED.track.classList.toggle('tly-focus-highlight', focus === 'highlight');
    ED.track.classList.toggle('tly-focus-subtitle', focus === 'subtitle');
    var H = ED.track.getBoundingClientRect().height || 62;
    var bounds = computeMotionLaneBounds(H, focus);
    var lanes = motionLaneList();
    ['scroll', 'highlight', 'subtitle'].forEach(function (name) {
      var prefix = '--tly-lane-' + name;
      var b = bounds[name];
      var isCompact = !!(focus && b && b.height <= MOTION_COMPACT_LANE + 0.5);
      ED.track.classList.toggle('tly-lane-compact-' + name, isCompact);
      if (b) {
        var v = laneBarBounds(name, b);
        ED.track.style.setProperty(prefix + '-top', v.top + 'px');
        ED.track.style.setProperty(prefix + '-height', v.height + 'px');
        ED.track.style.removeProperty(prefix + '-bottom');
      } else {
        ED.track.style.removeProperty(prefix + '-top');
        ED.track.style.removeProperty(prefix + '-bottom');
        ED.track.style.removeProperty(prefix + '-height');
      }
    });
    ED.track.classList.toggle('tly-lane-split-a', lanes.length >= 2);
    ED.track.classList.toggle('tly-lane-split-b', lanes.length >= 3);
    if (lanes.length >= 2 && bounds[lanes[0]]) {
      ED.track.style.setProperty('--tly-split-a', Math.round(bounds[lanes[0]].top + bounds[lanes[0]].height) + 'px');
    } else ED.track.style.removeProperty('--tly-split-a');
    if (lanes.length >= 3 && bounds[lanes[1]]) {
      ED.track.style.setProperty('--tly-split-b', Math.round(bounds[lanes[1]].top + bounds[lanes[1]].height) + 'px');
    } else ED.track.style.removeProperty('--tly-split-b');
    if (!ED.track._tlyLaneAnimate) {
      ED.track._tlyLaneAnimate = true;
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (ED.track) ED.track.classList.add('tly-lane-animate');
        });
      });
    }
    updateLaneStripes(bounds);
    updateLaneHits(bounds, focus);
    syncTrackLabelContrast();
    updateTransportActions();
  }

  function trackLabelLane(label) {
    if (label.classList.contains('tly-label-scroll')) return 'scroll';
    if (label.classList.contains('tly-label-highlight')) return 'highlight';
    if (label.classList.contains('tly-label-sub')) return 'subtitle';
    return null;
  }

  function itemLane(el) {
    if (el.classList.contains('tly-marker') || el.classList.contains('tly-marker-edit')) return 'scroll';
    if (el.classList.contains('tly-hi') || el.classList.contains('tly-hi-edit')) return 'highlight';
    if (el.classList.contains('tly-cue') || el.classList.contains('tly-cue-edit')) return 'subtitle';
    return null;
  }

  function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function itemVisibleLabelEl(el) {
    if (!ED.track || !el) return null;
    if (el.classList.contains('tly-marker-edit') && ED.track.classList.contains('tly-lane-compact-scroll')) {
      var sp = el.querySelector('.tly-bar-preview');
      if (sp && !sp.classList.contains('tly-label-hidden') && (sp.textContent || '').trim()) return sp;
      return null;
    }
    if (el.classList.contains('tly-hi-edit') && ED.track.classList.contains('tly-lane-compact-highlight')) {
      var hp = el.querySelector('.tly-bar-preview');
      if (hp && !hp.classList.contains('tly-label-hidden') && (hp.textContent || '').trim()) return hp;
      return null;
    }
    if (el.classList.contains('tly-cue-edit') && ED.track.classList.contains('tly-lane-compact-subtitle')) {
      var cp = el.querySelector('.tly-bar-preview');
      if (cp && !cp.classList.contains('tly-label-hidden') && (cp.textContent || '').trim()) return cp;
      return null;
    }
    var label = el.querySelector('.tly-marker-label, .tly-hi-label, .tly-cue-label');
    if (!label || label.classList.contains('tly-label-hidden')) return null;
    if (!(label.textContent || '').trim()) return null;
    return label;
  }

  function syncTrackLabelContrast() {
    if (!ED.trackLabels || !ED.track) return;
    var labels = ED.trackLabels.querySelectorAll('.tly-track-label');
    var items = ED.track.querySelectorAll('.tly-marker, .tly-cue, .tly-hi');
    labels.forEach(function (label) {
      var labelLane = trackLabelLane(label);
      var lr = label.getBoundingClientRect();
      var overlapWithText = false;
      var overlapWithoutText = false;
      for (var i = 0; i < items.length; i++) {
        if (labelLane && itemLane(items[i]) !== labelLane) continue;
        var ir = items[i].getBoundingClientRect();
        if (ir.width <= 0 || ir.height <= 0) continue;
        if (!rectsOverlap(lr, ir)) continue;
        var visibleLabel = itemVisibleLabelEl(items[i]);
        if (visibleLabel) {
          var vr = visibleLabel.getBoundingClientRect();
          if (vr.width > 0 && vr.height > 0 && rectsOverlap(lr, vr)) overlapWithText = true;
          else overlapWithoutText = true;
        } else {
          overlapWithoutText = true;
        }
      }
      label.classList.toggle('tly-label-hidden', overlapWithText);
      label.classList.toggle('tly-track-label-overlap', !overlapWithText && overlapWithoutText);
    });
  }

  function renderTrackLabels(motionMode, hasScrolls, hasHighlights, hasSubtitles) {
    if (!ED.trackLabels) return;
    ED.trackLabels.innerHTML = '';
    if (!motionMode) return;
    if (hasScrolls) ED.trackLabels.appendChild(h('span', { class: 'tly-track-label tly-label-scroll', text: 'Scroll' }));
    if (hasHighlights) ED.trackLabels.appendChild(h('span', { class: 'tly-track-label tly-label-highlight', text: 'Highlight' }));
    if (hasSubtitles) ED.trackLabels.appendChild(h('span', { class: 'tly-track-label tly-label-sub', text: 'Subtitles' }));
  }

  function renderTimeline() {
    if (!ED.track) return;
    var motionMode = activeTab === 'scroll';
    var hasHighlights = config.highlights.length > 0;
    var hasScrolls = config.scrollPoints.length > 0;
    var hasSubtitles = config.subtitles.length > 0;
    ED.track.classList.toggle('tly-scroll-mode', motionMode);
    ED.track.classList.toggle('tly-has-highlights', hasHighlights);
    ED.track.classList.toggle('tly-has-scrolls', hasScrolls);
    ED.track.classList.toggle('tly-has-subtitles', hasSubtitles);
    applyMotionLaneLayout();
    var sectionCount = trackSectionCount(hasScrolls, hasHighlights, hasSubtitles);
    ED.track.classList.toggle('tly-track-labels-centered', motionMode && sectionCount >= 1);
    renderTrackLabels(motionMode, hasScrolls, hasHighlights, hasSubtitles);
    hideDropIndicator();
    clearDropHighlight();
    clearCueHover();
    Array.prototype.slice.call(ED.track.querySelectorAll('.tly-marker,.tly-cue,.tly-hi')).forEach(function (n) { n.remove(); });
    if (!duration) return;
    var w = ED.track.getBoundingClientRect().width;
    config.scrollPoints.forEach(function (p) {
      var cls = 'tly-marker tly-el' + (isElementPoint(p) ? '' : ' tly-needs-pick');
      if (motionMode) cls += ' tly-marker-edit';
      if (motionMode && p.id === selectedPointId) cls += ' tly-selected';
      var el = h('div', { class: cls, 'data-id': p.id, style: { left: '0px', width: '2px' } });
      layoutScrollPointEl(p, el, w);
      if (motionMode) {
        el.appendChild(h('span', { class: 'tly-marker-label', text: isElementPoint(p) ? displayNameForTarget(p.target) : 'Scroll' }));
        el.appendChild(h('span', { class: 'tly-bar-preview', text: compactPreviewText(isElementPoint(p) ? displayNameForTarget(p.target) : 'Scroll') }));
        el.appendChild(h('div', { class: 'tly-marker-h tly-marker-hl' }));
        el.appendChild(h('div', { class: 'tly-marker-h tly-marker-hr' }));
        bindScrollPointInteractions(p, el);
        bindCompactLaneHover(el, 'scroll');
        syncBarLabel(el, Math.max(2, clamp(scrollPointEnd(p) / duration, 0, 1) * w - clamp(p.time / duration, 0, 1) * w));
      } else if (activeTab !== 'theme' && activeTab !== 'export') {
        el.addEventListener('click', function (e) { e.stopPropagation(); selectPoint(p.id); engine && engine.seek(p.time); });
      }
      ED.track.appendChild(el);
    });
    config.subtitles.slice().sort(subtitleRenderOrder).forEach(function (c) {
      var x1 = clamp(c.start / duration, 0, 1) * w, x2 = clamp(c.end / duration, 0, 1) * w;
      var isAuto = c.source === 'auto';
      var cls = 'tly-cue' + (isAuto ? ' tly-cue-auto' : ' tly-cue-manual') + (motionMode ? ' tly-cue-edit' : '') + (motionMode && c.id === selectedCueId ? ' tly-selected' : '');
      var cue = h('div', { class: cls, 'data-id': c.id, title: c.text, style: { left: x1 + 'px', width: Math.max(2, x2 - x1) + 'px' } });
      if (motionMode) {
        cue.appendChild(h('span', { class: 'tly-cue-label', text: c.text }));
        cue.appendChild(h('span', { class: 'tly-bar-preview', text: compactPreviewText(c.text) }));
        cue.appendChild(h('div', { class: 'tly-cue-h tly-cue-hl' }));
        cue.appendChild(h('div', { class: 'tly-cue-h tly-cue-hr' }));
        bindCueInteractions(c, cue);
        bindCompactLaneHover(cue, 'subtitle');
        syncBarLabel(cue, Math.max(2, x2 - x1));
      }
      ED.track.appendChild(cue);
    });
    config.highlights.slice().sort(function (a, b) { return a.start - b.start; }).forEach(function (hl) {
      var x1 = clamp(hl.start / duration, 0, 1) * w, x2 = clamp(hl.end / duration, 0, 1) * w;
      var cls = 'tly-hi' + (motionMode ? ' tly-hi-edit' : '') + (motionMode && hl.id === selectedHighlightId ? ' tly-selected' : '');
      var label = isElementTarget(hl.target) ? displayNameForTarget(hl.target) : 'Highlight';
      var hi = h('div', { class: cls, 'data-id': hl.id, title: label, style: { left: x1 + 'px', width: Math.max(2, x2 - x1) + 'px' } });
      if (motionMode) {
        hi.appendChild(h('span', { class: 'tly-hi-label', text: label }));
        hi.appendChild(h('span', { class: 'tly-bar-preview', text: compactPreviewText(label) }));
        hi.appendChild(h('div', { class: 'tly-hi-h tly-hi-hl' }));
        hi.appendChild(h('div', { class: 'tly-hi-h tly-hi-hr' }));
        bindHighlightInteractions(hl, hi);
        bindCompactLaneHover(hi, 'highlight');
        syncBarLabel(hi, Math.max(2, x2 - x1));
      }
      ED.track.appendChild(hi);
    });
    requestAnimationFrame(syncTrackLabelContrast);
  }

  function isElementTarget(target) {
    return !!(target && target.mode === 'element' && target.selector);
  }

  function sortedScrollPointsChron() {
    return config.scrollPoints.slice().sort(function (a, b) { return a.time - b.time; });
  }

  function scrollPointNeighbors(p) {
    var all = sortedScrollPointsChron();
    var i = -1;
    for (var j = 0; j < all.length; j++) { if (all[j].id === p.id) { i = j; break; } }
    return {
      prev: i > 0 ? all[i - 1] : null,
      next: i >= 0 && i < all.length - 1 ? all[i + 1] : null
    };
  }

  function scrollPointsAdjacent(before, after) {
    return before && after && Math.abs(scrollPointEnd(before) - after.time) <= CUE_ADJ_EPS;
  }

  function scrollPointStartBounds(p, prev, linkedPrev) {
    var minT = 0, maxT = scrollPointEnd(p) - CUE_MIN_DUR;
    if (linkedPrev && prev) minT = prev.time + CUE_MIN_DUR;
    else if (prev) minT = scrollPointEnd(prev);
    if (maxT < minT) maxT = minT;
    return { minT: minT, maxT: maxT };
  }

  function scrollPointEndBounds(p, next, linkedNext) {
    var minT = p.time + CUE_MIN_DUR, maxT = duration;
    if (linkedNext && next) maxT = scrollPointEnd(next) - CUE_MIN_DUR;
    else if (next) maxT = next.time;
    if (maxT < minT) maxT = minT;
    return { minT: minT, maxT: maxT };
  }

  function applyScrollResizeStart(p, ns, prev, linkedPrev) {
    var end0 = scrollPointEnd(p);
    var b = scrollPointStartBounds(p, prev, linkedPrev);
    ns = applySnappedTime(ns, p.id, b.minT, b.maxT);
    p.time = ns;
    p.ease = +(end0 - ns).toFixed(2);
    if (linkedPrev && prev) {
      var boundary = clamp(p.time, prev.time + CUE_MIN_DUR, end0 - CUE_MIN_DUR);
      boundary = +boundary.toFixed(2);
      prev.ease = +(boundary - prev.time).toFixed(2);
      p.time = boundary;
      p.ease = +(end0 - boundary).toFixed(2);
    }
  }

  function applyScrollResizeEnd(p, ne, next, linkedNext) {
    var b = scrollPointEndBounds(p, next, linkedNext);
    ne = applySnappedTime(ne, p.id, b.minT, b.maxT);
    p.ease = +(ne - p.time).toFixed(2);
    if (linkedNext && next) {
      var boundary = clamp(ne, p.time + CUE_MIN_DUR, scrollPointEnd(next));
      boundary = +boundary.toFixed(2);
      p.ease = +(boundary - p.time).toFixed(2);
      next.time = boundary;
    }
  }

  function applyScrollMove(p, nt, len) {
    var span = applySnappedMove(nt, len, p.id, 0, duration - len);
    p.time = span.start;
    p.ease = +(span.end - span.start).toFixed(2);
  }

  function computeScrollDropSlot(rawStart, item, len) {
    rawStart = clamp(rawStart, 0, duration - len);
    var dragCenter = rawStart + len / 2;
    var pts = sortedScrollPointsChron().filter(function (x) { return x.id !== item.id; });
    var i;
    for (i = 0; i < pts.length; i++) {
      var o = pts[i];
      var oStart = o.time, oEnd = scrollPointEnd(o);
      if (dragCenter >= oStart && dragCenter <= oEnd) {
        var mid = (oStart + oEnd) / 2;
        if (dragCenter < mid) {
          return {
            start: applySnappedTime(Math.max(0, oStart - len), item.id, 0, duration - len),
            side: 'before', refId: o.id
          };
        }
        return {
          start: applySnappedTime(Math.min(oEnd, duration - len), item.id, 0, duration - len),
          side: 'after', refId: o.id
        };
      }
    }
    return { start: applySnappedTime(rawStart, item.id, 0, duration - len), side: null, refId: null };
  }

  function scrollPointElById(id) {
    return ED.track && ED.track.querySelector('.tly-marker[data-id="' + id + '"]');
  }

  function scrollPointerZone(e, p, el) {
    var rect = el.getBoundingClientRect();
    var x = e.clientX - rect.left, w = rect.width, edge = cueEdgeInPx(w);
    var nb = scrollPointNeighbors(p);
    if (x <= edge) return scrollPointsAdjacent(nb.prev, p) ? 'ripple-l' : 'resize-l';
    if (x >= w - edge) return scrollPointsAdjacent(p, nb.next) ? 'ripple-r' : 'resize-r';
    return 'move';
  }

  function laneForEl(el) {
    if (!el) return null;
    if (el.classList.contains('tly-marker-edit')) return 'scroll';
    if (el.classList.contains('tly-hi-edit')) return 'highlight';
    if (el.classList.contains('tly-cue-edit')) return 'subtitle';
    return null;
  }

  function isLaneCompact(lane) {
    return !!(ED.track && lane && ED.track.classList.contains('tly-lane-compact-' + lane));
  }

  function focusLaneItem(lane, selectFn, seekTime) {
    selectFn();
    applyMotionLaneLayout();
    if (seekTime != null && engine) engine.seek(seekTime);
  }

  function bindScrollPointInteractions(p, el) {
    el.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (isLaneCompact('scroll')) {
        focusLaneItem('scroll', function () { selectPoint(p.id); }, p.time);
        return;
      }
      selectPoint(p.id);
      startScrollPointDrag(e, p, el, scrollPointerZone(e, p, el));
    });
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      if (isLaneCompact('scroll')) return;
      selectPoint(p.id);
      if (engine) engine.seek(p.time);
    });
  }

  function startScrollPointDrag(e, p, el, zone) {
    zone = zone || 'move';
    var mode = dragModeFromZone(zone);
    draggingMarker = p.id;
    applyMotionLaneLayout();
    setDragCursorLock(zone, true);
    el.classList.add('tly-cue-dragging-' + zone);
    CUE_HOVER_CLS.forEach(function (cls) { el.classList.remove(cls); });
    var r = ED.track.getBoundingClientRect();
    var startX = e.clientX;
    var t0 = p.time, ease0 = scrollPointDuration(p), end0 = scrollPointEnd(p);
    var grabOffsetX = e.clientX - el.getBoundingClientRect().left;
    var nb = scrollPointNeighbors(p);
    var prev = nb.prev, next = nb.next;
    var linkedPrev = mode === 'l' && scrollPointsAdjacent(prev, p);
    var linkedNext = mode === 'r' && scrollPointsAdjacent(p, next);
    var prevEl = prev ? scrollPointElById(prev.id) : null;
    var nextEl = next ? scrollPointElById(next.id) : null;

    function move(ev) {
      var dt = (ev.clientX - startX) / r.width * duration;
      if (mode === 'l') applyScrollResizeStart(p, +(t0 + dt).toFixed(2), prev, linkedPrev);
      else if (mode === 'r') applyScrollResizeEnd(p, +(end0 + dt).toFixed(2), next, linkedNext);
      else {
        var rawStart = (ev.clientX - r.left - grabOffsetX) / r.width * duration;
        var slot = computeScrollDropSlot(rawStart, p, ease0);
        applyScrollMove(p, slot.start, ease0);
        dropTarget(slot.refId, slot.side);
      }
      layoutScrollPointEl(p, el, r.width);
      layoutScrollPointEl(prev, prevEl, r.width);
      layoutScrollPointEl(next, nextEl, r.width);
      syncTrackLabelContrast();
      if (ED.peStart) ED.peStart.value = p.time;
      if (ED.peDur) ED.peDur.value = scrollPointDuration(p);
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      setDragCursorLock(zone, false);
      el.classList.remove('tly-cue-dragging-' + zone);
      draggingMarker = false;
      applyMotionLaneLayout();
      clearDropHighlight();
      config.scrollPoints.sort(function (a, b) { return a.time - b.time; });
      save(); refreshPreview(); renderTimeline(); renderBottomEditor();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  // Drag a subtitle cue on the timeline

  function layoutCueVertical(c, el) {
    if (!el || !ED.track || !ED.track.classList.contains('tly-scroll-mode')) return;
    el.style.top = '';
    el.style.bottom = '';
  }

  function sortedSubtitlesChron() {
    return config.subtitles.slice().sort(function (a, b) { return a.start - b.start; });
  }

  function cueNeighbors(c) {
    var subs = sortedSubtitlesChron();
    var i = -1;
    for (var j = 0; j < subs.length; j++) { if (subs[j].id === c.id) { i = j; break; } }
    return { prev: i > 0 ? subs[i - 1] : null, next: i >= 0 && i < subs.length - 1 ? subs[i + 1] : null };
  }

  function cuesAdjacent(before, after) {
    return before && after && Math.abs(before.end - after.start) <= CUE_ADJ_EPS;
  }

  function snapCueTime(t, excludeId) {
    var targets = [0, duration], best = t, bestD = CUE_SNAP_SEC;
    if (engine) targets.push(engine.getTime());
    config.subtitles.forEach(function (x) {
      if (x.id === excludeId) return;
      targets.push(x.start, x.end);
    });
    config.scrollPoints.forEach(function (x) {
      if (x.id === excludeId) return;
      targets.push(x.time, scrollPointEnd(x));
    });
    (config.highlights || []).forEach(function (x) {
      if (x.id === excludeId) return;
      targets.push(x.start, x.end);
    });
    targets.forEach(function (target) {
      var d = Math.abs(t - target);
      if (d < bestD) { bestD = d; best = target; }
    });
    return +best.toFixed(2);
  }

  function applyCueMove(c, ns, len) {
    var span = applySnappedMove(ns, len, c.id, 0, duration - len);
    c.start = span.start;
    c.end = span.end;
  }

  var CUE_HOVER_CLS = ['tly-cue-hover-move', 'tly-cue-hover-resize-l', 'tly-cue-hover-resize-r', 'tly-cue-hover-ripple-l', 'tly-cue-hover-ripple-r'];
  var CUE_TRACK_ZONE_CLS = ['tly-cue-zone-move', 'tly-cue-zone-resize', 'tly-cue-zone-ripple'];
  var CUE_DRAG_CLS = ['tly-cue-dragging-move', 'tly-cue-dragging-resize-l', 'tly-cue-dragging-resize-r', 'tly-cue-dragging-ripple-l', 'tly-cue-dragging-ripple-r'];
  var CUE_DRAG_ROOT_CLS = ['tly-cue-dragging'].concat(CUE_DRAG_CLS);
  var dropIndicatorEl = null, dropHighlightId = null, dropHighlightSide = null;

  function isCueDragging() {
    return document.documentElement.classList.contains('tly-cue-dragging');
  }

  function setDragCursorLock(zone, on) {
    var root = document.documentElement;
    CUE_DRAG_ROOT_CLS.forEach(function (cls) { root.classList.remove(cls); });
    if (on) root.classList.add('tly-cue-dragging', 'tly-cue-dragging-' + zone);
  }

  function clearCueHover() {
    if (!ED.track) return;
    Array.prototype.forEach.call(ED.track.querySelectorAll('.tly-cue,.tly-hi,.tly-marker-edit'), function (el) {
      CUE_HOVER_CLS.forEach(function (cls) { el.classList.remove(cls); });
    });
    CUE_TRACK_ZONE_CLS.forEach(function (cls) { ED.track.classList.remove(cls); });
    if (!isCueDragging()) clearDropHighlight();
  }

  function trackZoneFromCueZone(zone) {
    if (zone === 'move') return 'tly-cue-zone-move';
    if (zone === 'resize-l' || zone === 'resize-r') return 'tly-cue-zone-resize';
    if (zone === 'ripple-l' || zone === 'ripple-r') return 'tly-cue-zone-ripple';
    return null;
  }

  function cueEdgeInPx(w) {
    var maxIn = Math.max(0, (w - CUE_MOVE_MIN) / 2);
    return Math.min(CUE_EDGE_IN, maxIn);
  }

  function cuePointerZone(e, c, cueEl, neighborsFn) {
    var rect = cueEl.getBoundingClientRect();
    var x = e.clientX - rect.left, w = rect.width, edge = cueEdgeInPx(w);
    var nb = (neighborsFn || cueNeighbors)(c);
    if (x <= edge) return cuesAdjacent(nb.prev, c) ? 'ripple-l' : 'resize-l';
    if (x >= w - edge) return cuesAdjacent(c, nb.next) ? 'ripple-r' : 'resize-r';
    return 'move';
  }

  function setCueHover(c, cueEl, zone) {
    if (isCueDragging()) return;
    clearCueHover();
    cueEl.classList.add('tly-cue-hover-' + zone);
    var trackZone = trackZoneFromCueZone(zone);
    if (trackZone) ED.track.classList.add(trackZone);
    var nb, elById;
    if (cueEl.classList.contains('tly-marker-edit')) {
      nb = scrollPointNeighbors(c);
      elById = scrollPointElById;
    } else {
      nb = cueEl.classList.contains('tly-hi-edit') ? highlightNeighbors(c) : cueNeighbors(c);
      elById = cueEl.classList.contains('tly-hi-edit') ? highlightElById : cueElById;
    }
    if (zone === 'ripple-l' && nb.prev) {
      var prevEl = elById(nb.prev.id);
      if (prevEl) prevEl.classList.add('tly-cue-hover-ripple-r');
    } else if (zone === 'ripple-r' && nb.next) {
      var nextEl = elById(nb.next.id);
      if (nextEl) nextEl.classList.add('tly-cue-hover-ripple-l');
    }
  }

  function onTrackCueHover(e) {
    if (activeTab !== 'scroll' || isCueDragging()) return;
    var cueEl = e.target.closest ? (e.target.closest('.tly-cue-edit') || e.target.closest('.tly-hi-edit') || e.target.closest('.tly-marker-edit')) : null;
    if (!cueEl) { clearCueHover(); return; }
    var id = cueEl.getAttribute('data-id'), c = null, i;
    var list = cueEl.classList.contains('tly-hi-edit') ? config.highlights : (cueEl.classList.contains('tly-marker-edit') ? config.scrollPoints : config.subtitles);
    for (i = 0; i < list.length; i++) {
      if (list[i].id === id) { c = list[i]; break; }
    }
    if (!c) { clearCueHover(); return; }
    var lane = laneForEl(cueEl);
    if (lane && isLaneCompact(lane)) { clearCueHover(); return; }
    var zoneFn = cueEl.classList.contains('tly-marker-edit')
      ? function (ev, item, el) { return scrollPointerZone(ev, item, el); }
      : function (ev, item, el) { return cuePointerZone(ev, item, el, cueEl.classList.contains('tly-hi-edit') ? highlightNeighbors : cueNeighbors); };
    setCueHover(c, cueEl, zoneFn(e, c, cueEl));
  }

  function bindTrackCueHover() {
    if (!ED.track || ED.track._tlyCueHoverBound) return;
    ED.track._tlyCueHoverBound = true;
    ED.track.addEventListener('mousemove', onTrackCueHover);
    ED.track.addEventListener('mouseleave', function () { if (!isCueDragging()) clearCueHover(); });
  }

  function ensureDropIndicator() {
    if (!dropIndicatorEl && ED.track) {
      dropIndicatorEl = h('div', { class: 'tly-drop-indicator tly-hidden' });
      ED.track.appendChild(dropIndicatorEl);
    }
    return dropIndicatorEl;
  }

  function showDropIndicator(t, trackWidth) {
    var el = ensureDropIndicator();
    if (!el) return;
    el.classList.remove('tly-hidden');
    el.style.left = (clamp(t / duration, 0, 1) * trackWidth) + 'px';
  }

  function hideDropIndicator() {
    if (dropIndicatorEl) dropIndicatorEl.classList.add('tly-hidden');
  }

  function clearDropHighlight() {
    if (dropHighlightId) {
      var el = dropTargetElById(dropHighlightId);
      if (el) el.classList.remove('tly-cue-drop-target-before', 'tly-cue-drop-target-after');
    }
    dropHighlightId = null;
    dropHighlightSide = null;
  }

  function dropTarget(refId, side) {
    if (dropHighlightId === refId && dropHighlightSide === side) return;
    clearDropHighlight();
    dropHighlightId = refId;
    dropHighlightSide = side;
    if (!refId || !side) return;
    var el = dropTargetElById(refId);
    if (el) el.classList.add(side === 'before' ? 'tly-cue-drop-target-before' : 'tly-cue-drop-target-after');
  }

  function computeDropSlot(rawStart, c, len) {
    rawStart = clamp(rawStart, 0, duration - len);
    var dragCenter = rawStart + len / 2;
    var subs = sortedSubtitlesChron().filter(function (x) { return x.id !== c.id; });
    var i;
    for (i = 0; i < subs.length; i++) {
      var o = subs[i];
      if (dragCenter >= o.start && dragCenter <= o.end) {
        var mid = (o.start + o.end) / 2;
        if (dragCenter < mid) {
          return {
            start: applySnappedTime(Math.max(0, o.start - len), c.id, 0, duration - len),
            side: 'before', refId: o.id
          };
        }
        return {
          start: applySnappedTime(Math.min(o.end, duration - len), c.id, 0, duration - len),
          side: 'after', refId: o.id
        };
      }
    }
    return { start: applySnappedTime(rawStart, c.id, 0, duration - len), side: null, refId: null };
  }

  function bindCueInteractions(c, cue) {
    cue.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (isLaneCompact('subtitle')) {
        focusLaneItem('subtitle', function () { selectCue(c.id); });
        return;
      }
      selectCue(c.id);
      startCueDrag(e, c, cue, cuePointerZone(e, c, cue));
    });
  }

  function dragModeFromZone(zone) {
    if (zone === 'move') return 'move';
    if (zone === 'ripple-l' || zone === 'resize-l') return 'l';
    return 'r';
  }

  function startCueDrag(e, c, cue, zone) {
    zone = zone || 'move';
    var mode = dragModeFromZone(zone);
    draggingCue = c.id;
    applyMotionLaneLayout();
    setDragCursorLock(zone, true);
    cue.classList.add('tly-cue-dragging-' + zone);
    CUE_HOVER_CLS.forEach(function (cls) { cue.classList.remove(cls); });
    var r = ED.track.getBoundingClientRect();
    var startX = e.clientX, s0 = c.start, e0 = c.end, len = e0 - s0;
    var grabOffsetX = e.clientX - cue.getBoundingClientRect().left;
    var nb = cueNeighbors(c);
    var prev = nb.prev, next = nb.next;
    var linkedPrev = mode === 'l' && cuesAdjacent(prev, c);
    var linkedNext = mode === 'r' && cuesAdjacent(c, next);
    var prevEl = prev ? cueElById(prev.id) : null;
    var nextEl = next ? cueElById(next.id) : null;

    function move(ev) {
      var dt = (ev.clientX - startX) / r.width * duration;
      if (mode === 'l') applyCueResizeStart(c, +(s0 + dt).toFixed(2), prev, linkedPrev);
      else if (mode === 'r') applyCueResizeEnd(c, +(e0 + dt).toFixed(2), next, linkedNext);
      else {
        var rawStart = (ev.clientX - r.left - grabOffsetX) / r.width * duration;
        var slot = computeDropSlot(rawStart, c, len);
        applyCueMove(c, slot.start, len);
        dropTarget(slot.refId, slot.side);
      }
      layoutCueEl(c, cue, r.width);
      layoutCueEl(prev, prevEl, r.width);
      layoutCueEl(next, nextEl, r.width);
      syncTrackLabelContrast();
      if (ED.ceStart) ED.ceStart.value = c.start;
      if (ED.ceEnd) ED.ceEnd.value = c.end;
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      setDragCursorLock(zone, false);
      draggingCue = false;
      applyMotionLaneLayout();
      clearDropHighlight();
      CUE_DRAG_CLS.forEach(function (cls) { cue.classList.remove(cls); });
      hideDropIndicator();
      config.subtitles.sort(function (a, b) { return a.start - b.start; });
      save(); refreshPreview(); renderTimeline(); renderBottomEditor();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  function computeHighlightDropSlot(rawStart, item, len) {
    rawStart = clamp(rawStart, 0, duration - len);
    var dragCenter = rawStart + len / 2;
    var subs = sortedHighlightsChron().filter(function (x) { return x.id !== item.id; });
    var i;
    for (i = 0; i < subs.length; i++) {
      var o = subs[i];
      if (dragCenter >= o.start && dragCenter <= o.end) {
        var mid = (o.start + o.end) / 2;
        if (dragCenter < mid) {
          return {
            start: applySnappedTime(Math.max(0, o.start - len), item.id, 0, duration - len),
            side: 'before', refId: o.id
          };
        }
        return {
          start: applySnappedTime(Math.min(o.end, duration - len), item.id, 0, duration - len),
          side: 'after', refId: o.id
        };
      }
    }
    return { start: applySnappedTime(rawStart, item.id, 0, duration - len), side: null, refId: null };
  }

  function highlightElById(id) {
    return ED.track && ED.track.querySelector('.tly-hi[data-id="' + id + '"]');
  }

  function layoutHiEl(hl, el, trackWidth) {
    if (!el) return;
    var x1 = clamp(hl.start / duration, 0, 1) * trackWidth;
    var x2 = clamp(hl.end / duration, 0, 1) * trackWidth;
    var barW = Math.max(2, x2 - x1);
    el.style.left = x1 + 'px';
    el.style.width = barW + 'px';
    syncBarLabel(el, barW);
  }

  function bindHighlightInteractions(hl, el) {
    el.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (isLaneCompact('highlight')) {
        focusLaneItem('highlight', function () { selectHighlight(hl.id); });
        return;
      }
      selectHighlight(hl.id);
      startHighlightDrag(e, hl, el, cuePointerZone(e, hl, el, highlightNeighbors));
    });
  }

  function startHighlightDrag(e, hl, el, zone) {
    zone = zone || 'move';
    var mode = dragModeFromZone(zone);
    draggingHighlight = hl.id;
    applyMotionLaneLayout();
    setDragCursorLock(zone, true);
    el.classList.add('tly-cue-dragging-' + zone);
    CUE_HOVER_CLS.forEach(function (cls) { el.classList.remove(cls); });
    var r = ED.track.getBoundingClientRect();
    var startX = e.clientX, s0 = hl.start, e0 = hl.end, len = e0 - s0;
    var grabOffsetX = e.clientX - el.getBoundingClientRect().left;
    var nb = highlightNeighbors(hl);
    var prev = nb.prev, next = nb.next;
    var linkedPrev = mode === 'l' && cuesAdjacent(prev, hl);
    var linkedNext = mode === 'r' && cuesAdjacent(hl, next);
    var prevEl = prev ? highlightElById(prev.id) : null;
    var nextEl = next ? highlightElById(next.id) : null;

    function move(ev) {
      var dt = (ev.clientX - startX) / r.width * duration;
      if (mode === 'l') applyCueResizeStart(hl, +(s0 + dt).toFixed(2), prev, linkedPrev);
      else if (mode === 'r') applyCueResizeEnd(hl, +(e0 + dt).toFixed(2), next, linkedNext);
      else {
        var rawStart = (ev.clientX - r.left - grabOffsetX) / r.width * duration;
        var slot = computeHighlightDropSlot(rawStart, hl, len);
        applyCueMove(hl, slot.start, len);
        dropTarget(slot.refId, slot.side);
      }
      layoutHiEl(hl, el, r.width);
      layoutHiEl(prev, prevEl, r.width);
      layoutHiEl(next, nextEl, r.width);
      syncTrackLabelContrast();
      if (ED.heStart) ED.heStart.value = hl.start;
      if (ED.heEnd) ED.heEnd.value = hl.end;
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      setDragCursorLock(zone, false);
      draggingHighlight = false;
      applyMotionLaneLayout();
      CUE_DRAG_CLS.forEach(function (cls) { el.classList.remove(cls); });
      clearDropHighlight();
      config.highlights.sort(function (a, b) { return a.start - b.start; });
      save(); refreshPreview(); renderTimeline(); renderBottomEditor();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  function cueStartBounds(c, prev, linkedPrev) {
    var minT = 0, maxT = c.end - CUE_MIN_DUR;
    if (linkedPrev && prev) minT = prev.start + CUE_MIN_DUR;
    else if (prev) minT = prev.end;
    if (maxT < minT) maxT = minT;
    return { minT: minT, maxT: maxT };
  }

  function cueEndBounds(c, next, linkedNext) {
    var minT = c.start + CUE_MIN_DUR, maxT = duration;
    if (linkedNext && next) maxT = next.end - CUE_MIN_DUR;
    else if (next) maxT = next.start;
    if (maxT < minT) maxT = minT;
    return { minT: minT, maxT: maxT };
  }

  function applySnappedTime(t, excludeId, minT, maxT) {
    var snapped = snapCueTime(t, excludeId);
    if (snapped < minT || snapped > maxT) return +clamp(t, minT, maxT).toFixed(2);
    return snapped;
  }

  function applySnappedMove(start, len, excludeId, minStart, maxStart) {
    minStart = minStart != null ? minStart : 0;
    maxStart = maxStart != null ? maxStart : duration - len;
    var end = start + len;
    var snappedStart = applySnappedTime(start, excludeId, minStart, maxStart);
    var snappedEnd = applySnappedTime(end, excludeId, minStart + len, maxStart + len);
    var startDelta = Math.abs(snappedStart - start);
    var endDelta = Math.abs(snappedEnd - end);
    var startSnapped = startDelta <= CUE_SNAP_SEC + 0.001 && startDelta > 0.001;
    var endSnapped = endDelta <= CUE_SNAP_SEC + 0.001 && endDelta > 0.001;
    if (endSnapped && (!startSnapped || endDelta < startDelta)) {
      var ns = +clamp(+(snappedEnd - len).toFixed(2), minStart, maxStart);
      return { start: ns, end: +(ns + len).toFixed(2) };
    }
    if (startSnapped) {
      return { start: snappedStart, end: +(snappedStart + len).toFixed(2) };
    }
    return { start: +clamp(start, minStart, maxStart).toFixed(2), end: +clamp(end, minStart + len, maxStart + len).toFixed(2) };
  }

  function applyCueResizeStart(c, ns, prev, linkedPrev) {
    var b = cueStartBounds(c, prev, linkedPrev);
    ns = applySnappedTime(ns, c.id, b.minT, b.maxT);
    c.start = ns;
    if (linkedPrev && prev) {
      prev.end = clamp(c.start, prev.start + CUE_MIN_DUR, duration);
      prev.end = +prev.end.toFixed(2);
      c.start = prev.end;
    }
  }

  function applyCueResizeEnd(c, ne, next, linkedNext) {
    var b = cueEndBounds(c, next, linkedNext);
    ne = applySnappedTime(ne, c.id, b.minT, b.maxT);
    c.end = ne;
    if (linkedNext && next) {
      next.start = clamp(c.end, 0, next.end - CUE_MIN_DUR);
      next.start = +next.start.toFixed(2);
      c.end = next.start;
    }
  }

  function cueElById(id) {
    return ED.track && ED.track.querySelector('.tly-cue[data-id="' + id + '"]');
  }

  function dropTargetElById(id) {
    return cueElById(id) || highlightElById(id) || scrollPointElById(id);
  }

  function layoutCueEl(c, el, trackWidth) {
    if (!el) return;
    var x1 = clamp(c.start / duration, 0, 1) * trackWidth;
    var x2 = clamp(c.end / duration, 0, 1) * trackWidth;
    var barW = Math.max(2, x2 - x1);
    el.style.left = x1 + 'px';
    el.style.width = barW + 'px';
    layoutCueVertical(c, el);
    syncBarLabel(el, barW);
  }

  // ---- selection + delete-key ----
  function selectCue(id) {
    selectedCueId = id;
    selectedPointId = null;
    selectedHighlightId = null;
    setFocusedLane('subtitle');
    Array.prototype.forEach.call(ED.track.querySelectorAll('.tly-cue'), function (m) {
      m.classList.toggle('tly-selected', m.getAttribute('data-id') === id);
    });
    Array.prototype.forEach.call(ED.track.querySelectorAll('.tly-marker'), function (m) {
      m.classList.remove('tly-selected');
    });
    Array.prototype.forEach.call(ED.track.querySelectorAll('.tly-hi'), function (m) {
      m.classList.remove('tly-selected');
    });
    renderBottomEditor();
    applyMotionLaneLayout();
  }
  function selectPoint(id) {
    selectedPointId = id;
    selectedHighlightId = null;
    selectedCueId = null;
    setFocusedLane('scroll');
    Array.prototype.forEach.call(ED.track.querySelectorAll('.tly-marker'), function (m) {
      m.classList.toggle('tly-selected', m.getAttribute('data-id') === id);
    });
    Array.prototype.forEach.call(ED.track.querySelectorAll('.tly-hi'), function (m) {
      m.classList.remove('tly-selected');
    });
    Array.prototype.forEach.call(ED.track.querySelectorAll('.tly-cue'), function (m) {
      m.classList.remove('tly-selected');
    });
    renderBottomEditor();
    applyMotionLaneLayout();
  }
  function nearestPointId(t) {
    var best = null, bd = Infinity;
    config.scrollPoints.forEach(function (p) { var d = Math.abs(p.time - t); if (d < bd) { bd = d; best = p.id; } });
    return best;
  }
  function onKeyDown(e) {
    if (!config || !config.video.embedUrl || !engine) return;
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    var a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    if (activeTab === 'scroll') {
      if (selectedCueId) { e.preventDefault(); deleteSubtitle(selectedCueId); return; }
      if (selectedHighlightId) { e.preventDefault(); deleteHighlight(selectedHighlightId); return; }
      if (!config.scrollPoints.length) return;
      var id = draggingMarker || selectedPointId || nearestPointId(engine.getTime());
      if (id) { e.preventDefault(); deletePoint(id); }
      return;
    }
    if (!config.scrollPoints.length) return;
    // delete a held/selected keyframe, else the one nearest the playhead
    var id = draggingMarker || selectedPointId || nearestPointId(engine.getTime());
    if (id) { e.preventDefault(); deletePoint(id); }
  }

  // ---- element anchors (scroll points) ----
  function elementTarget(selector, anchor, label) {
    return { mode: 'element', selector: selector || null, label: label || null, selectorFallbacks: [], viewportAnchor: anchor || 'center', offsetPx: 0 };
  }

  function addElementPoint() { if (engine) startPick('scroll', 'new'); }
  function deletePoint(id) {
    config.scrollPoints = config.scrollPoints.filter(function (p) { return p.id !== id; });
    if (selectedPointId === id) {
      selectedPointId = null;
      setFocusedLane('scroll');
    }
    save(); refreshPreview(); renderTimeline(); renderTabs(); renderBottomEditor();
  }

  // selected scroll-point editor, shown below the timeline
  function renderPointEditor() {
    if (!ED.pointEditor) return;
    ED.peStart = ED.peDur = null;
    var p = selectedPointId && config.scrollPoints.filter(function (x) { return x.id === selectedPointId; })[0];
    if (!p) {
      renderBottomPlaceholder('Select scroll, highlight, or subtitle on the timeline — or use the add buttons above.');
      return;
    }
    ED.pointEditor.classList.remove('tly-hidden');
    clearPointEditorBody();
    if (!p.target || p.target.mode !== 'element') p.target = elementTarget(null);
    var startIn = h('input', { class: 'tly-num', type: 'number', step: '0.1', value: p.time, onchange: function () { p.time = +startIn.value; config.scrollPoints.sort(function (a, b) { return a.time - b.time; }); save(); refreshPreview(); renderTimeline(); } });
    ED.peStart = startIn;
    var durIn = h('input', { class: 'tly-num', type: 'number', step: '0.1', min: '0', value: scrollPointDuration(p), onchange: function () { p.ease = +durIn.value; save(); refreshPreview(); renderTimeline(); } });
    ED.peDur = durIn;
    var easeSel = h('select', { class: 'tly-sel', onchange: function () { p.easing = easeSel.value; save(); refreshPreview(); } },
      [['ease', 'Ease (in-out)'], ['linear', 'Linear'], ['ease-in', 'Ease in'], ['ease-out', 'Ease out']].map(function (o) { var op = h('option', { value: o[0], text: o[1] }); if ((p.easing || 'ease') === o[0]) op.selected = true; return op; }));
    var anchorSel = h('select', { class: 'tly-sel', onchange: function () { p.target.viewportAnchor = anchorSel.value; save(); refreshPreview(); } },
      ['top', 'center'].map(function (a) { var op = h('option', { value: a, text: 'anchor: ' + a }); if ((p.target.viewportAnchor || 'center') === a) op.selected = true; return op; }));
    var elName = displayNameForTarget(p.target);
    var tag = h('span', {
      class: 'tly-tag tly-el' + (isElementPoint(p) ? '' : ' tly-warn'),
      title: isElementPoint(p) ? (p.target.selector || '') : '',
      text: isElementPoint(p) ? elName : 'No element — pick one'
    });
    ED.pointEditorBody.appendChild(h('div', { class: 'tly-pe-row' }, [
      h('span', { class: 'tly-pe-title', text: 'Scroll point' }),
      h('span', { class: 'tly-muted', text: 'start' }), startIn,
      h('span', { class: 'tly-muted', text: 'duration' }), durIn,
      h('span', { class: 'tly-muted', text: 'animation' }), easeSel,
      anchorSel,
      tag,
      h('span', { class: 'tly-grow' }),
      h('button', { class: 'tly-btn tly-mini tly-danger', text: 'Delete', onclick: function () { deletePoint(p.id); } })
    ]));
  }

  // ---- subtitles ----
  var SUB_MAX_SEC = 3.5, SUB_MAX_CHARS = 48, SUB_MAX_WORDS = 7;

  function splitSubtitleText(text) {
    text = (text || '').replace(/\s+/g, ' ').trim();
    if (!text) return [];
    var words = text.split(' '), chunks = [], cur = [];
    function flush() { if (cur.length) { chunks.push(cur.join(' ')); cur = []; } }
    words.forEach(function (w) {
      var trial = cur.concat(w).join(' ');
      if (cur.length && (cur.length >= SUB_MAX_WORDS || trial.length > SUB_MAX_CHARS)) flush();
      cur.push(w);
      if (/[.!?]$/.test(w)) flush();
    });
    flush();
    return chunks;
  }

  function chunkSegment(seg) {
    var start = +seg.start, end = +seg.end, text = (seg.text || '').trim();
    if (!text || end <= start) return [];
    var phrases = splitSubtitleText(text);
    var totalChars = phrases.reduce(function (n, p) { return n + p.length; }, 0) || 1;
    var dur = end - start, t = start, raw = [];
    phrases.forEach(function (p, i) {
      var d = i === phrases.length - 1 ? end - t : dur * (p.length / totalChars);
      raw.push({ start: t, end: t + d, text: p });
      t += d;
    });
    var out = [];
    raw.forEach(function (c) {
      var cd = c.end - c.start;
      if (cd <= SUB_MAX_SEC) {
        out.push({ start: +c.start.toFixed(2), end: +c.end.toFixed(2), text: c.text });
        return;
      }
      var parts = splitSubtitleText(c.text);
      if (parts.length <= 1) {
        var ws = c.text.split(' '), half = Math.ceil(ws.length / 2);
        parts = [ws.slice(0, half).join(' '), ws.slice(half).join(' ')].filter(Boolean);
      }
      var tc = parts.reduce(function (n, p) { return n + p.length; }, 0) || 1, tt = c.start;
      parts.forEach(function (p, i) {
        var d = i === parts.length - 1 ? c.end - tt : cd * (p.length / tc);
        out.push({ start: +tt.toFixed(2), end: +(tt + d).toFixed(2), text: p });
        tt += d;
      });
    });
    return out.filter(function (s) { return s.text && s.end > s.start; });
  }

  function segmentsToCues(segments) {
    var cues = [];
    (segments || []).forEach(function (s) {
      chunkSegment(s).forEach(function (c) {
        cues.push({ id: uuid(), start: c.start, end: c.end, text: c.text, source: 'auto' });
      });
    });
    return cues;
  }

  function subtitleRenderOrder(a, b) {
    var sa = a.source === 'manual' ? 1 : 0, sb = b.source === 'manual' ? 1 : 0;
    if (sa !== sb) return sa - sb;
    return a.start - b.start;
  }

  function setTranscribeStatus(msg, isError) {
    if (!ED.transcribeStatus) return;
    if (!msg) {
      ED.transcribeStatus.classList.add('tly-hidden');
      ED.transcribeStatus.textContent = '';
      return;
    }
    ED.transcribeStatus.classList.remove('tly-hidden');
    ED.transcribeStatus.classList.toggle('tly-error', !!isError);
    ED.transcribeStatus.textContent = msg;
  }

  function setAutoSubBusy(busy) {
    transcribing = busy;
    if (ED.addSubBtn) ED.addSubBtn.disabled = busy;
    if (ED.autoSubBtn) {
      ED.autoSubBtn.disabled = busy;
      var textEl = ED.autoSubBtn.querySelector('.tly-btn-text');
      if (textEl) textEl.textContent = busy ? 'Generating…' : 'Auto-generate';
    }
    if (busy) setTranscribeStatus('Generating subtitles…');
  }

  function addSubtitleManual() {
    if (!engine) return;
    var t = +engine.getTime().toFixed(2);
    var id = uuid();
    config.subtitles.push({ id: id, start: t, end: +(t + 3).toFixed(2), text: 'New subtitle', source: 'manual' });
    config.subtitles.sort(function (a, b) { return a.start - b.start; });
    activeTab = 'scroll';
    save(); refreshPreview(); renderTimeline(); renderTabs();
    selectCue(id);
  }

  function autoGenerateSubtitles() {
    if (!engine || !config.video.embedUrl || transcribing) return;
    var hadAuto = config.subtitles.some(function (c) { return c.source === 'auto'; });
    if (hadAuto && !confirm('Replace previously auto-generated subtitles? Manual subtitles will be kept.')) return;
    setAutoSubBusy(true);
    bg({ type: 'transcribeSubtitles', embedUrl: config.video.embedUrl, videoId: config.video.videoId }, function (res) {
      setAutoSubBusy(false);
      if (!res || !res.ok) {
        setTranscribeStatus((res && res.error) || 'Transcription unavailable', true);
        return;
      }
      var cues = segmentsToCues(res.segments);
      if (!cues.length) { setTranscribeStatus('No speech detected', true); return; }
      config.subtitles = config.subtitles.filter(function (c) { return c.source !== 'auto'; });
      config.subtitles = config.subtitles.concat(cues);
      config.subtitles.sort(function (a, b) { return a.start - b.start; });
      activeTab = 'scroll';
      save(); refreshPreview(); renderTimeline(); renderTabs();
      selectCue(cues[0].id);
      setTranscribeStatus(cues.length + ' subtitles generated');
      setTimeout(function () { setTranscribeStatus(''); }, 4000);
    });
  }

  function deleteSubtitle(id) {
    config.subtitles = config.subtitles.filter(function (c) { return c.id !== id; });
    if (selectedCueId === id) {
      selectedCueId = null;
      setFocusedLane('subtitle');
    }
    save(); refreshPreview(); renderTimeline(); renderTabs(); renderBottomEditor();
  }

  // ---- highlights ----
  function sortedHighlightsChron() {
    return config.highlights.slice().sort(function (a, b) { return a.start - b.start; });
  }

  function highlightNeighbors(h) {
    var all = sortedHighlightsChron();
    var i = -1;
    for (var j = 0; j < all.length; j++) { if (all[j].id === h.id) { i = j; break; } }
    return {
      prev: i > 0 ? all[i - 1] : null,
      next: i >= 0 && i < all.length - 1 ? all[i + 1] : null
    };
  }

  function addHighlight() {
    if (engine) startPick('highlight', 'new');
  }

  function deleteHighlight(id) {
    config.highlights = config.highlights.filter(function (h) { return h.id !== id; });
    if (selectedHighlightId === id) {
      selectedHighlightId = null;
      setFocusedLane('highlight');
    }
    save(); refreshPreview(); renderTimeline(); renderTabs(); renderBottomEditor();
  }

  function selectHighlight(id) {
    selectedHighlightId = id;
    selectedPointId = null;
    selectedCueId = null;
    setFocusedLane('highlight');
    Array.prototype.forEach.call(ED.track.querySelectorAll('.tly-hi'), function (m) {
      m.classList.toggle('tly-selected', m.getAttribute('data-id') === id);
    });
    Array.prototype.forEach.call(ED.track.querySelectorAll('.tly-marker'), function (m) {
      m.classList.remove('tly-selected');
    });
    Array.prototype.forEach.call(ED.track.querySelectorAll('.tly-cue'), function (m) {
      m.classList.remove('tly-selected');
    });
    renderBottomEditor();
    applyMotionLaneLayout();
  }

  function renderHighlightEditor() {
    if (!ED.pointEditor) return;
    ED.heStart = ED.heEnd = null;
    var hl = selectedHighlightId && config.highlights.filter(function (x) { return x.id === selectedHighlightId; })[0];
    if (!hl) {
      renderBottomPlaceholder('Select scroll, highlight, or subtitle on the timeline — or use the add buttons above.');
      return;
    }
    ED.pointEditor.classList.remove('tly-hidden');
    clearPointEditorBody();
    var s = h('input', { class: 'tly-num', type: 'number', step: '0.1', value: hl.start, onchange: function () { hl.start = +s.value; config.highlights.sort(function (a, b) { return a.start - b.start; }); save(); refreshPreview(); renderTimeline(); } });
    var e = h('input', { class: 'tly-num', type: 'number', step: '0.1', value: hl.end, onchange: function () { hl.end = +e.value; save(); refreshPreview(); renderTimeline(); } });
    var col = h('input', { class: 'tly-color', type: 'color', value: hl.color || DEFAULT_HIGHLIGHT_COLOR, oninput: function () { hl.color = col.value; save(); refreshPreview(); renderTimeline(); } });
    normalizeHighlightAnim(hl);
    var animOptions = highlightAnimsFor(hl);
    var currentAnim = hl.animation || 'pulse';
    if (animOptions.indexOf(currentAnim) < 0) animOptions = animOptions.concat([currentAnim]);
    var animSel = h('select', { class: 'tly-sel', onchange: function () { hl.animation = animSel.value; save(); refreshPreview(); } },
      animOptions.map(function (a) {
        var op = h('option', { value: a, text: highlightAnimLabel(a) });
        if (currentAnim === a) op.selected = true;
        return op;
      }));
    var elName = displayNameForTarget(hl.target);
    var tag = h('span', {
      class: 'tly-tag tly-hi-tag' + (isElementTarget(hl.target) ? '' : ' tly-warn'),
      title: isElementTarget(hl.target) ? (hl.target.selector || '') : '',
      text: isElementTarget(hl.target) ? elName : 'No element — pick one'
    });
    ED.heStart = s; ED.heEnd = e;
    ED.pointEditorBody.appendChild(h('div', { class: 'tly-pe-row' }, [
      h('span', { class: 'tly-pe-title tly-pe-title-hi', text: 'Highlight' }),
      h('span', { class: 'tly-muted', text: 'start' }), s,
      h('span', { class: 'tly-muted', text: 'end' }), e,
      h('span', { class: 'tly-muted', text: 'color' }), col,
      h('span', { class: 'tly-muted', text: 'animation' }), animSel,
      tag,
      h('span', { class: 'tly-grow' }),
      h('button', { class: 'tly-btn tly-mini tly-danger', text: 'Delete', onclick: function () { deleteHighlight(hl.id); } })
    ]));
  }

  // selected subtitle editor, shown below the timeline (shares the point-editor container)
  function renderCueEditor() {
    if (!ED.pointEditor) return;
    ED.ceStart = ED.ceEnd = null;
    var c = selectedCueId && config.subtitles.filter(function (x) { return x.id === selectedCueId; })[0];
    if (!c) {
      renderBottomPlaceholder('Select a subtitle on the timeline, or click Add subtitles to add one.');
      return;
    }
    ED.pointEditor.classList.remove('tly-hidden');
    clearPointEditorBody();
    var s = h('input', { class: 'tly-num', type: 'number', step: '0.1', value: c.start, onchange: function () { c.start = +s.value; config.subtitles.sort(function (a, b) { return a.start - b.start; }); save(); refreshPreview(); renderTimeline(); } });
    var e = h('input', { class: 'tly-num', type: 'number', step: '0.1', value: c.end, onchange: function () { c.end = +e.value; save(); refreshPreview(); renderTimeline(); } });
    var txt = h('input', { class: 'tly-text', style: { flex: '1 1 200px', width: 'auto' }, value: c.text, oninput: function () { c.text = txt.value; save(); refreshPreview(); renderTimeline(); } });
    ED.ceStart = s; ED.ceEnd = e;
    ED.pointEditorBody.appendChild(h('div', { class: 'tly-pe-row' }, [
      h('span', { class: 'tly-pe-title', text: 'Subtitle' }),
      h('span', { class: 'tly-muted', text: 'start' }), s,
      h('span', { class: 'tly-muted', text: 'end' }), e,
      h('span', { class: 'tly-muted', text: 'text' }), txt,
      h('button', { class: 'tly-btn tly-mini tly-danger', text: 'Delete', onclick: function () { deleteSubtitle(c.id); } })
    ]));
  }

  // ---- element picker ----
  function startPick(type, refId) {
    pickContext = { type: type, id: refId };
    document.documentElement.classList.add('tly-picking');
    if (type === 'highlight') document.documentElement.classList.add('tly-picking-highlight');
    if (ED.root) ED.root.classList.add('tly-editor-pick-min');
    showModeChrome(type === 'highlight' ? 'pick-highlight' : 'pick', 'Hover an element · Esc to cancel');
    if (ED.pickOverlay) ED.pickOverlay.classList.toggle('tly-pick-overlay-hi', type === 'highlight');
    document.addEventListener('mousemove', pickMove, true);
    document.addEventListener('click', pickClick, true);
    document.addEventListener('keydown', pickKey, true);
    refreshPreview();
  }
  function stopPick() {
    pickContext = null;
    document.documentElement.classList.remove('tly-picking');
    document.documentElement.classList.remove('tly-picking-highlight');
    if (ED.root) ED.root.classList.remove('tly-editor-pick-min');
    if (ED.pickOverlay) ED.pickOverlay.classList.remove('tly-pick-overlay-hi');
    ED.pickOverlay.style.display = 'none';
    document.removeEventListener('mousemove', pickMove, true);
    document.removeEventListener('click', pickClick, true);
    document.removeEventListener('keydown', pickKey, true);
    if (!previewActive) hideModeChrome();
    refreshPreview();
  }
  function updatePickBanner(el) {
    if (!ED.banner) return;
    if (!el || isOwn(el)) {
      ED.banner.textContent = 'Hover an element · Esc to cancel';
      return;
    }
    ED.banner.textContent = labelForElement(el) + ' · click to select · Esc to cancel';
  }
  function pickHighlightRadius(el) {
    var rect = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    var tl = parseFloat(cs.borderTopLeftRadius) || 0;
    var tr = parseFloat(cs.borderTopRightRadius) || 0;
    var br = parseFloat(cs.borderBottomRightRadius) || 0;
    var bl = parseFloat(cs.borderBottomLeftRadius) || 0;
    var maxR = Math.max(0, Math.min(rect.width, rect.height) / 2);
    var bg = cs.backgroundColor || '';
    var transparent = !bg || bg === 'transparent' || (bg.indexOf('rgba') >= 0 && parseFloat((bg.match(/[\d.]+\s*\)?$/) || ['1'])[0]) < 0.08);
    if (transparent && (tl + tr + br + bl) < 1) tl = tr = br = bl = Math.min(8, maxR);
    tl = Math.min(tl, maxR); tr = Math.min(tr, maxR); br = Math.min(br, maxR); bl = Math.min(bl, maxR);
    return tl + 'px ' + tr + 'px ' + br + 'px ' + bl + 'px';
  }

  function pickMove(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isOwn(el)) {
      ED.pickOverlay.style.display = 'none';
      updatePickBanner(null);
      return;
    }
    var r = el.getBoundingClientRect();
    var isHi = pickContext && pickContext.type === 'highlight';
    if (isHi) {
      var pad = 3;
      Object.assign(ED.pickOverlay.style, {
        display: 'block',
        left: (r.left - pad) + 'px',
        top: (r.top - pad) + 'px',
        width: (r.width + pad * 2) + 'px',
        height: (r.height + pad * 2) + 'px',
        background: 'transparent',
        border: 'none',
        outline: '2px solid #ff4d8d',
        outlineOffset: '0px',
        borderRadius: pickHighlightRadius(el),
        boxShadow: 'none'
      });
    } else {
      Object.assign(ED.pickOverlay.style, {
        display: 'block',
        left: r.left + 'px',
        top: r.top + 'px',
        width: r.width + 'px',
        height: r.height + 'px',
        background: 'rgba(37,99,235,.18)',
        border: '2px solid var(--tly-scroll)',
        outline: '',
        outlineOffset: '',
        borderRadius: '3px',
        boxShadow: ''
      });
    }
    updatePickBanner(el);
  }
  function isOwn(el) {
    return !!(el.closest && (
      el.closest('#tourly-editor') || el.closest('.tourly-root') || el.closest('.tourly-hi-layer') ||
      el.id === 'tly-pick-overlay' || el.id === 'tly-mode-banner' || el.id === 'tly-mode-frame'
    ));
  }
  function pickClick(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isOwn(el) || !pickContext) return;
    e.preventDefault(); e.stopPropagation();
    var sel = selectorFor(el);
    var label = labelForElement(el);
    if (pickContext.type === 'highlight') {
      if (pickContext.id === 'new') {
        var t = Math.floor(engine.getTime() * 100) / 100;
        var hid = uuid();
        config.highlights.push({ id: hid, start: t, end: +(t + 3).toFixed(2), color: DEFAULT_HIGHLIGHT_COLOR, animation: 'sweep', target: elementTarget(sel, 'center', label) });
        config.highlights.sort(function (a, b) { return a.start - b.start; });
        selectedHighlightId = hid;
        selectedPointId = null;
        setFocusedLane('highlight');
        activeTab = 'scroll';
      } else {
        var hl = config.highlights.filter(function (x) { return x.id === pickContext.id; })[0];
        if (hl) {
          hl.target = elementTarget(sel, 'center', label);
          selectedHighlightId = hl.id;
          setFocusedLane('highlight');
        }
      }
      save(); refreshPreview(); renderTimeline();
      stopPick(); renderTabs(); renderBottomEditor();
      return;
    }
    if (pickContext.id === 'new') {
      var t2 = Math.floor(engine.getTime() * 100) / 100;
      var id = uuid();
      config.scrollPoints.push({ id: id, time: t2, ease: 0.8, easing: 'ease', target: elementTarget(sel, 'center', label) });
      config.scrollPoints.sort(function (a, b) { return a.time - b.time; });
      selectedPointId = id;
      setFocusedLane('scroll');
      activeTab = 'scroll';
    } else {
      var p = config.scrollPoints.filter(function (x) { return x.id === pickContext.id; })[0];
      if (p) {
        p.target = elementTarget(sel, (p.target && p.target.viewportAnchor) || 'center', label);
        selectedPointId = p.id;
        setFocusedLane('scroll');
      }
    }
    save(); refreshPreview(); renderTimeline();
    stopPick(); renderTabs(); renderBottomEditor();
  }
  function pickKey(e) { if (e.key === 'Escape') { e.preventDefault(); stopPick(); } }

  // ---- tab rendering ----
  function renderTabs() {
    if (!ED.tabsBar) return;
    Array.prototype.forEach.call(ED.tabsBar.children, function (b) { b.classList.toggle('tly-active', b.getAttribute('data-tab') === activeTab); });
    updateTransportActions();
    ED.panel.innerHTML = '';
    // Scroll points + Subtitles have no middle panel — only Theme / Export use it.
    var needsPanel = activeTab === 'theme' || activeTab === 'export';
    ED.panel.classList.toggle('tly-hidden', !needsPanel);
    if (!needsPanel || !config.video.embedUrl) return;
    if (activeTab === 'theme') renderThemeTab();
    else if (activeTab === 'export') renderExportTab();
  }

  function updateTransportActions() {
    var isMotion = activeTab === 'scroll';
    var lane = isMotion ? motionEditLane() : null;
    var contextual = !!(isMotion && lane);
    if (ED.addPointBtn) ED.addPointBtn.classList.toggle('tly-hidden', !contextual || lane !== 'scroll');
    if (ED.addHiBtn) ED.addHiBtn.classList.toggle('tly-hidden', !contextual || lane !== 'highlight');
    if (ED.addSubBtn) ED.addSubBtn.classList.toggle('tly-hidden', !contextual || lane !== 'subtitle');
    if (ED.autoSubBtn) ED.autoSubBtn.classList.toggle('tly-hidden', !contextual || lane !== 'subtitle');
    if (ED.addMenuWrap) ED.addMenuWrap.classList.toggle('tly-hidden', !isMotion);
    if (ED.transportPlaySpacer) ED.transportPlaySpacer.classList.toggle('tly-hidden', !isMotion);
    if (ED.transportSep) ED.transportSep.classList.toggle('tly-hidden', !contextual);
    if (!isMotion) {
      if (ED.addMenu) ED.addMenu.classList.add('tly-hidden');
      addMenuOpen = false;
      setTranscribeStatus('');
    }
  }

  function renderThemeTab() {
    var v = config.theme.video = config.theme.video || { radius: 8, width: 320, position: 'bottom-right', margin: 24 };
    function num(label, key, step) {
      var i = h('input', { class: 'tly-num', type: 'number', step: step || 1, value: v[key], onchange: function () { v[key] = +i.value; save(); refreshPreview(); } });
      return h('div', { class: 'tly-row' }, [h('span', { class: 'tly-muted', style: { width: '120px' }, text: label }), i]);
    }
    var posSel = h('select', { class: 'tly-sel', onchange: function () { v.position = posSel.value; save(); refreshPreview(); } },
      ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'bottom-center'].map(function (p) { var o = h('option', { value: p, text: p }); if (v.position === p) o.selected = true; return o; }));
    ED.panel.appendChild(num('Video width (px)', 'width'));
    ED.panel.appendChild(num('Corner radius (px)', 'radius'));
    ED.panel.appendChild(num('Margin (px)', 'margin'));
    ED.panel.appendChild(h('div', { class: 'tly-row' }, [h('span', { class: 'tly-muted', style: { width: '120px' }, text: 'Position' }), posSel]));
    ED.panel.appendChild(h('div', { class: 'tly-hint', text: 'More subtitle/notification styling coming next. Corner radius defaults to 8px.' }));
  }

  function renderExportTab() {
    var ta = h('textarea', { class: 'tly-export', readonly: 'readonly' });
    ta.value = 'Building embed…';

    var isPlaceholder = !cdnUrl || cdnUrl.indexOf('YOUR-SUBDOMAIN') > -1;
    var notSynced = !cloud.configured;

    var cdnIn = h('input', { class: 'tly-url', value: cdnUrl, placeholder: 'https://tourly-cdn.yoursubdomain.workers.dev', oninput: function () {
      cdnUrl = cdnIn.value.trim() || DEFAULT_CDN; save(); refreshSnippet();
      cdnWarn.classList.toggle('tly-hidden', cdnUrl.indexOf('YOUR-SUBDOMAIN') === -1);
    } });
    var cdnRow = h('div', { class: 'tly-row' }, [h('span', { class: 'tly-muted', style: { width: '120px' }, text: 'CDN URL' }), cdnIn]);
    var cdnWarn = h('div', { class: 'tly-hint tly-warn-text' + (isPlaceholder ? '' : ' tly-hidden'), text: '⚠ Deploy cdn-worker/ (see its README) and paste your real Worker URL above before publishing — this placeholder won’t load.' });
    var syncWarn = h('div', { class: 'tly-hint tly-warn-text' + (notSynced ? '' : ' tly-hidden'), text: '⚠ Cloud sync isn’t connected — a concise embed fetches this tour by id at runtime, so it needs to be saved to the cloud first, or visitors will see nothing.' });

    var modeSel = h('select', { class: 'tly-sel' }, [
      h('option', { value: 'concise', text: 'Concise (recommended) — tiny snippet, fetches this tour live' }),
      h('option', { value: 'self-contained', text: 'Self-contained — larger, works with zero external dependency' })
    ]);
    modeSel.value = exportMode;
    modeSel.addEventListener('change', function () {
      exportMode = modeSel.value; save();
      cdnRow.classList.toggle('tly-hidden', exportMode !== 'concise');
      syncWarn.classList.toggle('tly-hidden', exportMode !== 'concise' || !notSynced);
      refreshSnippet();
    });
    cdnRow.classList.toggle('tly-hidden', exportMode !== 'concise');

    var copyBtn = h('button', { class: 'tly-btn tly-primary', text: 'Copy embed code', onclick: function () { ta.select(); try { document.execCommand('copy'); } catch (e) {} copyBtn.textContent = 'Copied ✓'; setTimeout(function () { copyBtn.textContent = 'Copy embed code'; }, 1500); } });

    ED.panel.appendChild(h('div', { class: 'tly-row' }, [h('span', { class: 'tly-muted', style: { width: '120px' }, text: 'Export mode' }), modeSel]));
    ED.panel.appendChild(cdnRow);
    ED.panel.appendChild(cdnWarn);
    ED.panel.appendChild(syncWarn);
    ED.panel.appendChild(h('div', { class: 'tly-row' }, [copyBtn, h('span', { class: 'tly-hint', text: 'Paste this into the page’s per-page custom code (before </body>).' })]));
    ED.panel.appendChild(ta);

    function refreshSnippet() {
      if (exportMode === 'concise') { ta.value = snippet(); return; }
      // Self-contained needs the actual runtime source text inlined.
      loadEmbedSources(function (src) {
        ta.value = src ? snippet() : '<!-- Could not load the tour runtime to embed — try reopening the editor. -->';
      });
    }
    refreshSnippet();
  }

  function snippet() {
    if (exportMode === 'concise') {
      var base = (cdnUrl || DEFAULT_CDN).replace(/\/+$/, '');
      // Tiny: no config inlined at all — engine.js fetches this tour's config by id at page-load
      // (see engine.js's fetchAndMount / the public read-only RLS policy it relies on).
      return '<script data-tourly-id="' + config.id + '" src="' + base + '/engine.js" defer></script>';
    }

    // Self-contained: Player.js + engine.js + config all inlined in one <script> block — zero
    // external requests, so the tour works even if the backend/CDN is unreachable.
    var out = clone(config);
    delete out.pageUrl;
    var configLine = 'window.TOURLY_CONFIG = ' + JSON.stringify(out) + ';';
    return '<script>\n' + configLine + '\n' +
      (embedSources.playerjs || '') + '\n;\n' +
      (embedSources.engine || '') +
      '\n</script>';
  }

  // ---- public API ----
  var API = {
    toggle: function () {
      if (editorVisible()) hideEditorUI(true);
      else showEditorUI();
    },
    destroy: function () {
      document.removeEventListener('keydown', onKeyDown, true);
      stopPick();
      stopTourPreview(false);
      if (engine) engine.destroy();
      if (ED.root) ED.root.remove();
      if (ED.pickOverlay) ED.pickOverlay.remove();
      if (ED.modeFrame) ED.modeFrame.remove();
      if (ED.backdrop) ED.backdrop.remove();
      if (ED.addMenu) ED.addMenu.remove();
      window.__tourlyEditor = null;
    }
  };

  // ---- init ----
  function init() {
    // Ignore a stored value that's still the old literal placeholder (from before DEFAULT_CDN
    // was filled in with the real deployed URL) — otherwise a stale save permanently shadows
    // every future improvement to the default.
    store.get(store.cdnKey, function (r) { if (r && r.indexOf('YOUR-SUBDOMAIN') === -1) cdnUrl = r; });
    store.get(store.modeKey, function (r) { if (r === 'concise' || r === 'self-contained') exportMode = r; });
    bg({ type: 'getConfig' }, function (r) {
      if (r && r.ok) { cloud.configured = r.configured; cloud.userId = r.userId; updateCloudNote(); }
    });
    store.get(store.key, function (saved) {
      config = migrateConfig(saved && saved.video ? saved : newConfig());
      build();
      if (config.video.embedUrl) mountEngine();
      // nothing saved locally → try restoring this page's tour from Supabase (background checks if configured)
      if (!(saved && saved.video)) {
        bg({ type: 'toursGet', pageUrl: config.pageUrl || pageKey() }, function (res) {
          if (res && res.ok && res.data && res.data[0] && res.data[0].config && res.data[0].config.video) {
            config = migrateConfig(res.data[0].config);
            store.set(store.key, config);
            renderMode();
            if (config.video.embedUrl) mountEngine();
          }
        });
      }
    });
    window.addEventListener('resize', function () { renderTimeline(); });
  }

  function updateCloudNote() {
    if (ED.cloudNote) ED.cloudNote.textContent = cloud.configured ? '☁ synced' : '';
  }

  window.__tourlyEditor = API;
  init();
})();
