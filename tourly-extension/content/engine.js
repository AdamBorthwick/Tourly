/*!
 * Tourly engine — guided video tours for Webflow.
 * Single source of truth used BOTH by the Chrome-extension editor (mode:"edit")
 * and the published runtime served from jsDelivr (mode:"live").
 *
 * Public API:
 *   const tour = window.Tourly.mount(config, { mode });
 *   tour.play() / pause() / toggle() / seek(sec) / getTime() / getDuration()
 *   tour.setConfig(cfg)            // live re-render (editor)
 *   tour.setPreviewVisible(bool)   // show/hide video + subtitles (editor overlay)
 *   tour.resolveTargetY(target)    // px scroll position for a target def
 *   tour.captureManualTarget()     // {mode:"manual", manualPercent} at current scroll
 *   tour.on(evt, cb) / off(evt, cb)   // 'ready'|'timeupdate'|'play'|'pause'|'ended'|'statechange'
 *   tour.destroy()
 *
 * Auto-mounts on DOMContentLoaded if window.TOURLY_CONFIG is present.
 * Requires Player.js (window.playerjs) — loaded alongside on the page.
 */
(function () {
  'use strict';

  var VERSION = '0.1.0';
  var SEEK_THRESHOLD = 0.4;   // seconds jumped in one frame → treat as seek (snap, not tween)
  var DEFAULT_EASE = 0.8;     // seconds for a scroll tween when a keyframe is crossed
  var TOAST_MS = 2600;        // how long the "scroll is guided" toast stays up
  var SCROLL_KEYS = { ' ': 1, 'Spacebar': 1, 'ArrowUp': 1, 'ArrowDown': 1, 'PageUp': 1, 'PageDown': 1, 'Home': 1, 'End': 1 };

  // ---- defaults ------------------------------------------------------------
  var DEFAULTS = {
    theme: {
      video: { radius: 8, width: 320, position: 'bottom-right', margin: 24 },
      subtitles: { font: 'inherit', size: 16, color: '#ffffff', bg: 'rgba(0,0,0,0.62)', radius: 8, maxWidth: 80, weight: 500 },
      notification: { text: 'Scrolling is guided during the tour — pause to explore', bg: '#111318', textColor: '#ffffff', radius: 8 }
    },
    behavior: {
      scrollLock: true,
      pauseOnVideoClick: true,
      startTrigger: 'manual',   // 'manual' | 'onLoad' | 'inView'
      mobile: { videoWidth: '45vw', position: 'bottom-center', breakpoint: 768 }
    }
  };

  // ---- small utilities -----------------------------------------------------
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function easeInOutCubic(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
  function easeInCubic(p) { return p * p * p; }
  function easeOutCubic(p) { return 1 - Math.pow(1 - p, 3); }
  function linear(p) { return p; }
  var EASINGS = { 'ease': easeInOutCubic, 'linear': linear, 'ease-in': easeInCubic, 'ease-out': easeOutCubic };
  function easingFn(name) { return EASINGS[name] || easeInOutCubic; }
  function docHeight() {
    return Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement.scrollHeight,
      document.documentElement.offsetHeight
    );
  }
  function maxScrollY() { return Math.max(0, docHeight() - window.innerHeight); }
  function deepMerge(base, over) {
    var out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!over) return out;
    Object.keys(over).forEach(function (k) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof out[k] === 'object') {
        out[k] = deepMerge(out[k], over[k]);
      } else {
        out[k] = over[k];
      }
    });
    return out;
  }
  function el(tag, cls, css) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (css) Object.assign(e.style, css);
    return e;
  }

  var HI_STROKE = 2;
  var HI_OUTSET = 2;
  var HI_DEFAULT_RADIUS = 8;
  var HI_PAD = HI_OUTSET + HI_STROKE * 0.5;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var HI_ANIM_CLASSES = ['tourly-hi-anim-fade-in', 'tourly-hi-anim-sweep', 'tourly-hi-anim-pulse', 'tourly-hi-anim-glow'];

  function parsePx(val) {
    var n = parseFloat(val);
    return isNaN(n) ? 0 : n;
  }

  function colorAlpha(css) {
    if (!css || css === 'transparent') return 0;
    var m = css.match(/rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*([\d.]+))?\s*\)/);
    if (m) return m[1] != null ? parseFloat(m[1]) : 1;
    return 1;
  }

  function isTransparentSurface(cs) {
    if (colorAlpha(cs.backgroundColor) >= 0.08) return false;
    var img = cs.backgroundImage;
    return !img || img === 'none';
  }

  function isTextLikeNode(node) {
    if (!node || node.nodeType !== 1) return false;
    var tag = node.tagName;
    if (/^(P|H[1-6]|SPAN|A|LABEL|LI|TD|TH|EM|STRONG|B|I|SMALL|FIGCAPTION|BLOCKQUOTE|CITE|CODE|PRE|DT|DD|LEGEND|CAPTION)$/.test(tag)) return true;
    var cs = window.getComputedStyle(node);
    if (cs.display === 'inline') return true;
    if (node.children.length === 0) {
      var t = (node.textContent || '').trim();
      if (t && t.length <= 240) return true;
    }
    return false;
  }

  function readCornerRadii(cs, rect, transparentDefault) {
    var tl = parsePx(cs.borderTopLeftRadius);
    var tr = parsePx(cs.borderTopRightRadius);
    var br = parsePx(cs.borderBottomRightRadius);
    var bl = parsePx(cs.borderBottomLeftRadius);
    var maxR = Math.max(0, Math.min(rect.width, rect.height) / 2);
    tl = Math.min(tl, maxR);
    tr = Math.min(tr, maxR);
    br = Math.min(br, maxR);
    bl = Math.min(bl, maxR);
    if (transparentDefault && (tl + tr + br + bl) < 1) {
      tl = tr = br = bl = Math.min(HI_DEFAULT_RADIUS, maxR);
    }
    return {
      tl: tl, tr: tr, br: br, bl: bl,
      css: tl + 'px ' + tr + 'px ' + br + 'px ' + bl + 'px'
    };
  }

  function roundedRectPath(x, y, w, h, rtl, rtr, rbr, rbl) {
    rtl = Math.min(rtl, w / 2, h / 2);
    rtr = Math.min(rtr, w / 2, h / 2);
    rbr = Math.min(rbr, w / 2, h / 2);
    rbl = Math.min(rbl, w / 2, h / 2);
    return 'M' + (x + rtl) + ' ' + y +
      ' H' + (x + w - rtr) +
      (rtr ? ' A' + rtr + ' ' + rtr + ' 0 0 1 ' + (x + w) + ' ' + (y + rtr) : '') +
      ' V' + (y + h - rbr) +
      (rbr ? ' A' + rbr + ' ' + rbr + ' 0 0 1 ' + (x + w - rbr) + ' ' + (y + h) : '') +
      ' H' + (x + rbl) +
      (rbl ? ' A' + rbl + ' ' + rbl + ' 0 0 1 ' + x + ' ' + (y + h - rbl) : '') +
      ' V' + (y + rtl) +
      (rtl ? ' A' + rtl + ' ' + rtl + ' 0 0 1 ' + (x + rtl) + ' ' + y : '') +
      ' Z';
  }

  function normalizeConfig(cfg) {
    cfg = cfg || {};
    var c = {
      id: cfg.id || null,
      version: cfg.version || 1,
      name: cfg.name || 'Untitled tour',
      pageUrl: cfg.pageUrl || null,
      video: Object.assign({ provider: 'vidzflow', embedUrl: '', videoId: null, duration: null }, cfg.video || {}),
      scrollPoints: (cfg.scrollPoints || []).slice(),
      subtitles: (cfg.subtitles || []).slice(),
      highlights: (cfg.highlights || []).slice(),
      theme: deepMerge(DEFAULTS.theme, cfg.theme || {}),
      behavior: deepMerge(DEFAULTS.behavior, cfg.behavior || {})
    };
    c.scrollPoints.sort(function (a, b) { return a.time - b.time; });
    c.highlights.sort(function (a, b) { return a.start - b.start; });
    return c;
  }

  // ========================================================================
  //  TourController
  // ========================================================================
  function TourController(config, options) {
    this.opts = options || {};
    this.mode = this.opts.mode || 'live';
    this.config = normalizeConfig(config);

    // playback / clock state (dead-reckoning between timeupdate events)
    this.state = 'idle';        // 'idle' | 'playing' | 'paused' | 'ended'
    this._anchorSeconds = 0;
    this._anchorNow = now();
    this._playerReady = false;
    this._duration = this.config.video.duration || 0;

    // scroll state
    this._activeIdx = -2;       // -2 = uninitialised, -1 = before first point
    this._prevT = 0;
    this._tweenRAF = 0;
    this._programmatic = false;

    this._listeners = {};
    this._lastSub = null;
    this._toastTimer = 0;
    this._destroyed = false;
    this._subtitlesEnabled = true;   // CC toggle on the video
    this._subVisible = false;
    this._subLift = 0;               // px the subtitle is raised while the toast is showing
    this._attempts = [];             // recent scroll-attempt weights → sustained attempts auto-pause
    this._scrolledWhilePaused = false; // user moved the page while paused → resume uses scroll tween
    this._pendingPlay = false;       // play() before player ready
    this._videoWarmed = false;
    this._hiTargetNodes = {};        // highlight id → DOM node with text-glow class
    this._volume = 100;              // 0–100
    this._lastVolume = 100;          // restore level after unmuting
    this._muted = false;

    this._resortPoints();
    this._buildDOM();
    this._applyTheme();
    this._initPlayer();
    this._bindListeners();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);

    if (this.mode === 'live' && this.config.behavior.startTrigger === 'onLoad') {
      var self = this;
      this.once('ready', function () { self.play(); });
    }
  }

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  TourController.prototype._resortPoints = function () {
    this._points = this.config.scrollPoints.slice().sort(function (a, b) { return a.time - b.time; });
  };

  // ---- DOM ----------------------------------------------------------------
  TourController.prototype._buildDOM = function () {
    var self = this;
    var root = el('div', 'tourly-root');
    root.setAttribute('data-tourly', VERSION);
    Object.assign(root.style, { position: 'fixed', zIndex: 2147483000, inset: '0', pointerEvents: 'none' });

    // video dock
    var dock = el('div', 'tourly-dock');
    Object.assign(dock.style, { position: 'fixed', pointerEvents: 'auto', overflow: 'hidden', background: '#000', boxShadow: '0 10px 40px rgba(0,0,0,.35)' });

    var mediaEl;
    if (this.opts.previewVideoUrl) {
      // Editor preview: our own <video> (no controls) — fully controllable, pausable on any frame,
      // and crucially shows NO player play-button when paused (unlike the vidzflow iframe).
      var video = el('video');
      video.src = this.opts.previewVideoUrl;
      video.playsInline = true; video.setAttribute('playsinline', '');
      video.preload = 'auto';
      Object.assign(video.style, { display: 'block', width: '100%', height: '100%', border: '0', objectFit: 'cover', background: '#000' });
      this._video = video; mediaEl = video;
      this._warmVideo(video);
    } else {
      var iframe;
      if (this.opts.iframe) {
        iframe = this.opts.iframe;
      } else {
        iframe = el('iframe');
        iframe.src = this.config.video.embedUrl;
        iframe.setAttribute('allow', 'autoplay; fullscreen');
        iframe.setAttribute('scrolling', 'no');   // prevent a scrollbar inside the embed
      }
      Object.assign(iframe.style, { display: 'block', width: '100%', height: '100%', border: '0', overflow: 'hidden' });
      this._iframe = iframe; mediaEl = iframe;
    }
    dock.appendChild(mediaEl);

    // transparent click-catcher over the video to toggle pause/resume
    if (this.config.behavior.pauseOnVideoClick) {
      var catcher = el('div', 'tourly-clickcatch');
      Object.assign(catcher.style, { position: 'absolute', inset: '0', cursor: 'pointer', background: 'transparent' });
      catcher.addEventListener('click', function () { self.toggle(); });
      dock.appendChild(catcher);
      this._catcher = catcher;
    }

    // subtitle (CC) toggle button on the video
    var cc = el('button', 'tourly-cc');
    cc.type = 'button';
    cc.textContent = 'CC';
    Object.assign(cc.style, {
      position: 'absolute', bottom: '8px', left: '8px', zIndex: 5,
      font: '700 11px system-ui, sans-serif', letterSpacing: '.5px', lineHeight: '1',
      padding: '4px 7px', borderRadius: '5px', cursor: 'pointer', border: '0',
      background: 'rgba(0,0,0,.55)', color: '#fff', pointerEvents: 'auto'
    });
    cc.addEventListener('click', function (e) { e.stopPropagation(); self._toggleSubtitles(); });
    dock.appendChild(cc);
    this._ccBtn = cc;

    // close button (top-right) — visible only when the tour is not playing; slides the tour off-screen
    var closeBtn = el('button', 'tourly-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close tour');
    closeBtn.innerHTML = '×';
    Object.assign(closeBtn.style, {
      position: 'absolute', top: '8px', right: '8px', zIndex: 6,
      width: '26px', height: '26px', padding: '0', borderRadius: '50%', border: '0', cursor: 'pointer',
      background: 'rgba(0,0,0,.6)', color: '#fff', font: '700 16px system-ui, sans-serif', lineHeight: '1',
      display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto'
    });
    closeBtn.addEventListener('click', function (e) { e.stopPropagation(); self.close(); });
    dock.appendChild(closeBtn);
    this._closeBtn = closeBtn;
    if (this.mode === 'edit') closeBtn.style.display = 'none';   // no close button while editing

    // volume control (bottom-right): mute toggle + slider
    var vol = el('div', 'tourly-vol');
    Object.assign(vol.style, {
      position: 'absolute', bottom: '8px', right: '8px', zIndex: 5,
      display: 'flex', alignItems: 'center', gap: '6px',
      background: 'rgba(0,0,0,.5)', borderRadius: '14px', padding: '4px 8px', pointerEvents: 'auto'
    });
    vol.addEventListener('click', function (e) { e.stopPropagation(); });
    var volBtn = el('button', 'tourly-vol-btn');
    volBtn.type = 'button';
    volBtn.setAttribute('aria-label', 'Mute / unmute');
    Object.assign(volBtn.style, { background: 'transparent', border: '0', cursor: 'pointer', color: '#fff', padding: '0', display: 'flex', lineHeight: '0' });
    volBtn.addEventListener('click', function (e) { e.stopPropagation(); self._toggleMute(); });
    var range = el('input', 'tourly-vol-range');
    range.type = 'range'; range.min = '0'; range.max = '100'; range.value = '100';
    Object.assign(range.style, { width: '64px', cursor: 'pointer', accentColor: '#fff' });
    range.addEventListener('input', function (e) { e.stopPropagation(); self._setVolume(+range.value); });
    range.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    vol.appendChild(volBtn);
    vol.appendChild(range);
    dock.appendChild(vol);
    this._volEl = vol; this._volBtn = volBtn; this._volRange = range;

    // start / resume big button (idle + user-paused)
    var startBtn = el('button', 'tourly-startbtn');
    startBtn.type = 'button';
    startBtn.innerHTML = playIconSVG() + '<span>Start tour</span>';
    Object.assign(startBtn.style, {
      position: 'absolute', inset: '0', display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,.5)', color: '#fff', border: '0', cursor: 'pointer',
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      font: '600 14px system-ui, sans-serif', pointerEvents: 'auto'
    });
    startBtn.addEventListener('click', function () { self && self.toggle(); });
    dock.appendChild(startBtn);
    this._startBtn = startBtn;
    if (this.mode === 'edit') startBtn.style.display = 'none';   // editor scrubs via its timeline instead

    // subtitle layer (page-level, centered bottom) — animates up on appear and lifts above the toast
    var sub = el('div', 'tourly-sub');
    Object.assign(sub.style, {
      position: 'fixed', left: '50%', bottom: '24px',
      transform: 'translateX(-50%) translateY(8px)', opacity: '0',
      transition: 'transform .22s ease, opacity .22s ease',
      textAlign: 'center', pointerEvents: 'none', boxSizing: 'border-box'
    });
    this._subEl = sub;

    // scroll-attempt toast (centered bottom)
    var toast = el('div', 'tourly-toast');
    Object.assign(toast.style, {
      position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%) translateY(24px)',
      display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px',
      pointerEvents: 'auto', opacity: '0', transition: 'opacity .2s ease, transform .2s ease',
      font: '500 13px system-ui, sans-serif', whiteSpace: 'nowrap'
    });
    var toastText = el('span', 'tourly-toast-text');
    var toastBtn = el('button', 'tourly-toast-btn');
    toastBtn.type = 'button';
    toastBtn.textContent = 'Pause';
    Object.assign(toastBtn.style, { cursor: 'pointer', border: '0', borderRadius: '6px', padding: '5px 10px', font: '600 13px system-ui, sans-serif' });
    toastBtn.addEventListener('click', function () { self && self.pause(); self && self._hideToast(); });
    toast.appendChild(toastText);
    toast.appendChild(toastBtn);
    this._toast = toast;
    this._toastText = toastText;
    this._toastBtn = toastBtn;

    root.appendChild(dock);
    root.appendChild(sub);
    root.appendChild(toast);
    (document.body || document.documentElement).appendChild(root);
    this._root = root;
    this._dock = dock;
    this._updateCCButton();
    this._updateVolIcon();
  };

  function playIconSVG() {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  }
  function speakerBase() { return '<path d="M3 9v6h4l5 5V4L7 9H3z"/>'; }
  function volIconHigh() { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + speakerBase() + '<path d="M16 7.5a5 5 0 010 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18.5 5a8.5 8.5 0 010 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'; }
  function volIconLow() { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + speakerBase() + '<path d="M16 7.5a5 5 0 010 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'; }
  function volIconMute() { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + speakerBase() + '<path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'; }

  // ---- theme --------------------------------------------------------------
  TourController.prototype._applyTheme = function () {
    var t = this.config.theme;
    var isMobile = window.matchMedia('(max-width:' + (this.config.behavior.mobile.breakpoint || 768) + 'px)').matches;
    var v = t.video, m = this.config.behavior.mobile;

    // dock geometry. `offsetBottom` raises bottom-anchored elements without touching the horizontal
    // margin (the editor uses it to lift the preview above the timeline bar).
    var mm = (v.margin || 24);
    var ob = (v.offsetBottom || 0);
    var margin = mm + 'px';
    var bottomM = (mm + ob) + 'px';
    var width = isMobile ? (m.videoWidth || '45vw') : (typeof v.width === 'number' ? v.width + 'px' : v.width);
    var pos = isMobile ? (m.position || 'bottom-center') : (v.position || 'bottom-right');
    var radius = v.radius != null ? v.radius : 8;
    var radiusPx = radius + 'px';
    Object.assign(this._dock.style, {
      width: width, height: 'auto', aspectRatio: '16 / 9', borderRadius: radiusPx
    });
    if (this._video) this._video.style.borderRadius = radiusPx;
    if (this._iframe) this._iframe.style.borderRadius = radiusPx;
    // position presets
    this._dock.style.top = this._dock.style.right = this._dock.style.bottom = this._dock.style.left = 'auto';
    this._dock.style.transform = 'none';
    if (pos === 'bottom-right') { this._dock.style.bottom = bottomM; this._dock.style.right = margin; }
    else if (pos === 'bottom-left') { this._dock.style.bottom = bottomM; this._dock.style.left = margin; }
    else if (pos === 'top-right') { this._dock.style.top = margin; this._dock.style.right = margin; }
    else if (pos === 'top-left') { this._dock.style.top = margin; this._dock.style.left = margin; }
    else if (pos === 'bottom-center') { this._dock.style.bottom = bottomM; this._dock.style.left = '50%'; this._dock.style.transform = 'translateX(-50%)'; }

    // subtitles — share the same gap from the bottom as the video (its margin)
    var s = t.subtitles;
    Object.assign(this._subEl.style, {
      maxWidth: (s.maxWidth || 80) + '%',
      font: (s.weight || 500) + ' ' + (s.size || 16) + 'px ' + (s.font || 'inherit'),
      color: s.color || '#fff',
      bottom: bottomM
    });
    this._toast.style.bottom = bottomM;
    this._subStyle = s;

    // toast
    var n = t.notification;
    Object.assign(this._toast.style, { background: n.bg || '#111', color: n.textColor || '#fff', borderRadius: (n.radius || 8) + 'px', boxShadow: '0 8px 30px rgba(0,0,0,.35)' });
    this._toastText.textContent = n.text || DEFAULTS.theme.notification.text;
    Object.assign(this._toastBtn.style, { background: '#fff', color: '#111' });

    if (this._catcher) this._catcher.style.borderRadius = radiusPx;
    if (this._startBtn) this._startBtn.style.borderRadius = radiusPx;
  };

  // A minimal Player.js-shaped adapter over a native <video> (used for the editor preview).
  function makeNativeAdapter(video) {
    var listeners = {};
    function emit(evt, data) { (listeners[evt] || []).slice().forEach(function (f) { f(data); }); }
    video.addEventListener('timeupdate', function () { emit('timeupdate', { seconds: video.currentTime, duration: video.duration }); });
    video.addEventListener('play', function () { emit('play'); });
    video.addEventListener('pause', function () { emit('pause'); });
    video.addEventListener('ended', function () { emit('ended'); });
    video.addEventListener('seeked', function () { emit('seeked', { seconds: video.currentTime }); });
    function fireReady() { emit('ready'); }
    if (video.readyState >= 1) setTimeout(fireReady, 0);
    else video.addEventListener('loadedmetadata', fireReady, { once: true });
    return {
      on: function (evt, cb) { (listeners[evt] = listeners[evt] || []).push(cb); },
      off: function (evt, cb) { listeners[evt] = (listeners[evt] || []).filter(function (f) { return f !== cb; }); },
      getDuration: function (cb) { cb(video.duration || 0); },
      getCurrentTime: function (cb) { cb(video.currentTime || 0); },
      getVolume: function (cb) { cb(video.muted ? 0 : Math.round(video.volume * 100)); },
      setCurrentTime: function (s) { try { video.currentTime = s; } catch (e) {} },
      play: function () { var pr = video.play(); if (pr && pr.catch) pr.catch(function () {}); },
      pause: function () { video.pause(); },
      mute: function () { video.muted = true; },
      unmute: function () { video.muted = false; },
      setVolume: function (v) { video.volume = Math.max(0, Math.min(1, v / 100)); if (v > 0) video.muted = false; }
    };
  }

  // ---- player -------------------------------------------------------------
  TourController.prototype._initPlayer = function () {
    var self = this;
    var p;
    if (this._video) {
      p = makeNativeAdapter(this._video);
    } else {
      if (typeof window.playerjs === 'undefined') {
        console.warn('[Tourly] Player.js not found — playback control disabled.');
        return;
      }
      p = new window.playerjs.Player(this._iframe);
    }
    this._player = p;
    p.on('ready', function () {
      if (self._destroyed) return;
      self._playerReady = true;
      p.getDuration(function (d) { if (d) { self._duration = d; self.config.video.duration = d; } });
      // sync the volume slider to the player's actual level
      try {
        p.getVolume(function (v) {
          if (typeof v === 'number') {
            self._volume = v; self._muted = (v === 0); if (v > 0) self._lastVolume = v;
            if (self._volRange) self._volRange.value = String(v);
            self._updateVolIcon();
          }
        });
      } catch (e) { /* older adapters may lack getVolume */ }
      p.on('timeupdate', function (d) {
        if (typeof d.seconds === 'number') { self._anchorSeconds = d.seconds; self._anchorNow = now(); }
        if (d.duration) self._duration = d.duration;
      });
      // Refresh the dead-reckoning epoch whenever the player actually starts — otherwise
      // getTime() leaps forward by (now - last timeupdate), then snaps back on the next tick.
      p.on('play', function () { self._anchorNow = now(); self._setState('playing'); });
      p.on('pause', function () {
        if (self.state === 'playing') {
          self._anchorSeconds = self.getTime();
          self._anchorNow = now();
          self._setState('paused');
        }
      });
      p.on('ended', function () { self._anchorSeconds = self._duration; self._anchorNow = now(); self._setState('ended'); });
      p.on('seeked', function (d) { if (d && typeof d.seconds === 'number') { self._anchorSeconds = d.seconds; self._anchorNow = now(); } });
      if (self._pendingPlay) { self._pendingPlay = false; p.play(); }
      self._emit('ready');
    });
  };

  // ---- clock --------------------------------------------------------------
  TourController.prototype.getTime = function () {
    if (this.state === 'playing') return this._anchorSeconds + (now() - this._anchorNow) / 1000;
    return this._anchorSeconds;
  };
  TourController.prototype.getDuration = function () { return this._duration || 0; };

  // ---- transport ----------------------------------------------------------
  TourController.prototype._beginPlayback = function () {
    this._scrolledWhilePaused = false;
    this._anchorNow = now();
    if (this._player && this._playerReady) this._player.play();
    else this._pendingPlay = true;
    this._setState('playing');
  };

  TourController.prototype.play = function () {
    var self = this;
    if (this._startBtn) this._startBtn.style.display = 'none';
    // Pan to the correct scroll position for the current time, then start the video.
    // Resume-after-user-scroll uses a short tween; first start and editor scrubbing snap instantly.
    var info = this._activeForTime(this._anchorSeconds);
    var go = function () {
      self._activeIdx = info.idx;
      self._beginPlayback();
    };
    var aligned = info.y == null || Math.abs(window.scrollY - info.y) < 2;
    var snapOnly = this.state === 'idle' || this.state === 'ended'
      || (this.mode === 'edit' && !this._isLivePreview())
      || !this._scrolledWhilePaused;
    if (aligned) go();
    else if (snapOnly) { this._snapScroll(info.y); go(); }
    else this._startTween(info.y, 0.6, easingFn(info.idx >= 0 && this._points[info.idx] && this._points[info.idx].easing), go);
  };

  TourController.prototype._activeForTime = function (t) {
    var pts = this._points, idx = -1;
    for (var i = 0; i < pts.length; i++) { if (pts[i].time <= t) idx = i; else break; }
    var y = idx >= 0 ? this.resolveTargetY(pts[idx].target) : 0;
    return { idx: idx, y: y };
  };
  TourController.prototype.pause = function () {
    // Freeze the dead-reckoned clock BEFORE pausing the player (the player's 'pause'
    // event also flips state, which would make a later getTime() drop the fractional advance).
    if (this.state === 'playing') {
      this._anchorSeconds = this.getTime();
      this._anchorNow = now();
    }
    if (this._player && this._playerReady) this._player.pause();
    this._setState('paused');
  };
  TourController.prototype.toggle = function () {
    if (this.state === 'playing') this.pause(); else this.play();
  };
  TourController.prototype.close = function () {
    if (this._closed) return;
    this._closed = true;
    var self = this;
    this.pause();
    if (this._closeBtn) this._closeBtn.style.display = 'none';
    // slide the tour dock off to the right, then tear everything down and unlock the page
    this._subVisible = false; this._updateSubPosition();
    this._hideToast();
    this._dock.style.transition = 'transform .35s ease, opacity .35s ease';
    this._dock.style.transform = 'translateX(140%)';
    this._dock.style.opacity = '0';
    this._emit('close');
    setTimeout(function () { self.destroy(); }, 380);
  };
  TourController.prototype.seek = function (sec) {
    sec = clamp(sec, 0, this._duration || sec);
    this._anchorSeconds = sec; this._anchorNow = now();
    this._scrolledWhilePaused = false;
    if (this._player && this._playerReady) this._player.setCurrentTime(sec);
    // relocate scroll immediately (snap) to the region for this time
    this._activeIdx = -2; // force re-evaluation
    this._syncScroll(sec, true);
    this._syncHighlights(sec);
  };

  TourController.prototype._setState = function (s) {
    if (this.state === s) return;
    this.state = s;
    this._updateSubPosition();   // slide subtitles off when leaving 'playing', back in when resuming
    var playingLike = (s === 'playing');
    // start/resume button visible only when not playing (and there is a video)
    if (this._startBtn) {
      var hideStart = playingLike || (this.mode === 'edit' && !this._isLivePreview());
      this._startBtn.style.display = hideStart ? 'none' : 'flex';
      var label = this._startBtn.querySelector('span');
      if (label) label.textContent = (s === 'idle') ? 'Start tour' : (s === 'ended') ? 'Replay tour' : 'Resume tour';
    }
    if (this._closeBtn && !this._closed) this._closeBtn.style.display = (playingLike || this.mode === 'edit') ? 'none' : 'flex';
    if (!playingLike) this._hideToast();
    this._emit('statechange', s);
    this._emit(s);
  };

  // ---- main loop ----------------------------------------------------------
  TourController.prototype._loop = function () {
    if (this._destroyed) return;
    var t = this.getTime();
    this._syncScroll(t, false);
    this._syncSubtitles(t);
    this._syncHighlights(t);
    this._emit('timeupdate', t);
    this._raf = requestAnimationFrame(this._loop);
  };

  // ---- scroll engine ------------------------------------------------------
  TourController.prototype.resolveTargetY = function (target) {
    if (!target) return null;
    var maxY = maxScrollY();
    if (target.mode === 'manual') {
      var pct = typeof target.manualPercent === 'number' ? target.manualPercent : 0;
      return clamp((pct / 100) * maxY, 0, maxY);
    }
    var node = this._queryTarget(target);
    if (!node) return null;
    var rect = node.getBoundingClientRect();
    var top = rect.top + window.scrollY;
    var y;
    var anchor = target.viewportAnchor || 'top';
    if (anchor === 'center') y = top - (window.innerHeight / 2 - rect.height / 2);
    else if (anchor === 'custom') y = top - (target.viewportOffset || 0);
    else y = top; // 'top'
    y += (target.offsetPx || 0);
    return clamp(y, 0, maxY);
  };

  TourController.prototype._queryTarget = function (target) {
    var sels = [];
    if (target.selector) sels.push(target.selector);
    if (Array.isArray(target.selectorFallbacks)) sels = sels.concat(target.selectorFallbacks);
    for (var i = 0; i < sels.length; i++) {
      try { var n = document.querySelector(sels[i]); if (n) return n; } catch (e) { /* bad selector */ }
    }
    return null;
  };

  TourController.prototype._syncScroll = function (t, forceSnap) {
    var pts = this._points;
    var idx = -1;
    for (var i = 0; i < pts.length; i++) { if (pts[i].time <= t) idx = i; else break; }
    var dt = t - this._prevT;
    var isSeek = forceSnap || Math.abs(dt) > SEEK_THRESHOLD;
    this._prevT = t;

    if (idx !== this._activeIdx) {
      this._activeIdx = idx;
      // idx === -1 means we're before the first keyframe → hold at the top of the page (the tour intro)
      var y = (idx >= 0) ? this.resolveTargetY(pts[idx].target) : 0;
      var pt = idx >= 0 ? pts[idx] : null;
      var ease = (pt && pt.ease != null) ? pt.ease : DEFAULT_EASE;
      if (y != null) {
        if (isSeek || this.state !== 'playing') this._snapScroll(y);
        else this._startTween(y, ease, easingFn(pt && pt.easing));
      }
    } else if (isSeek && idx >= 0) {
      var y2 = this.resolveTargetY(pts[idx].target);
      if (y2 != null) this._snapScroll(y2);
    }
  };

  TourController.prototype._startTween = function (targetY, dur, ease, onDone) {
    var easeF = (typeof ease === 'function') ? ease : easeInOutCubic;
    if (this._tweenRAF) cancelAnimationFrame(this._tweenRAF);
    var self = this;
    var startY = window.scrollY;
    var delta = targetY - startY;
    if (Math.abs(delta) < 1) { if (onDone) onDone(); return; }
    var start = now();
    var D = Math.max(1, (dur || DEFAULT_EASE) * 1000);
    function step() {
      if (self._destroyed) return;
      var p = clamp((now() - start) / D, 0, 1);
      self._programmatic = true;
      window.scrollTo(0, startY + delta * easeF(p));
      self._programmatic = false;
      if (p < 1) self._tweenRAF = requestAnimationFrame(step);
      else { self._tweenRAF = 0; if (onDone) onDone(); }
    }
    this._tweenRAF = requestAnimationFrame(step);
  };

  TourController.prototype._snapScroll = function (y) {
    if (this._tweenRAF) { cancelAnimationFrame(this._tweenRAF); this._tweenRAF = 0; }
    this._programmatic = true;
    window.scrollTo(0, y);
    this._programmatic = false;
  };

  // ---- subtitles ----------------------------------------------------------
  TourController.prototype._syncSubtitles = function (t) {
    var manual = null, auto = null;
    if (this._subtitlesEnabled) {
      for (var i = 0; i < this.config.subtitles.length; i++) {
        var c = this.config.subtitles[i];
        if (t >= c.start && t < c.end) {
          if (c.source === 'manual') manual = c;
          else auto = c;
        }
      }
    }
    var cue = manual || auto;
    var text = cue ? cue.text : '';
    if (text === this._lastSub) return;
    this._lastSub = text;
    if (!text) { this._subVisible = false; this._updateSubPosition(); return; }
    var s = this._subStyle || DEFAULTS.theme.subtitles;
    this._subEl.innerHTML = '';
    var span = el('span');
    Object.assign(span.style, {
      display: 'inline-block', padding: '4px 12px', lineHeight: '1.35',
      background: s.bg || 'rgba(0,0,0,.62)', borderRadius: (s.radius || 8) + 'px'
    });
    span.textContent = text;
    this._subEl.appendChild(span);
    this._subVisible = true;
    this._updateSubPosition();
  };

  // Position/opacity of the subtitle: rests at the video's bottom gap, lifts above the toast when it
  // shows, and slides fully off the bottom of the screen while the tour is paused (live mode only).
  TourController.prototype._ensureHiStyles = function () {
    var existing = document.getElementById('tourly-hi-styles');
    if (existing) existing.remove();
    var s = document.createElement('style');
    s.id = 'tourly-hi-styles';
    s.textContent = [
      '.tourly-hi-layer{position:fixed;inset:0;pointer-events:none;z-index:2147482000}',
      '.tourly-hi-overlay{position:fixed;pointer-events:none;box-sizing:border-box;background:transparent;border:none;opacity:1;transform:translateZ(0)}',
      '.tourly-hi-ring{position:absolute;inset:0;width:100%;height:100%;overflow:visible}',
      '.tourly-hi-ring-path{stroke:var(--tly-hi-color,#ff4d8d);stroke-width:var(--tly-hi-stroke,2);fill:none;vector-effect:non-scaling-stroke}',
      '.tourly-hi-kind-box.tourly-hi-anim-fade-in .tourly-hi-ring-path{animation-name:tourlyHiRingFade;animation-duration:var(--tly-hi-duration,2.4s);animation-timing-function:ease-in-out;animation-iteration-count:1;animation-fill-mode:both}',
      '@keyframes tourlyHiRingFade{0%{opacity:0}25%{opacity:1}75%{opacity:1}100%{opacity:0}}',
      '.tourly-hi-kind-box.tourly-hi-anim-pulse .tourly-hi-ring-path{animation:tourlyHiRingPulse 1.35s ease-in-out infinite}',
      '@keyframes tourlyHiRingPulse{0%,100%{stroke-opacity:1;stroke-width:var(--tly-hi-stroke,2)}12%{stroke-opacity:.42;stroke-width:calc(var(--tly-hi-stroke,2) + 1.5px)}24%{stroke-opacity:1;stroke-width:var(--tly-hi-stroke,2)}44%{stroke-opacity:.42;stroke-width:calc(var(--tly-hi-stroke,2) + 1.5px)}56%{stroke-opacity:1;stroke-width:var(--tly-hi-stroke,2)}76%{stroke-opacity:.42;stroke-width:calc(var(--tly-hi-stroke,2) + 1.5px)}88%{stroke-opacity:1;stroke-width:var(--tly-hi-stroke,2)}}',
      '.tourly-hi-kind-box.tourly-hi-anim-glow .tourly-hi-ring-path{animation-name:tourlyHiRingGlow;animation-duration:var(--tly-hi-duration,2.4s);animation-timing-function:ease-in-out;animation-iteration-count:1;animation-fill-mode:both;filter:drop-shadow(0 0 5px var(--tly-hi-color,#ff4d8d)) drop-shadow(0 0 12px var(--tly-hi-color,#ff4d8d))}',
      '@keyframes tourlyHiRingGlow{0%{opacity:0}25%{opacity:1}75%{opacity:1}100%{opacity:0}}',
      '.tourly-hi-kind-box.tourly-hi-anim-sweep .tourly-hi-ring-path{animation-name:tourlyHiRingSweepDash;animation-duration:var(--tly-hi-duration,2.4s);animation-timing-function:ease-in-out;animation-iteration-count:1;animation-fill-mode:both}',
      '@keyframes tourlyHiRingSweepDash{0%{stroke-dashoffset:var(--tly-hi-perimeter,400)}25%{stroke-dashoffset:0}75%{stroke-dashoffset:0}100%{stroke-dashoffset:var(--tly-hi-perimeter-neg,-400)}}',
      '.tourly-hi-target-text.tourly-hi-anim-fade-in{animation-name:tourlyHiTextFade;animation-duration:var(--tly-hi-duration,2.4s);animation-timing-function:ease-in-out;animation-iteration-count:1;animation-fill-mode:both}',
      '@keyframes tourlyHiTextFade{0%{text-shadow:0 0 8px transparent,0 0 16px transparent}25%{text-shadow:0 0 8px var(--tly-hi-color,#ff4d8d),0 0 16px var(--tly-hi-color,#ff4d8d)}75%{text-shadow:0 0 8px var(--tly-hi-color,#ff4d8d),0 0 16px var(--tly-hi-color,#ff4d8d)}100%{text-shadow:0 0 8px transparent,0 0 16px transparent}}',
      '.tourly-hi-target-text.tourly-hi-anim-pulse{animation:tourlyHiTextPulse 1.35s ease-in-out infinite}',
      '@keyframes tourlyHiTextPulse{0%,100%{text-shadow:0 0 6px var(--tly-hi-color,#ff4d8d),0 0 12px var(--tly-hi-color,#ff4d8d)}12%{text-shadow:0 0 14px var(--tly-hi-color,#ff4d8d),0 0 28px var(--tly-hi-color,#ff4d8d)}24%{text-shadow:0 0 6px var(--tly-hi-color,#ff4d8d),0 0 12px var(--tly-hi-color,#ff4d8d)}44%{text-shadow:0 0 14px var(--tly-hi-color,#ff4d8d),0 0 28px var(--tly-hi-color,#ff4d8d)}56%{text-shadow:0 0 6px var(--tly-hi-color,#ff4d8d),0 0 12px var(--tly-hi-color,#ff4d8d)}76%{text-shadow:0 0 14px var(--tly-hi-color,#ff4d8d),0 0 28px var(--tly-hi-color,#ff4d8d)}88%{text-shadow:0 0 6px var(--tly-hi-color,#ff4d8d),0 0 12px var(--tly-hi-color,#ff4d8d)}}',
      '.tourly-hi-target-text.tourly-hi-anim-glow{animation-name:tourlyHiTextGlow;animation-duration:var(--tly-hi-duration,2.4s);animation-timing-function:ease-in-out;animation-iteration-count:1;animation-fill-mode:both}',
      '@keyframes tourlyHiTextGlow{0%{text-shadow:0 0 10px transparent,0 0 22px transparent,0 0 34px transparent}25%{text-shadow:0 0 10px var(--tly-hi-color,#ff4d8d),0 0 22px var(--tly-hi-color,#ff4d8d),0 0 34px var(--tly-hi-color,#ff4d8d)}75%{text-shadow:0 0 10px var(--tly-hi-color,#ff4d8d),0 0 22px var(--tly-hi-color,#ff4d8d),0 0 34px var(--tly-hi-color,#ff4d8d)}100%{text-shadow:0 0 10px transparent,0 0 22px transparent,0 0 34px transparent}}',
      '.tourly-hi-target-text.tourly-hi-anim-sweep{animation-name:tourlyHiTextSweep;animation-duration:var(--tly-hi-duration,2.4s);animation-timing-function:ease-in-out;animation-iteration-count:1;animation-fill-mode:both}',
      '@keyframes tourlyHiTextSweep{0%{text-shadow:0 0 8px transparent,0 0 18px transparent}25%{text-shadow:0 0 8px var(--tly-hi-color,#ff4d8d),0 0 18px var(--tly-hi-color,#ff4d8d)}75%{text-shadow:0 0 8px var(--tly-hi-color,#ff4d8d),0 0 18px var(--tly-hi-color,#ff4d8d)}100%{text-shadow:0 0 8px transparent,0 0 18px transparent}}'
    ].join('');
    document.head.appendChild(s);
  };

  TourController.prototype._buildHiLayer = function () {
    if (this._hiLayer) return;
    this._ensureHiStyles();
    this._hiLayer = el('div', 'tourly-hi-layer');
    (document.body || document.documentElement).appendChild(this._hiLayer);
    this._hiOverlays = {};
    this._hiActiveKey = '';
    this._hiTargetStyleKey = {};
  };

  TourController.prototype._hiStyleKey = function (h, kind, anim) {
    var span = Math.max(0.1, (h.end || 0) - (h.start || 0));
    return kind + '|' + anim + '|' + (h.color || '#ff4d8d') + '|' + span.toFixed(2);
  };

  TourController.prototype._hiSpan = function (h) {
    return Math.max(0.1, (h.end || 0) - (h.start || 0));
  };

  TourController.prototype._applyHiAnimTiming = function (ov, h, t, anim, kind, textNode, forceSync) {
    if (anim === 'pulse') return;
    var span = this._hiSpan(h);
    var dur = span.toFixed(3) + 's';
    var elapsed = clamp(t - h.start, 0, span);
    var delay = (-elapsed).toFixed(3) + 's';
    var lastT = ov._hiAnimLastT;
    var seeked = forceSync || lastT == null || Math.abs(t - lastT) > SEEK_THRESHOLD;
    ov._hiAnimLastT = t;
    ov.style.setProperty('--tly-hi-duration', dur);
    if (!seeked && ov._hiAnimTimed) return;
    ov._hiAnimTimed = true;
    var el = (kind === 'text') ? textNode : ov.querySelector('.tourly-hi-ring-path');
    if (!el) return;
    el.style.setProperty('--tly-hi-duration', dur);
    el.style.animationDuration = dur;
    el.style.animationDelay = delay;
    el.style.animationIterationCount = '1';
    el.style.animationFillMode = 'both';
  };

  TourController.prototype._measureHighlightForOverlay = function (node, ov) {
    var r = node.getBoundingClientRect();
    var rw = Math.round(r.width);
    var rh = Math.round(r.height);
    var layoutKey = rw + '|' + rh;
    var meta = ov._hiMeta;
    if (!meta || meta.node !== node || meta.layoutKey !== layoutKey) {
      var cs = window.getComputedStyle(node);
      var textLike = isTextLikeNode(node);
      var transparent = !textLike && isTransparentSurface(cs);
      var radii = readCornerRadii(cs, r, transparent);
      meta = { node: node, textLike: textLike, radii: radii, pad: HI_PAD, stroke: HI_STROKE, layoutKey: layoutKey };
      ov._hiMeta = meta;
    }
    meta.rect = r;
    return meta;
  };

  TourController.prototype._restartHiAnim = function (ov) {
    var path = ov.querySelector('.tourly-hi-ring-path');
    var ring = ov.querySelector('.tourly-hi-ring');
    if (path) {
      path.style.animation = 'none';
      path.style.opacity = '';
      path.style.strokeDashoffset = '';
      path.removeAttribute('stroke-dashoffset');
      void path.offsetWidth;
      path.style.animation = '';
    }
    if (ring) {
      ring.style.animation = 'none';
      void ring.offsetWidth;
      ring.style.animation = '';
    }
  };

  TourController.prototype._ensureHiRing = function (ov) {
    var svg = ov.querySelector('.tourly-hi-ring');
    if (!svg) {
      svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'tourly-hi-ring');
      svg.setAttribute('aria-hidden', 'true');
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', 'tourly-hi-ring-path');
      svg.appendChild(path);
      ov.appendChild(svg);
    }
    return svg;
  };

  TourController.prototype._layoutHiRing = function (ov, m) {
    var svg = this._ensureHiRing(ov);
    var w = Math.max(0, m.rect.width + m.pad * 2);
    var h = Math.max(0, m.rect.height + m.pad * 2);
    var inset = m.stroke / 2;
    var iw = Math.max(0, w - m.stroke);
    var ih = Math.max(0, h - m.stroke);
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    var path = svg.querySelector('.tourly-hi-ring-path');
    var d = roundedRectPath(inset, inset, iw, ih, m.radii.tl, m.radii.tr, m.radii.br, m.radii.bl);
    if (path.getAttribute('d') !== d) path.setAttribute('d', d);
    var len = path.getTotalLength();
    path.style.setProperty('--tly-hi-perimeter', String(len));
    path.style.setProperty('--tly-hi-perimeter-neg', String(-len));
    if (path.getAttribute('stroke-dasharray') !== String(len)) {
      path.setAttribute('stroke-dasharray', String(len));
    }
    svg.style.display = '';
  };

  TourController.prototype._clearHiTargetById = function (id) {
    var node = this._hiTargetNodes[id];
    if (!node) return;
    HI_ANIM_CLASSES.forEach(function (c) { node.classList.remove(c); });
    node.classList.remove('tourly-hi-target-text');
    node.style.removeProperty('--tly-hi-color');
    node.style.animation = '';
    delete this._hiTargetNodes[id];
    if (this._hiTargetStyleKey) delete this._hiTargetStyleKey[id];
  };

  TourController.prototype._clearAllHiTargets = function () {
    var self = this;
    Object.keys(this._hiTargetNodes || {}).forEach(function (id) { self._clearHiTargetById(id); });
  };

  TourController.prototype._applyHiTarget = function (h, m, anim) {
    if (!m || !m.textLike) return;
    var node = m.node;
    var span = this._hiSpan(h);
    var styleKey = anim + '|' + (h.color || '#ff4d8d') + '|' + span.toFixed(2);
    var prev = this._hiTargetNodes[h.id];
    if (prev && prev !== node) this._clearHiTargetById(h.id);
    if (this._hiTargetStyleKey[h.id] === styleKey && prev === node) return;
    this._hiTargetStyleKey[h.id] = styleKey;
    HI_ANIM_CLASSES.forEach(function (c) { node.classList.remove(c); });
    node.classList.add('tourly-hi-target-text', 'tourly-hi-anim-' + anim);
    node.style.setProperty('--tly-hi-color', h.color || '#ff4d8d');
    node.style.animation = 'none';
    void node.offsetWidth;
    node.style.animation = '';
    this._hiTargetNodes[h.id] = node;
  };

  TourController.prototype._layoutHiOverlay = function (h, ov, anim) {
    var node = this._queryTarget(h.target);
    if (!node) {
      this._clearHiTargetById(h.id);
      ov.style.display = 'none';
      ov._hiMeta = null;
      return null;
    }
    var m = this._measureHighlightForOverlay(node, ov);
    var pad = m.pad;
    var r = m.rect;
    if (m.textLike) {
      var ringHide = ov.querySelector('.tourly-hi-ring');
      if (ringHide) ringHide.style.display = 'none';
      ov.style.display = 'none';
      return m;
    }
    this._clearHiTargetById(h.id);
    ov.style.display = 'block';
    ov.style.left = Math.round(r.left - pad) + 'px';
    ov.style.top = Math.round(r.top - pad) + 'px';
    ov.style.width = Math.round(Math.max(0, r.width + pad * 2)) + 'px';
    ov.style.height = Math.round(Math.max(0, r.height + pad * 2)) + 'px';
    ov.style.borderRadius = m.radii.css;
    ov.style.setProperty('--tly-hi-stroke', String(m.stroke));
    var ring = ov.querySelector('.tourly-hi-ring');
    if (ring) ring.style.display = '';
    var width = Math.round(Math.max(0, r.width + pad * 2));
    var height = Math.round(Math.max(0, r.height + pad * 2));
    var layoutKey = [width, height, Math.round(m.radii.tl), Math.round(m.radii.tr), Math.round(m.radii.br), Math.round(m.radii.bl)].join('|');
    if (ov._hiLayoutKey !== layoutKey) {
      ov._hiLayoutKey = layoutKey;
      this._layoutHiRing(ov, m);
    }
    return m;
  };

  TourController.prototype._syncHighlights = function (t) {
    var list = this.config.highlights || [];
    if (!list.length) {
      if (this._hiLayer) {
        Object.keys(this._hiOverlays || {}).forEach(function (id) {
          this._hiOverlays[id].style.display = 'none';
          this._clearHiTargetById(id);
        }, this);
        this._hiActiveKey = '';
      }
      return;
    }
    this._buildHiLayer();
    var active = [], i;
    for (i = 0; i < list.length; i++) {
      var h = list[i];
      if (t >= h.start && t < h.end) active.push(h);
    }
    var activeKey = active.map(function (h) { return h.id; }).join(',');
    var seen = {};
    for (i = 0; i < active.length; i++) {
      h = active[i];
      seen[h.id] = true;
      var ov = this._hiOverlays[h.id];
      if (!ov) {
        ov = el('div', 'tourly-hi-overlay');
        this._hiLayer.appendChild(ov);
        this._hiOverlays[h.id] = ov;
      }
      var color = h.color || '#ff4d8d';
      var anim = (h.animation || 'pulse').replace(/\s+/g, '-');
      var node = this._queryTarget(h.target);
      if (!node) {
        ov.style.display = 'none';
        this._clearHiTargetById(h.id);
        continue;
      }
      var m = this._measureHighlightForOverlay(node, ov);
      var kind = m.textLike ? 'text' : 'box';
      var styleKey = this._hiStyleKey(h, kind, anim);
      var styleChanged = ov._hiStyleKey !== styleKey;
      if (styleChanged) {
        ov._hiStyleKey = styleKey;
        ov.className = 'tourly-hi-overlay tourly-hi-kind-' + kind + ' tourly-hi-anim-' + anim;
        ov.style.setProperty('--tly-hi-color', color);
        ov._hiAnimTimed = false;
        ov._hiAnimLastT = null;
      }
      m = this._layoutHiOverlay(h, ov, anim);
      if (!m) continue;
      if (m.textLike) {
        if (styleChanged || !this._hiTargetNodes[h.id]) this._applyHiTarget(h, m, anim);
        this._applyHiAnimTiming(ov, h, t, anim, kind, m.node, styleChanged);
      } else {
        if (styleChanged) this._restartHiAnim(ov);
        this._applyHiAnimTiming(ov, h, t, anim, kind, null, styleChanged);
      }
    }
    Object.keys(this._hiOverlays).forEach(function (id) {
      if (!seen[id]) {
        this._hiOverlays[id].style.display = 'none';
        this._clearHiTargetById(id);
        delete this._hiOverlays[id]._hiStyleKey;
        delete this._hiOverlays[id]._hiAnimTimed;
        delete this._hiOverlays[id]._hiAnimLastT;
      }
    }, this);
    this._hiActiveKey = activeKey;
  };

  TourController.prototype._updateSubPosition = function () {
    if (!this._subEl) return;
    var lift = this._subLift || 0;
    var playing = this.state === 'playing';
    var show = playing || (this.mode === 'edit' && !this._isLivePreview());
    var y, opacity;
    if (this._subVisible && show) {
      y = -lift; opacity = '1';                 // shown (lifted above the toast when present)
    } else if (this._subVisible && !show) {
      y = 120; opacity = '0';                   // paused with an active cue → slide off the bottom
    } else {
      y = 8; opacity = '0';                     // no active cue → subtle hidden rest state
    }
    this._subEl.style.transform = 'translateX(-50%) translateY(' + y + 'px)';
    this._subEl.style.opacity = opacity;
  };

  TourController.prototype._toggleSubtitles = function () {
    this._subtitlesEnabled = !this._subtitlesEnabled;
    this._updateCCButton();
    this._lastSub = null;                    // force re-render on next sync
    this._syncSubtitles(this.getTime());
  };

  TourController.prototype._updateCCButton = function () {
    if (!this._ccBtn) return;
    var on = this._subtitlesEnabled;
    this._ccBtn.style.opacity = on ? '1' : '0.5';
    this._ccBtn.style.outline = on ? '1px solid rgba(255,255,255,0.65)' : '1px solid transparent';
    this._ccBtn.title = on ? 'Hide subtitles' : 'Show subtitles';
  };

  TourController.prototype._setVolume = function (v) {
    v = clamp(Math.round(v), 0, 100);
    this._volume = v;
    this._muted = (v === 0);
    if (v > 0) this._lastVolume = v;
    if (this._player && this._playerReady) {
      try {
        this._player.setVolume(v);
        if (this._muted) this._player.mute(); else this._player.unmute();
      } catch (e) { /* player may not be ready */ }
    }
    if (this._volRange) this._volRange.value = String(v);
    this._updateVolIcon();
  };
  TourController.prototype._toggleMute = function () {
    if (this._volume === 0) this._setVolume(this._lastVolume || 100);
    else this._setVolume(0);
  };
  TourController.prototype._updateVolIcon = function () {
    if (!this._volBtn) return;
    var v = this._muted ? 0 : this._volume;
    this._volBtn.innerHTML = v === 0 ? volIconMute() : (v < 50 ? volIconLow() : volIconHigh());
    this._volBtn.title = v === 0 ? 'Unmute' : 'Mute';
  };

  TourController.prototype._isLivePreview = function () {
    return !!(this.config.behavior && this.config.behavior.previewTour);
  };

  // ---- scroll lock + toast ------------------------------------------------
  TourController.prototype._isLocked = function () {
    return this.state === 'playing' && this.config.behavior.scrollLock && this.mode !== 'edit-free';
  };

  TourController.prototype._bindListeners = function () {
    var self = this;
    this._onWheel = function (e) { if (self._isLocked()) { e.preventDefault(); self._showToast(); self._registerAttempt(Math.min(Math.abs(e.deltaY) || 40, 120)); } };
    this._onTouch = function (e) { if (self._isLocked()) { e.preventDefault(); self._showToast(); self._registerAttempt(60); } };
    this._onKey = function (e) { if (self._isLocked() && SCROLL_KEYS[e.key]) { e.preventDefault(); self._showToast(); self._registerAttempt(90); } };
    this._onResize = debounce(function () {
      self._applyTheme();
      if (self._activeIdx >= 0 && self._points[self._activeIdx]) {
        var y = self.resolveTargetY(self._points[self._activeIdx].target);
        if (y != null) self._snapScroll(y);
      }
      self._syncHighlights(self.getTime());
    }, 150);
    // When the tab is hidden the video throttles and rAF pauses; auto-pause so the
    // dead-reckoned clock can't drift ahead of the real video. User resumes on return.
    this._onVisibility = function () {
      if (document.visibilityState === 'hidden' && self.state === 'playing') self.pause();
    };
    this._onScrollWhilePaused = function () {
      if (self._programmatic) return;
      if (self.state === 'paused') self._scrolledWhilePaused = true;
    };
    window.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('touchmove', this._onTouch, { passive: false });
    window.addEventListener('keydown', this._onKey, { passive: false });
    window.addEventListener('resize', this._onResize);
    window.addEventListener('scroll', this._onScrollWhilePaused, { passive: true });
    document.addEventListener('visibilitychange', this._onVisibility);
  };

  // Prime the native preview video so the first user play() doesn't wait on decode/buffer.
  TourController.prototype._warmVideo = function (video) {
    if (!video || this._videoWarmed) return;
    var self = this;
    function tryWarm() {
      if (self._destroyed || self._videoWarmed) return;
      if (video.readyState < 2) return;
      self._videoWarmed = true;
      var wasMuted = video.muted;
      var t = video.currentTime || 0;
      video.muted = true;
      var pr = video.play();
      if (pr && pr.then) {
        pr.then(function () {
          video.pause();
          try { video.currentTime = t; } catch (e) { /* ignore */ }
          video.muted = wasMuted;
        }).catch(function () { video.muted = wasMuted; });
      } else video.muted = wasMuted;
    }
    if (video.readyState >= 2) tryWarm();
    else video.addEventListener('loadeddata', tryWarm, { once: true });
  };

  TourController.prototype._showToast = function () {
    var self = this;
    this._toast.style.opacity = '1';
    this._toast.style.transform = 'translateX(-50%) translateY(0)';
    // lift the subtitle up so it sits above the (lower) notification
    this._subLift = this._toast.offsetHeight + 12;
    this._updateSubPosition();
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(function () { self._hideToast(); }, TOAST_MS);
  };
  TourController.prototype._hideToast = function () {
    this._toast.style.opacity = '0';
    this._toast.style.transform = 'translateX(-50%) translateY(24px)';
    this._subLift = 0;
    this._updateSubPosition();
  };

  // Sustained scroll attempts (not a single nudge) auto-pause the tour.
  TourController.prototype._registerAttempt = function (weight) {
    var tnow = now();
    var WINDOW = 1400, THRESHOLD = 480;
    this._attempts.push({ t: tnow, w: weight });
    this._attempts = this._attempts.filter(function (a) { return tnow - a.t <= WINDOW; });
    var sum = 0;
    for (var i = 0; i < this._attempts.length; i++) sum += this._attempts[i].w;
    if (sum >= THRESHOLD) {
      this._attempts.length = 0;
      this.pause();          // this releases the lock and hides the toast via _setState
    }
  };

  // ---- editor helpers -----------------------------------------------------
  TourController.prototype.setConfig = function (cfg) {
    var wasState = this.state;
    this.config = normalizeConfig(cfg);
    this._resortPoints();
    this._applyTheme();
    this._activeIdx = -2;              // force scroll re-evaluation
    this._lastSub = null;
    this._syncScroll(this.getTime(), true);
    this._syncSubtitles(this.getTime());
    this._syncHighlights(this.getTime());
    if (this._startBtn) {
      var hideStart = this.state === 'playing' || (this.mode === 'edit' && !this._isLivePreview());
      this._startBtn.style.display = hideStart ? 'none' : 'flex';
    }
    this._updateSubPosition();
    this._emit('configchange', this.config);
    void wasState;
  };
  TourController.prototype.setPreviewVisible = function (visible) {
    if (!this._root) return this;
    if (visible) {
      this._root.style.display = '';
      this._syncSubtitles(this.getTime());
      this._updateSubPosition();
    } else {
      if (this.state === 'playing') this.pause();
      this._root.style.display = 'none';
    }
    return this;
  };
  TourController.prototype.captureManualTarget = function () {
    var maxY = maxScrollY() || 1;
    return { mode: 'manual', manualPercent: +(window.scrollY / maxY * 100).toFixed(2), selector: null, selectorFallbacks: [], viewportAnchor: 'top', offsetPx: 0 };
  };
  TourController.prototype.previewPoint = function (index) {
    var pt = this._points[index];
    if (!pt) return;
    var y = this.resolveTargetY(pt.target);
    if (y != null) this._startTween(y, pt.ease != null ? pt.ease : DEFAULT_EASE, easingFn(pt.easing));
  };

  // ---- events -------------------------------------------------------------
  TourController.prototype.on = function (evt, cb) { (this._listeners[evt] = this._listeners[evt] || []).push(cb); return this; };
  TourController.prototype.off = function (evt, cb) {
    var a = this._listeners[evt]; if (!a) return this;
    this._listeners[evt] = a.filter(function (f) { return f !== cb; }); return this;
  };
  TourController.prototype.once = function (evt, cb) {
    var self = this; function w() { self.off(evt, w); cb.apply(null, arguments); } return this.on(evt, w);
  };
  TourController.prototype._emit = function (evt) {
    var a = this._listeners[evt]; if (!a) return;
    var args = Array.prototype.slice.call(arguments, 1);
    for (var i = 0; i < a.length; i++) { try { a[i].apply(null, args); } catch (e) { console.error('[Tourly]', e); } }
  };

  // ---- teardown -----------------------------------------------------------
  TourController.prototype.destroy = function () {
    this._destroyed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._tweenRAF) cancelAnimationFrame(this._tweenRAF);
    window.removeEventListener('wheel', this._onWheel, { passive: false });
    window.removeEventListener('touchmove', this._onTouch, { passive: false });
    window.removeEventListener('keydown', this._onKey, { passive: false });
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('scroll', this._onScrollWhilePaused, { passive: true });
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._hiLayer && this._hiLayer.parentNode) this._hiLayer.parentNode.removeChild(this._hiLayer);
    this._clearAllHiTargets();
    this._hiLayer = null;
    this._hiOverlays = null;
    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
  };

  function debounce(fn, ms) {
    var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); };
  }

  // ========================================================================
  //  public + auto-mount
  // ========================================================================
  var Tourly = {
    version: VERSION,
    mount: function (config, options) { return new TourController(config, options); },
    _instances: []
  };
  var _origMount = Tourly.mount;
  Tourly.mount = function (config, options) { var t = _origMount(config, options); Tourly._instances.push(t); return t; };

  window.Tourly = Tourly;

  function autoMount() {
    if (window.TOURLY_CONFIG && !window.__TOURLY_MOUNTED__) {
      window.__TOURLY_MOUNTED__ = true;
      try { Tourly.mount(window.TOURLY_CONFIG, { mode: 'live' }); }
      catch (e) { console.error('[Tourly] mount failed:', e); }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount);
  else autoMount();
})();
