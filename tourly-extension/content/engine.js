/*!
 * Tourly engine — guided video tours for Webflow.
 * Single source of truth used BOTH by the Chrome-extension editor (mode:"edit")
 * and the published runtime served from jsDelivr (mode:"live").
 *
 * Public API:
 *   const tour = window.Tourly.mount(config, { mode });
 *   tour.play() / pause() / toggle() / seek(sec) / getTime() / getDuration()
 *   tour.close() / reopen()        // close parks the dock off-screen; hovering where it left restores it
 *   tour.setConfig(cfg)            // live re-render (editor)
 *   tour.setPreviewVisible(bool)   // show/hide video + subtitles (editor overlay)
 *   tour.resolveTargetY(target)    // px scroll position for a target def
 *   tour.resolveScrollYAtTime(sec)   // interpolated scroll Y at video time (incl. mid-transition)
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
  var TOAST_SHADOW = '0 8px 30px rgba(0,0,0,.35)';
  var SCROLL_KEYS = { ' ': 1, 'Spacebar': 1, 'ArrowUp': 1, 'ArrowDown': 1, 'PageUp': 1, 'PageDown': 1, 'Home': 1, 'End': 1 };
  var BREAK_CHARGE_MAX = 350;   // cumulative wheel/touch weight to break guided scroll
  var BREAK_MAX_INSET = 12;     // px the guided frame grows inward at full charge
  var BREAK_IDLE_MS = 650;      // ms after last scroll input before the frame retracts
  // Editor-only radius preview: which elements can be ringed, and what the ring looks like.
  var RADIUS_PREVIEW_TARGETS = ['player', 'subtitles', 'notification', 'frame'];
  var RADIUS_PREVIEW_RING = '2px solid #2563eb';
  var SUB_PREVIEW_TEXT = 'Subtitle preview';
  var BREAK_RETRACT_MS = 220;   // ms for the inset to animate back to the edge
  var RESUME_ALIGN_HOLD_MS = 450; // pause at flow position after user scrolled away while paused
  var DEFAULT_FRAME_COLOR = '#eab308';
  var GUIDED_FRAME_BORDER = '2px';       // normal border width
  var GUIDED_FRAME_BORDER_PREVIEW = '4px'; // thicker while the color picker holds it on screen
  var DOCK_PEEK_PX = 16;        // px of the dock left on screen when parked, as the reopen affordance
  var SUB_EXIT_PX = 120;        // px a live cue travels when playback stops
  var SUB_IDLE_PX = 8;          // px nudge for a cue that has nothing to show
  var REOPEN_PAD_PX = 28;       // how far outside the dock's old box the reopen hotspot reaches

  // Shared backend for "concise" exports (a script tag carrying a data-tourly-id attribute, no
  // inline config) — the same project tourly-extension/supabase-config.js points at. Read-only
  // anon access to a tour's own config, scoped by a narrow RLS policy (public.tours: select-only,
  // anon role) — see supabase/migrations/20260727000000_public_read_tours_for_concise_export.sql.
  var TOURLY_BACKEND = {
    url: 'https://awdwqqaaqaqitnaxjicu.supabase.co',
    anonKey: 'sb_publishable_XylxLJW9mVLfRce5AS0_jg_EAfUDlCr'
  };

  // ---- defaults ------------------------------------------------------------
  var DEFAULTS = {
    theme: {
      video: { radius: 8, width: 320, position: 'bottom-right', margin: 24, shadow: 'medium', zIndex: 999 },
      subtitles: { font: 'inherit', size: 12, color: '#ffffff', bg: 'rgba(0,0,0,0.62)', radius: 8, weight: 500, position: 'bottom-center', shadow: 'none' },
      notification: { text: 'Scrolling is paused during the tour', bg: '#eab308', textColor: '#000000', radius: 8 },
      guidedFrame: { color: DEFAULT_FRAME_COLOR }
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
  function getContrastTextColor(bgHex) {
    // Perceived brightness (YIQ) of the background decides black vs white text.
    var hex = String(bgHex || '').replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var r = parseInt(hex.substr(0, 2), 16) / 255;
    var g = parseInt(hex.substr(2, 2), 16) / 255;
    var b = parseInt(hex.substr(4, 2), 16) / 255;
    var luminance = (0.299 * r + 0.587 * g + 0.114 * b);
    return luminance > 0.5 ? '#000000' : '#ffffff';
  }
  // Alpha is baked into the ramp: a shadow needs a translucent colour to read correctly over
  // arbitrary page content, and the panel has no way to author one.
  var SHADOW_CSS = {
    none: 'none',
    light: '0 4px 14px rgba(0,0,0,.22)',
    medium: '0 10px 40px rgba(0,0,0,.35)',
    strong: '0 18px 60px rgba(0,0,0,.55)'
  };
  function getShadowCSS(shadowLevel, fallbackLevel) {
    var css = SHADOW_CSS[shadowLevel];
    return css != null ? css : SHADOW_CSS[fallbackLevel];
  }
  // Page-level stacking for .tourly-root. Concise embeds can override via data-tourly-z-index.
  function themeRootZ(videoTheme) {
    var z = videoTheme && videoTheme.zIndex != null ? +videoTheme.zIndex : 999;
    if (!isFinite(z)) z = 999;
    return Math.max(0, Math.min(2147483646, Math.round(z)));
  }
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

  // A z-index is only meaningful inside the stacking context that owns it, so a target sitting at
  // z-index:5 inside a transformed wrapper is NOT "5" at page level. Walk to the outermost ancestor
  // context and use that value — that's the depth the target actually paints at, and therefore the
  // depth its highlight ring has to match.
  function createsStackingContext(cs) {
    if (cs.position !== 'static' && cs.zIndex !== 'auto') return true;
    if (cs.position === 'fixed' || cs.position === 'sticky') return true;
    if (parseFloat(cs.opacity) < 1) return true;
    if (cs.transform && cs.transform !== 'none') return true;
    if (cs.filter && cs.filter !== 'none') return true;
    if (cs.perspective && cs.perspective !== 'none') return true;
    if (cs.isolation === 'isolate') return true;
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') return true;
    if (cs.contain && /paint|layout|strict|content/.test(cs.contain)) return true;
    if (cs.willChange && /transform|opacity|filter|perspective/.test(cs.willChange)) return true;
    return false;
  }
  function rootStackingZ(node) {
    var z = 0;
    var e = node;
    while (e && e !== document.body && e !== document.documentElement) {
      var cs = window.getComputedStyle(e);
      if (createsStackingContext(cs)) {
        var v = parseInt(cs.zIndex, 10);
        if (!isNaN(v)) z = v;   // keep walking: the outermost context is the one that wins
      }
      e = e.parentElement;
    }
    return z;
  }

  var HI_STROKE = 2;
  var HI_OUTSET = 2;
  var HI_DEFAULT_RADIUS = 8;
  var HI_PAD = HI_OUTSET + HI_STROKE * 0.5;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var HI_ANIM_CLASSES = ['tourly-hi-anim-outline', 'tourly-hi-anim-fade-in', 'tourly-hi-anim-sweep', 'tourly-hi-anim-pulse', 'tourly-hi-anim-glow', 'tourly-hi-anim-text-glow', 'tourly-hi-anim-box-glow'];
  var HI_BOX_GLOW_OUT = 18;
  var HI_SWEEP_OUT = 18;
  var HI_RING_GLOW_OUTSET = 12;
  var HI_SWEEP_GLOW_SCALE = 1.04;

  function outerAnnulusClipD(innerW, innerH, inset, iw, ih, radii, stroke) {
    var outer = 'M 0 0 H' + innerW + ' V' + innerH + ' H 0 Z';
    var holeInset = inset + stroke / 2;
    var holeW = Math.max(0, iw - stroke);
    var holeH = Math.max(0, ih - stroke);
    var maxR = Math.max(0, Math.min(holeW, holeH) / 2);
    var rtl = Math.min(radii.tl, maxR);
    var rtr = Math.min(radii.tr, maxR);
    var rbr = Math.min(radii.br, maxR);
    var rbl = Math.min(radii.bl, maxR);
    var inner = roundedRectPath(holeInset, holeInset, holeW, holeH, rtl, rtr, rbr, rbl);
    return outer + ' ' + inner;
  }
  var TEXT_GLOW_SEL = 'h1,h2,h3,h4,h5,h6,p,span,a,label,li,td,th,em,strong,b,i,small,figcaption,blockquote,cite,code,pre,dt,dd,legend,caption';

  function hiRingOutset(anim) {
    if (anim === 'box-glow' || anim === 'pulse') return HI_BOX_GLOW_OUT;
    if (anim === 'sweep') return HI_SWEEP_OUT;
    return 0;
  }

  function hiRingUsesGlowPath(anim) {
    return anim === 'sweep' || anim === 'box-glow';
  }

  function hiRingGlowScale(anim) {
    return (anim === 'sweep' || anim === 'box-glow') ? HI_SWEEP_GLOW_SCALE : 1;
  }

  function hiRingUsesGlowHalo(anim) {
    return anim === 'box-glow' || anim === 'pulse';
  }

  function expandCornerRadii(radii, out, w, h) {
    var maxR = Math.max(0, Math.min(w, h) / 2);
    return {
      tl: Math.min(radii.tl + out, maxR),
      tr: Math.min(radii.tr + out, maxR),
      br: Math.min(radii.br + out, maxR),
      bl: Math.min(radii.bl + out, maxR)
    };
  }

  function textGlowTargets(root) {
    if (!root) return [];
    if (isTextLikeNode(root)) return [root];
    var list = [], els = root.querySelectorAll(TEXT_GLOW_SEL), i;
    for (i = 0; i < els.length; i++) {
      if ((els[i].textContent || '').trim()) list.push(els[i]);
    }
    if (!list.length && nodeHasTextContent(root)) list.push(root);
    return list;
  }

  function resolveHiAnim(anim, kind) {
    anim = (anim || 'pulse').replace(/\s+/g, '-');
    if (anim === 'fade-in') anim = 'outline';
    if (anim === 'glow') return kind === 'text' ? 'text-glow' : 'box-glow';
    return anim;
  }

  function nodeHasTextContent(node) {
    if (!node) return false;
    return !!(node.textContent || '').trim();
  }

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
    this._activeTween = null;        // in-flight scroll tween (saved mid-transition on pause)
    this._programmatic = false;

    this._listeners = {};
    this._lastSub = null;
    this._toastTimer = 0;
    this._destroyed = false;
    this._subtitlesEnabled = true;   // CC toggle on the video
    this._subVisible = false;
    this._subLift = 0;               // px the subtitle is raised while the toast is showing
    this._scrolledWhilePaused = false; // user moved the page while paused → resume uses scroll tween
    this._breakCharge = 0;           // progress toward breaking guided scroll (0–BREAK_CHARGE_MAX)
    this._breakExiting = false;      // playing the frame retract animation
    this._breakIdleTimer = 0;
    this._pendingPlay = false;       // play() before player ready
    this._videoWarmed = false;
    this._hiTargetNodes = {};        // highlight id → DOM node with text-glow class
    this._hiPreviewId = null;        // editor: highlight pinned on screen while selected
    this._volume = 100;              // 0–100
    this._lastVolume = 100;          // restore level after unmuting
    this._muted = false;
    this._timelineScrubbing = false;
    this._editorUiRaised = this.mode === 'edit'; // editor chrome sits above preview highlights
    this._onTimelineEnd = null;
    this._alignHoldTimer = 0;

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
    Object.assign(root.style, {
      position: 'fixed', zIndex: themeRootZ(this.config.theme.video), inset: '0', pointerEvents: 'none'
    });

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

    // subtitle (CC) toggle — top-left
    var cc = el('button', 'tourly-cc');
    cc.type = 'button';
    cc.textContent = 'CC';
    Object.assign(cc.style, {
      position: 'absolute', top: '8px', left: '8px', zIndex: 6,
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

    // bottom bar: timeline scrubber + volume
    var bar = el('div', 'tourly-bar');
    Object.assign(bar.style, {
      position: 'absolute', left: '0', right: '0', bottom: '0', zIndex: 6,
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '6px 8px 8px', boxSizing: 'border-box',
      background: 'linear-gradient(to top, rgba(0,0,0,.62) 0%, rgba(0,0,0,.35) 70%, transparent 100%)',
      pointerEvents: 'none'
    });
    bar.addEventListener('click', function (e) { e.stopPropagation(); });

    var timelineWrap = el('div', 'tourly-timeline-wrap');
    Object.assign(timelineWrap.style, {
      flex: '1 1 auto', minWidth: '0', display: 'flex', alignItems: 'center',
      background: 'rgba(0,0,0,.5)', borderRadius: '14px', padding: '4px 8px', pointerEvents: 'auto'
    });
    timelineWrap.addEventListener('click', function (e) { e.stopPropagation(); });

    var timeline = el('input', 'tourly-timeline');
    timeline.type = 'range';
    timeline.min = '0';
    timeline.max = '1000';
    timeline.value = '0';
    timeline.setAttribute('aria-label', 'Video timeline');
    Object.assign(timeline.style, {
      width: '100%', minWidth: '0', margin: '0', cursor: 'pointer',
      accentColor: '#fff', pointerEvents: 'auto', height: '16px', background: 'transparent'
    });
    timeline.addEventListener('mousedown', function (e) { e.stopPropagation(); self._beginTimelineScrub(); });
    timeline.addEventListener('touchstart', function (e) { e.stopPropagation(); self._beginTimelineScrub(); }, { passive: true });
    timeline.addEventListener('input', function (e) {
      e.stopPropagation();
      self._scrubTimelineTo(+timeline.value / 1000);
    });
    timelineWrap.appendChild(timeline);
    this._timeline = timeline;
    this._timelineWrap = timelineWrap;

    // volume control: mute toggle + slider (right of timeline)
    var vol = el('div', 'tourly-vol');
    Object.assign(vol.style, {
      flex: 'none', display: 'flex', alignItems: 'center', gap: '6px',
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
    bar.appendChild(timelineWrap);
    bar.appendChild(vol);
    dock.appendChild(bar);
    this._controlBar = bar;
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
      font: '500 12px system-ui, sans-serif', whiteSpace: 'nowrap'
    });
    var toastText = el('span', 'tourly-toast-text');
    toast.appendChild(toastText);
    this._toast = toast;
    this._toastText = toastText;

    // viewport frame — persistent in preview, appears on scroll attempts in live tours
    var guidedFrame = el('div', 'tourly-guided-frame');
    Object.assign(guidedFrame.style, {
      position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: Math.max(0, themeRootZ(this.config.theme.video) - 1),
      boxSizing: 'border-box', borderWidth: GUIDED_FRAME_BORDER, borderStyle: 'solid', borderColor: 'transparent', opacity: '0'
    });
    root.appendChild(guidedFrame);
    this._guidedFrame = guidedFrame;

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

  // Visible viewport midline — shifts up when the editor dock raises bottom chrome (offsetBottom).
  function visibleMidY(offsetBottom) {
    return 'calc((100vh - ' + (offsetBottom || 0) + 'px) / 2)';
  }

  var POSITION_FALLBACK = {
    'bottom-right': 'bottom-center', 'bottom-left': 'bottom-center', 'bottom-center': 'bottom-right',
    'top-right': 'top-center', 'top-left': 'top-center', 'top-center': 'top-right',
    left: 'bottom-left', right: 'bottom-right', center: 'bottom-center'
  };

  function alternatePosition(occupied) {
    return POSITION_FALLBACK[occupied] || 'top-center';
  }

  // Which way an element leaves when hidden: toward the edge it is anchored to. Corners exit
  // horizontally (matching the original bottom-right slide); centred top/bottom exit vertically;
  // dead-centre has no edge to leave by, so it only fades.
  function exitVector(pos) {
    if (pos === 'center') return { x: 0, y: 0 };
    if (pos === 'top-center') return { x: 0, y: -1 };
    if (pos === 'bottom-center') return { x: 0, y: 1 };
    if (pos.indexOf('left') > -1) return { x: -1, y: 0 };
    if (pos.indexOf('right') > -1) return { x: 1, y: 0 };
    return { x: 0, y: 1 };
  }

  // Combine the centring transform a position implies with an extra offset, so callers can slide an
  // element without clobbering the translate that keeps it centred. dx/dy are CSS lengths.
  function offsetTransform(pos, dx, dy) {
    if (pos === 'center') return 'translate(calc(-50% + ' + dx + '), calc(-50% + ' + dy + '))';
    if (pos === 'left' || pos === 'right') return 'translate(' + dx + ', calc(-50% + ' + dy + '))';
    if (pos === 'bottom-center' || pos === 'top-center') return 'translate(calc(-50% + ' + dx + '), ' + dy + ')';
    return 'translate(' + dx + ', ' + dy + ')';
  }

  function applyElementAlignment(el, pos, marginPx, offsetBottomPx, offsetRightPx) {
    var mm = marginPx != null && isFinite(+marginPx) ? Math.max(0, +marginPx) : 24;
    var ob = offsetBottomPx || 0;
    var or = offsetRightPx || 0;
    var margin = mm + 'px';
    var bottomM = (ob + mm) + 'px';
    var rightM = (mm + or) + 'px';
    var mid = visibleMidY(ob);
    var midX = or ? ('calc((100vw - ' + or + 'px) / 2)') : '50%';
    el.style.top = el.style.right = el.style.bottom = el.style.left = 'auto';
    el.style.transform = 'none';
    if (pos === 'bottom-right') { el.style.bottom = bottomM; el.style.right = rightM; }
    else if (pos === 'bottom-left') { el.style.bottom = bottomM; el.style.left = margin; }
    else if (pos === 'top-right') { el.style.top = margin; el.style.right = rightM; }
    else if (pos === 'top-left') { el.style.top = margin; el.style.left = margin; }
    else if (pos === 'bottom-center') { el.style.bottom = bottomM; el.style.left = midX; el.style.transform = 'translateX(-50%)'; }
    else if (pos === 'top-center') { el.style.top = margin; el.style.left = midX; el.style.transform = 'translateX(-50%)'; }
    else if (pos === 'left') { el.style.left = margin; el.style.top = mid; el.style.transform = 'translateY(-50%)'; }
    else if (pos === 'center') { el.style.top = mid; el.style.left = midX; el.style.transform = 'translate(-50%, -50%)'; }
    else if (pos === 'right') { el.style.right = rightM; el.style.top = mid; el.style.transform = 'translateY(-50%)'; }
  }

  // ---- theme --------------------------------------------------------------
  TourController.prototype._applyTheme = function () {
    var t = this.config.theme;
    var isMobile = window.matchMedia('(max-width:' + (this.config.behavior.mobile.breakpoint || 768) + 'px)').matches;
    var v = t.video, m = this.config.behavior.mobile;

    // dock geometry. `offsetBottom` raises bottom-anchored elements without touching the horizontal
    // margin (the editor uses it to lift the preview above the timeline bar).
    var mm = v.margin != null && isFinite(+v.margin) ? Math.max(0, +v.margin) : 24;
    var ob = (v.offsetBottom || 0);
    var or = (v.offsetRight || 0);
    var margin = mm + 'px';
    var bottomM = (ob + mm) + 'px';
    var width = isMobile ? (m.videoWidth || '45vw') : (typeof v.width === 'number' ? v.width + 'px' : v.width);
    var pos = isMobile ? (m.position || 'bottom-center') : (v.position || 'bottom-right');
    var radius = v.radius != null ? v.radius : 8;
    var radiusPx = radius + 'px';
    var rootZ = themeRootZ(v);
    if (this._root) this._root.style.zIndex = String(rootZ);
    if (this._guidedFrame) this._guidedFrame.style.zIndex = String(Math.max(0, rootZ - 1));
    Object.assign(this._dock.style, {
      width: width, height: 'auto', aspectRatio: '16 / 9', borderRadius: radiusPx,
      boxShadow: getShadowCSS(v.shadow, 'medium')
    });
    if (this._video) this._video.style.borderRadius = radiusPx;
    if (this._iframe) this._iframe.style.borderRadius = radiusPx;
    applyElementAlignment(this._dock, pos, mm, ob, or);
    // Remembered so close()/reopen() can travel toward the edge the dock actually sits on.
    this._dockPos = pos;
    if (this._closed) {
      // Re-park against the new geometry (resize, theme edit) and re-measure the catch area with it.
      this._dock.style.transform = this._dockExitTransform();
      this._removeReopenHotspot();
      this._mountReopenHotspot();
    }

    // subtitles
    var s = t.subtitles;
    var subPos = s.position || 'bottom-center';
    if (!isMobile && subPos === pos) subPos = alternatePosition(pos);
    this._subPos = subPos;
    Object.assign(this._subEl.style, {
      maxWidth: (s.maxWidth || 80) + '%',
      fontFamily: s.font || 'inherit',
      fontSize: (s.size || 12) + 'px',
      fontWeight: s.weight || 500,
      color: s.color || '#fff'
    });
    applyElementAlignment(this._subEl, subPos, mm, ob, or);
    this._toast.style.bottom = bottomM;
    this._subStyle = s;
    // The box is only rebuilt when the cue text changes, so restyle any box already on screen.
    if (this._subSpan) this._styleSubBox(this._subSpan, s);

    // toast — uses frame color for background with auto high-contrast text, mirrors subtitles shadow/radius
    var n = t.notification;
    var gfColor = (t.guidedFrame && t.guidedFrame.color) || DEFAULT_FRAME_COLOR;
    var toastTextColor = getContrastTextColor(gfColor);
    var toastRadius = s.radius || 8;
    var toastShadow = getShadowCSS(s.shadow || 'none', s.shadowColor);
    Object.assign(this._toast.style, { background: gfColor, color: toastTextColor, borderRadius: toastRadius + 'px', boxShadow: toastShadow });
    this._toastText.textContent = n.text || DEFAULTS.theme.notification.text;

    if (this._catcher) this._catcher.style.borderRadius = radiusPx;
    if (this._startBtn) this._startBtn.style.borderRadius = radiusPx;
    if (this._controlBar) this._controlBar.style.borderRadius = '0 0 ' + radiusPx + ' ' + radiusPx;
    this._updateGuidedFrame();
    this._updateSubPosition();
  };

  TourController.prototype._timelineRatio = function () {
    var d = this.getDuration();
    if (!d) return 0;
    return clamp(this.getTime() / d, 0, 1);
  };

  TourController.prototype._updateTimeline = function () {
    if (!this._timeline || this._timelineScrubbing) return;
    this._timeline.value = String(Math.round(this._timelineRatio() * 1000));
  };

  TourController.prototype._beginTimelineScrub = function () {
    var self = this;
    if (this._timelineScrubbing) return;
    this._timelineScrubbing = true;
    if (this.state === 'playing') this.pause();
    this._onTimelineEnd = function () { self._endTimelineScrub(); };
    document.addEventListener('mouseup', this._onTimelineEnd);
    document.addEventListener('touchend', this._onTimelineEnd);
  };

  TourController.prototype._endTimelineScrub = function () {
    if (!this._timelineScrubbing) return;
    this._timelineScrubbing = false;
    if (this._onTimelineEnd) {
      document.removeEventListener('mouseup', this._onTimelineEnd);
      document.removeEventListener('touchend', this._onTimelineEnd);
      this._onTimelineEnd = null;
    }
    if (!this._timeline) return;
    this.seek((+this._timeline.value / 1000) * (this.getDuration() || 0));
  };

  TourController.prototype._scrubTimelineTo = function (ratio) {
    ratio = clamp(ratio, 0, 1);
    var d = this.getDuration();
    if (!d) return;
    var sec = ratio * d;
    if (this._tweenRAF) { cancelAnimationFrame(this._tweenRAF); this._tweenRAF = 0; }
    this._activeTween = null;
    this._anchorSeconds = sec;
    this._anchorNow = now();
    if (this._player && this._playerReady) this._player.setCurrentTime(sec);
    var idx = -1;
    for (var i = 0; i < this._points.length; i++) { if (this._points[i].time <= sec) idx = i; else break; }
    this._activeIdx = idx;
    this._prevT = sec;
    this._snapScroll(this.resolveScrollYAtTime(sec));
    this._syncSubtitles(sec);
    this._syncHighlights(sec, true);
    this._emit('timeupdate', sec);
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
        if (typeof d.seconds === 'number') {
          // While playing, dead-reckoning runs ahead of sparse player ticks; snapping
          // backward every timeupdate makes the editor playhead flicker one pixel.
          if (self.state === 'playing') {
            var est = self._anchorSeconds + (now() - self._anchorNow) / 1000;
            if (d.seconds >= est - 0.05) { self._anchorSeconds = d.seconds; self._anchorNow = now(); }
          } else {
            self._anchorSeconds = d.seconds;
            self._anchorNow = now();
          }
        }
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
    if (this.state === 'playing') {
      if (this._video) return this._video.currentTime;
      return this._anchorSeconds + (now() - this._anchorNow) / 1000;
    }
    return this._anchorSeconds;
  };
  TourController.prototype.getDuration = function () { return this._duration || 0; };

  // ---- transport ----------------------------------------------------------
  TourController.prototype._beginPlayback = function () {
    this._scrolledWhilePaused = false;
    this._breakCharge = 0;
    this._breakExiting = false;
    this._anchorNow = now();
    if (this._player && this._playerReady) this._player.play();
    else this._pendingPlay = true;
    this._setState('playing');
  };

  TourController.prototype._clearAlignHold = function () {
    if (this._alignHoldTimer) { clearTimeout(this._alignHoldTimer); this._alignHoldTimer = 0; }
  };

  TourController.prototype._finishPrePlayAlign = function (go, useHold) {
    var self = this;
    if (!useHold) { go(); return; }
    this._clearAlignHold();
    this._alignHoldTimer = setTimeout(function () {
      self._alignHoldTimer = 0;
      if (!self._destroyed && self.state !== 'playing') go();
    }, RESUME_ALIGN_HOLD_MS);
  };

  TourController.prototype.play = function () {
    var self = this;
    if (this._startBtn) this._startBtn.style.display = 'none';
    var info = this._activeForTime(this._anchorSeconds);
    var scrollAt = this.resolveScrollYAtTime(this._anchorSeconds);
    var misaligned = Math.abs(window.scrollY - scrollAt) >= 2;
    var alignHold = !!(this._scrolledWhilePaused && misaligned);
    var go = function () {
      self._activeIdx = info.idx;
      self._prevT = self._anchorSeconds; // avoid false seek snap on first playing frame
      self._beginPlayback();
    };
    // Resume a pre-play alignment tween interrupted by pause (not playback scroll — that follows video time).
    if (this._activeTween && this._activeTween.prePlay && this._activeTween.remainingSec > 0.02) {
      var tw = this._activeTween;
      this._activeTween = null;
      var hold = this._scrolledWhilePaused;
      this._startTween(tw.targetY, tw.remainingSec, tw.easeF, function () {
        self._finishPrePlayAlign(go, hold);
      }, tw.scrollIdx);
      return;
    }
    // Paused mid-tour (incl. after timeline scrub): scroll already tracks video time — align and play.
    if (this.state === 'paused') {
      if (this._scrolledWhilePaused && misaligned) {
        var pt = info.idx >= 0 ? this._points[info.idx] : null;
        this._startTween(scrollAt, 0.6, easingFn(pt && pt.easing), function () {
          self._finishPrePlayAlign(go, alignHold);
        }, info.idx);
        return;
      }
      if (misaligned) this._snapScroll(scrollAt);
      go();
      return;
    }
    var aligned = !misaligned;
    var snapOnly = this.state === 'idle' || this.state === 'ended'
      || (this.mode === 'edit' && !this._isLivePreview());
    if (aligned) go();
    else if (snapOnly) { this._snapScroll(scrollAt); go(); }
    else {
      var pt0 = info.idx >= 0 ? this._points[info.idx] : null;
      this._startTween(scrollAt, 0.6, easingFn(pt0 && pt0.easing), go, info.idx);
    }
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
    this._pauseScrollTween();
    this._clearAlignHold();
    if (this._player && this._playerReady) this._player.pause();
    this._setState('paused');
  };
  TourController.prototype.toggle = function () {
    if (this.state === 'playing') this.pause(); else this.play();
  };
  // A centre-anchored dock has no edge to leave by, so it drops downward rather than not moving.
  TourController.prototype._dockExitVector = function () {
    var vec = exitVector(this._dockPos || 'bottom-right');
    return (!vec.x && !vec.y) ? { x: 0, y: 1 } : vec;
  };

  // The dock's box as if it were not parked. We may already be parked when this is asked for, so
  // the resting transform is applied just long enough to measure; transitions are suppressed and
  // everything is restored before the browser can paint, so nothing flickers or animates.
  TourController.prototype._dockRestingRect = function () {
    var prevTransform = this._dock.style.transform;
    var prevTransition = this._dock.style.transition;
    this._dock.style.transition = 'none';
    this._dock.style.transform = offsetTransform(this._dockPos || 'bottom-right', '0px', '0px');
    var r = this._dock.getBoundingClientRect();
    this._dock.style.transform = prevTransform;
    this._dock.style.transition = prevTransition;
    return r;
  };

  // Travel far enough that only DOCK_PEEK_PX of the dock stays on screen — that sliver is the
  // affordance telling the viewer the player can be brought back. Derived from the resting box, so
  // margin, editor offset and dock size are all accounted for without re-deriving them here.
  TourController.prototype._dockExitTransform = function () {
    var vec = this._dockExitVector();
    var r = this._dockRestingRect();
    var dx = 0, dy = 0;
    if (vec.x > 0) dx = (window.innerWidth - DOCK_PEEK_PX) - r.left;
    else if (vec.x < 0) dx = DOCK_PEEK_PX - r.right;
    if (vec.y > 0) dy = (window.innerHeight - DOCK_PEEK_PX) - r.top;
    else if (vec.y < 0) dy = DOCK_PEEK_PX - r.bottom;
    return offsetTransform(this._dockPos || 'bottom-right', Math.round(dx) + 'px', Math.round(dy) + 'px');
  };

  // Closing parks the dock off-screen instead of tearing the tour down, so the viewer can bring it
  // back by moving the pointer to where it left. Playback pauses, which also releases the scroll
  // lock (_isLocked requires state 'playing'), so the page is fully browsable while parked.
  TourController.prototype.close = function () {
    if (this._closed) return;
    this._closed = true;
    this.pause();
    if (this._closeBtn) this._closeBtn.style.display = 'none';
    this._subVisible = false; this._updateSubPosition();
    this._hideToast();
    // Measure before arming the transition so the internal resting-box probe can't animate.
    var exit = this._dockExitTransform();
    this._dock.style.transition = 'transform .35s ease, opacity .35s ease';
    this._dock.style.transform = exit;
    this._dock.style.opacity = '1';   // stays visible: the peeking sliver is the reopen affordance
    this._dock.style.pointerEvents = 'none';  // hotspot above it owns the hover/click
    this._mountReopenHotspot();
    this._emit('close');
  };

  TourController.prototype.reopen = function () {
    if (!this._closed || this._destroyed) return;
    this._closed = false;
    this._removeReopenHotspot();
    var pos = this._dockPos || 'bottom-right';
    this._dock.style.transition = 'transform .35s ease, opacity .35s ease';
    this._dock.style.transform = offsetTransform(pos, '0px', '0px');
    this._dock.style.opacity = '1';
    this._dock.style.pointerEvents = '';
    // _setState early-returns when the state is unchanged, so mirror its close-button rule here.
    if (this._closeBtn) {
      this._closeBtn.style.display = (this.state === 'playing' || this.mode === 'edit') ? 'none' : 'flex';
    }
    this._emit('reopen');
  };

  // Catch area spanning the union of the dock's resting footprint (padded) and the parked sliver,
  // so the pointer triggers it both "near where it left" and directly on the visible peek. Explicit
  // px bounds rather than an alignment call, because a large theme margin would otherwise leave the
  // hotspot short of the viewport edge the sliver sits against.
  TourController.prototype._mountReopenHotspot = function () {
    if (this._reopenHotspot || !this._root) return;
    var self = this;
    var vec = this._dockExitVector();
    var r = this._dockRestingRect();
    var left = r.left - REOPEN_PAD_PX, top = r.top - REOPEN_PAD_PX;
    var right = r.right + REOPEN_PAD_PX, bottom = r.bottom + REOPEN_PAD_PX;
    // Reach all the way to the edge the dock parked against.
    if (vec.x > 0) right = window.innerWidth;
    else if (vec.x < 0) left = 0;
    if (vec.y > 0) bottom = window.innerHeight;
    else if (vec.y < 0) top = 0;
    left = Math.max(0, left); top = Math.max(0, top);
    right = Math.min(window.innerWidth, right); bottom = Math.min(window.innerHeight, bottom);

    var hs = el('div', 'tourly-reopen-hotspot');
    Object.assign(hs.style, {
      position: 'fixed', pointerEvents: 'auto', background: 'transparent', cursor: 'pointer',
      left: Math.round(left) + 'px', top: Math.round(top) + 'px',
      width: Math.round(Math.max(0, right - left)) + 'px',
      height: Math.round(Math.max(0, bottom - top)) + 'px'
    });
    hs.setAttribute('aria-label', 'Reopen tour');
    this._onReopenHover = function () { self.reopen(); };
    hs.addEventListener('mouseenter', this._onReopenHover);
    hs.addEventListener('click', this._onReopenHover);
    this._root.appendChild(hs);
    this._reopenHotspot = hs;
  };

  TourController.prototype._removeReopenHotspot = function () {
    var hs = this._reopenHotspot;
    if (!hs) return;
    if (this._onReopenHover) {
      hs.removeEventListener('mouseenter', this._onReopenHover);
      hs.removeEventListener('click', this._onReopenHover);
      this._onReopenHover = null;
    }
    if (hs.parentNode) hs.parentNode.removeChild(hs);
    this._reopenHotspot = null;
  };
  TourController.prototype.seek = function (sec) {
    sec = clamp(sec, 0, this._duration || sec);
    this._anchorSeconds = sec; this._anchorNow = now();
    this._scrolledWhilePaused = false;
    this._clearAlignHold();
    this._activeTween = null;
    if (this._tweenRAF) { cancelAnimationFrame(this._tweenRAF); this._tweenRAF = 0; }
    if (this._player && this._playerReady) this._player.setCurrentTime(sec);
    // relocate scroll immediately (snap) to the region for this time
    this._activeIdx = -2; // force re-evaluation
    this._syncScroll(sec, true);
    this._syncHighlights(sec, true);
  };

  TourController.prototype._setState = function (s) {
    if (this.state === s) return;
    var wasPlaying = this.state === 'playing';
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
    if (!playingLike && !this._isLivePreview()) this._resetGuidedFrame(true);
    else this._updateGuidedFrame();
    if (wasPlaying && !playingLike) this._syncHighlights(this.getTime(), true);
    this._emit('statechange', s);
    this._emit(s);
  };

  // ---- main loop ----------------------------------------------------------
  TourController.prototype._loop = function () {
    if (this._destroyed) return;
    var t = this.getTime();
    // Emit before scroll/highlight sync so the editor playhead paints first each frame.
    this._emit('timeupdate', t);
    this._updateTimeline();
    this._syncScroll(t, false);
    this._syncSubtitles(t);
    this._syncHighlights(t, false);
    this._raf = requestAnimationFrame(this._loop);
  };

  // Editor-only: pin one highlight on screen so a selected item is identifiable even when the
  // playhead is nowhere near it. Pass null to clear.
  TourController.prototype.setHighlightPreview = function (id) {
    id = id || null;
    var changed = this._hiPreviewId !== id;
    this._hiPreviewId = id;
    if (changed || id) this._syncHighlights(this.getTime(), true);
  };

  // Editor-only: while a corner-radius slider is in use, ring the element that radius applies to
  // so its shape can be judged directly. Subtitles and the toast are transient, so they're held
  // on screen for the duration. Pass null to clear.
  TourController.prototype._radiusPreviewEl = function (target) {
    if (target === 'player') return this._dock;
    if (target === 'subtitles') return this._subSpan;
    if (target === 'notification') return this._toast;
    return null;
  };

  TourController.prototype.setRadiusPreview = function (target) {
    if (RADIUS_PREVIEW_TARGETS.indexOf(target) === -1) target = null;
    if (this._radiusPreview === target) return;
    this._radiusPreview = target;
    this._setSubPlaceholder(target === 'subtitles');
    this._holdToast(target === 'notification');
    this._holdFrame(target === 'frame');
    this._applyRadiusPreview();
  };

  // While the frame color picker is open, force the guided frame border on screen so its color
  // can be judged directly (it's normally hidden outside of scroll-lock / live preview).
  TourController.prototype._holdFrame = function (on) {
    this._frameHeld = !!on;
    this._updateGuidedFrame();
  };

  TourController.prototype._applyRadiusPreview = function () {
    for (var i = 0; i < RADIUS_PREVIEW_TARGETS.length; i++) {
      var node = this._radiusPreviewEl(RADIUS_PREVIEW_TARGETS[i]);
      if (!node) continue;
      var on = this._radiusPreview === RADIUS_PREVIEW_TARGETS[i];
      node.style.outline = on ? RADIUS_PREVIEW_RING : '';
      node.style.outlineOffset = on ? '2px' : '';
    }
  };

  // Stand-in subtitle so the shape is visible even when the playhead sits between cues.
  TourController.prototype._setSubPlaceholder = function (on) {
    if (on) {
      if (this._subPlaceholder || this._subVisible) return;
      this._subPlaceholder = true;
      this._renderSubBox(SUB_PREVIEW_TEXT);
      return;
    }
    if (!this._subPlaceholder) return;
    this._subPlaceholder = false;
    this._lastSub = null;
    this._syncSubtitles(this.getTime());
  };

  TourController.prototype._holdToast = function (on) {
    if (on) {
      if (this._toastHeld) return;
      if (this._toastTimer) { clearTimeout(this._toastTimer); this._toastTimer = 0; }
      this._toastHeld = true;
      this._toast.style.opacity = '1';
      this._toast.style.transform = 'translateX(-50%) translateY(0)';
      this._subLift = this._toast.offsetHeight + 12;
      this._updateSubPosition();
      return;
    }
    if (!this._toastHeld) return;
    this._toastHeld = false;
    this._hideToast();
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

  // Scroll Y at video time t, interpolating through each keyframe's ease window (for live scrubbing).
  TourController.prototype.resolveScrollYAtTime = function (t) {
    var pts = this._points;
    if (!pts.length) return 0;
    var y = 0;
    for (var i = 0; i < pts.length; i++) {
      if (t < pts[i].time) break;
      var pt = pts[i];
      var yTo = this.resolveTargetY(pt.target);
      if (yTo == null) continue;
      var yFrom = y;
      var easeDur = pt.ease != null ? pt.ease : DEFAULT_EASE;
      if (easeDur <= 0) { y = yTo; continue; }
      var tStart = pt.time;
      var tEnd = tStart + easeDur;
      if (t < tEnd) {
        var p = clamp((t - tStart) / easeDur, 0, 1);
        return yFrom + (yTo - yFrom) * easingFn(pt.easing)(p);
      }
      y = yTo;
    }
    return y;
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

  TourController.prototype._resolveTweenTargetY = function (tw) {
    if (tw && tw.scrollIdx >= 0 && this._points[tw.scrollIdx]) {
      var y = this.resolveTargetY(this._points[tw.scrollIdx].target);
      if (y != null) return y;
    }
    var info = this._activeForTime(this._anchorSeconds);
    if (info.y != null) return info.y;
    return tw ? tw.targetY : null;
  };

  TourController.prototype._syncScroll = function (t, forceSnap) {
    var pts = this._points;
    var idx = -1;
    for (var i = 0; i < pts.length; i++) { if (pts[i].time <= t) idx = i; else break; }
    var dt = t - this._prevT;
    var isSeek = forceSnap || Math.abs(dt) > SEEK_THRESHOLD;
    this._prevT = t;
    this._activeIdx = idx;

    if (isSeek) {
      if (this._tweenRAF) { cancelAnimationFrame(this._tweenRAF); this._tweenRAF = 0; }
      this._activeTween = null;
      this._snapScroll(this.resolveScrollYAtTime(t));
      return;
    }

    // Paused/idle: don't fight user scroll — only seek/scrub relocates the page.
    if (this.state !== 'playing') return;

    // Playing: scroll follows video time (same curve as timeline scrubbing).
    if (this._tweenRAF) { cancelAnimationFrame(this._tweenRAF); this._tweenRAF = 0; }
    this._activeTween = null;
    this._snapScroll(this.resolveScrollYAtTime(t));
  };

  TourController.prototype._pauseScrollTween = function () {
    if (this._tweenRAF) { cancelAnimationFrame(this._tweenRAF); this._tweenRAF = 0; }
    if (!this._activeTween) return;
    var tw = this._activeTween;
    var p = clamp((now() - tw.start) / tw.D, 0, 1);
    tw.progress = p;
    tw.remainingSec = Math.max(0, (tw.D * (1 - p)) / 1000);
  };

  TourController.prototype._startTween = function (targetY, dur, ease, onDone, scrollIdx) {
    var easeF = (typeof ease === 'function') ? ease : easeInOutCubic;
    if (this._tweenRAF) cancelAnimationFrame(this._tweenRAF);
    var self = this;
    var startY = window.scrollY;
    var delta = targetY - startY;
    var D = Math.max(1, (dur || DEFAULT_EASE) * 1000);
    if (Math.abs(delta) < 1) {
      this._activeTween = null;
      this._tweenRAF = 0;
      if (onDone) onDone();
      return;
    }
    var start = now();
    this._activeTween = {
      startY: startY, targetY: targetY, delta: delta, start: start, D: D,
      easeF: easeF, onDone: onDone, progress: 0, remainingSec: D / 1000,
      scrollIdx: scrollIdx == null ? -1 : scrollIdx,
      // Resume scroll runs before playback starts (state still paused).
      prePlay: !!(onDone && self.state !== 'playing')
    };
    function step() {
      if (self._destroyed || !self._activeTween) return;
      var tw = self._activeTween;
      var p = clamp((now() - tw.start) / tw.D, 0, 1);
      tw.progress = p;
      tw.remainingSec = Math.max(0, (tw.D * (1 - p)) / 1000);
      self._programmatic = true;
      window.scrollTo(0, tw.startY + tw.delta * tw.easeF(p));
      self._programmatic = false;
      if (p < 1) {
        if (self.state !== 'playing' && !tw.prePlay) {
          self._tweenRAF = 0;
          return;
        }
        self._tweenRAF = requestAnimationFrame(step);
        return;
      }
      self._tweenRAF = 0;
      var done = tw.onDone;
      self._activeTween = null;
      if (done) done();
    }
    this._tweenRAF = requestAnimationFrame(step);
  };

  TourController.prototype._snapScroll = function (y) {
    if (this._tweenRAF) { cancelAnimationFrame(this._tweenRAF); this._tweenRAF = 0; }
    this._activeTween = null;
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
    if (this._subPlaceholder) return; // editor is holding a stand-in box for the radius preview
    var cue = manual || auto;
    var text = cue ? cue.text : '';
    if (text === this._lastSub) return;
    this._lastSub = text;
    if (!text) {
      this._subVisible = false;
      this._subSpan = null;
      this._updateSubPosition();
      return;
    }
    this._renderSubBox(text);
  };

  TourController.prototype._styleSubBox = function (span, s) {
    Object.assign(span.style, {
      display: 'inline-block', padding: '4px 12px', lineHeight: '1.35',
      background: s.bg || 'rgba(0,0,0,.62)', borderRadius: (s.radius || 8) + 'px',
      boxShadow: getShadowCSS(s.shadow, 'none')
    });
  };

  TourController.prototype._renderSubBox = function (text) {
    this._subEl.innerHTML = '';
    var span = el('span');
    this._styleSubBox(span, this._subStyle || DEFAULTS.theme.subtitles);
    span.textContent = text;
    this._subEl.appendChild(span);
    this._subSpan = span;
    this._subVisible = true;
    this._applyRadiusPreview();
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
      // MUST NOT create a stacking context. `position:fixed` creates one all by itself (z-index is
      // irrelevant), which would trap every child's z-index inside this layer and make the
      // per-target sync in _layoutHiOverlay inert. A zero-size `position:absolute` box with
      // z-index:auto creates none, so the overlays — which are themselves position:fixed, and so
      // still lay out against the viewport — compete directly with real page elements.
      '.tourly-hi-layer{position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;overflow:visible}',
      '.tourly-hi-overlay{position:fixed;pointer-events:none;box-sizing:border-box;background:transparent;border:none;opacity:1;transform:translateZ(0);overflow:visible}',
      '.tourly-hi-ring-shell{position:absolute;overflow:visible;pointer-events:none}',
      '.tourly-hi-ring{position:absolute;inset:0;width:100%;height:100%;overflow:visible}',
      '.tourly-hi-ring-path{stroke:var(--tly-hi-color,#ff4d8d);stroke-width:var(--tly-hi-stroke,2);fill:none;vector-effect:non-scaling-stroke}',
      '.tourly-hi-glow-halo{position:absolute;inset:0;border-radius:inherit;background:transparent;pointer-events:none;display:none;box-shadow:0 0 10px var(--tly-hi-color,#ff4d8d),0 0 22px var(--tly-hi-color,#ff4d8d);opacity:0}',
      '.tourly-hi-ring-glow{display:none;stroke:var(--tly-hi-color,#ff4d8d);stroke-width:var(--tly-hi-stroke,2);fill:none;vector-effect:non-scaling-stroke}',
      '.tourly-hi-anim-outline .tourly-hi-ring-path{animation-name:tourlyHiRingOutline;animation-duration:var(--tly-hi-duration,2.4s);animation-timing-function:ease-in-out;animation-iteration-count:1;animation-fill-mode:both}',
      '@keyframes tourlyHiRingOutline{0%{opacity:0}25%{opacity:1}75%{opacity:1}100%{opacity:0}}',
      '.tourly-hi-anim-pulse .tourly-hi-ring-shell{overflow:visible}',
      '.tourly-hi-anim-pulse .tourly-hi-glow-halo{display:block;animation:tourlyHiRingPulseGlow 1.35s ease-in-out infinite}',
      '.tourly-hi-anim-pulse .tourly-hi-ring-path{animation:tourlyHiRingPulseGlow 1.35s ease-in-out infinite}',
      '@keyframes tourlyHiRingPulseGlow{0%{opacity:0}20%{opacity:1}40%{opacity:0}60%{opacity:1}80%{opacity:0}100%{opacity:0}}',
      '.tourly-hi-anim-box-glow .tourly-hi-ring-shell{overflow:visible}',
      '.tourly-hi-anim-box-glow .tourly-hi-ring-glow-wrap{filter:drop-shadow(0 0 10px var(--tly-hi-color,#ff4d8d)) drop-shadow(0 0 22px var(--tly-hi-color,#ff4d8d))}',
      '.tourly-hi-anim-box-glow .tourly-hi-glow-halo{display:block;animation-name:tourlyHiRingBoxGlow;animation-duration:var(--tly-hi-duration,2.4s);animation-timing-function:ease-in-out;animation-iteration-count:1;animation-fill-mode:both}',
      '.tourly-hi-anim-box-glow .tourly-hi-ring-glow{display:block;opacity:1;stroke-width:3;animation-name:tourlyHiRingBoxGlow;animation-duration:var(--tly-hi-duration,2.4s);animation-timing-function:ease-in-out;animation-iteration-count:1;animation-fill-mode:both}',
      '.tourly-hi-anim-box-glow .tourly-hi-ring-path{animation-name:tourlyHiRingBoxGlow;animation-duration:var(--tly-hi-duration,2.4s);animation-timing-function:ease-in-out;animation-iteration-count:1;animation-fill-mode:both}',
      '@keyframes tourlyHiRingBoxGlow{0%{opacity:0}25%{opacity:1}75%{opacity:1}100%{opacity:0}}',
      '.tourly-hi-anim-sweep .tourly-hi-ring-shell{overflow:visible}',
      '.tourly-hi-anim-sweep .tourly-hi-ring-glow-wrap{filter:drop-shadow(0 0 10px var(--tly-hi-color,#ff4d8d)) drop-shadow(0 0 22px var(--tly-hi-color,#ff4d8d))}',
      '.tourly-hi-anim-sweep .tourly-hi-ring-glow{display:block;opacity:1;stroke-width:3;animation-name:tourlyHiRingSweepDash;animation-duration:var(--tly-hi-duration,2.4s);animation-timing-function:ease-in-out;animation-iteration-count:1;animation-fill-mode:both}',
      '.tourly-hi-anim-sweep .tourly-hi-ring-path{animation-name:tourlyHiRingSweepDash;animation-duration:var(--tly-hi-duration,2.4s);animation-timing-function:ease-in-out;animation-iteration-count:1;animation-fill-mode:both}',
      '@keyframes tourlyHiRingSweepDash{0%{stroke-dashoffset:var(--tly-hi-perimeter,400)}25%{stroke-dashoffset:0}75%{stroke-dashoffset:0}100%{stroke-dashoffset:var(--tly-hi-perimeter-neg,-400)}}',
      '.tourly-hi-target-text.tourly-hi-anim-text-glow{animation-name:tourlyHiTextGlow;animation-duration:var(--tly-hi-duration,2.4s);animation-timing-function:ease-in-out;animation-iteration-count:1;animation-fill-mode:both}',
      '@keyframes tourlyHiTextGlow{0%{text-shadow:0 0 0 transparent,0 0 0 transparent,0 0 0 transparent,0 0 0 transparent}25%{text-shadow:0 0 4px var(--tly-hi-color,#ff4d8d),0 0 10px var(--tly-hi-color,#ff4d8d),0 0 20px var(--tly-hi-color,#ff4d8d),0 0 32px var(--tly-hi-color,#ff4d8d)}75%{text-shadow:0 0 4px var(--tly-hi-color,#ff4d8d),0 0 10px var(--tly-hi-color,#ff4d8d),0 0 20px var(--tly-hi-color,#ff4d8d),0 0 32px var(--tly-hi-color,#ff4d8d)}100%{text-shadow:0 0 0 transparent,0 0 0 transparent,0 0 0 transparent,0 0 0 transparent}}',
      '.tourly-hi-target-text.tourly-hi-anim-outline{animation-name:tourlyHiTextOutline;animation-duration:var(--tly-hi-duration,2.4s);animation-timing-function:ease-in-out;animation-iteration-count:1;animation-fill-mode:both}',
      '@keyframes tourlyHiTextOutline{0%{text-shadow:0 0 8px transparent,0 0 16px transparent}25%{text-shadow:0 0 8px var(--tly-hi-color,#ff4d8d),0 0 16px var(--tly-hi-color,#ff4d8d)}75%{text-shadow:0 0 8px var(--tly-hi-color,#ff4d8d),0 0 16px var(--tly-hi-color,#ff4d8d)}100%{text-shadow:0 0 8px transparent,0 0 16px transparent}}',
      '.tourly-hi-target-text.tourly-hi-anim-pulse{animation:tourlyHiTextPulse 1.35s ease-in-out infinite}',
      '@keyframes tourlyHiTextPulse{0%{text-shadow:0 0 0 transparent,0 0 0 transparent}20%{text-shadow:0 0 8px var(--tly-hi-color,#ff4d8d),0 0 16px var(--tly-hi-color,#ff4d8d)}40%{text-shadow:0 0 0 transparent,0 0 0 transparent}60%{text-shadow:0 0 8px var(--tly-hi-color,#ff4d8d),0 0 16px var(--tly-hi-color,#ff4d8d)}80%{text-shadow:0 0 0 transparent,0 0 0 transparent}100%{text-shadow:0 0 0 transparent,0 0 0 transparent}}',
      '.tourly-hi-target-text.tourly-hi-anim-sweep{animation-name:tourlyHiTextSweep;animation-duration:var(--tly-hi-duration,2.4s);animation-timing-function:ease-in-out;animation-iteration-count:1;animation-fill-mode:both}',
      '@keyframes tourlyHiTextSweep{0%{text-shadow:0 0 8px transparent,0 0 18px transparent}25%{text-shadow:0 0 8px var(--tly-hi-color,#ff4d8d),0 0 18px var(--tly-hi-color,#ff4d8d)}75%{text-shadow:0 0 8px var(--tly-hi-color,#ff4d8d),0 0 18px var(--tly-hi-color,#ff4d8d)}100%{text-shadow:0 0 8px transparent,0 0 18px transparent}}',
      '.tourly-hi-underlay{position:fixed;inset:0;pointer-events:none;z-index:1}'
    ].join('');
    document.head.appendChild(s);
  };

  TourController.prototype._ensureHiUnderlay = function () {
    if (this._hiUnderlay) return this._hiUnderlay;
    this._hiUnderlay = el('div', 'tourly-hi-underlay');
    var body = document.body || document.documentElement;
    body.insertBefore(this._hiUnderlay, body.firstChild);
    return this._hiUnderlay;
  };

  // The layer deliberately carries no z-index in either mode: any value here would create a
  // stacking context and re-trap the per-target z-index each overlay sets in _layoutHiOverlay.
  // Editor chrome stays above highlights on its own — the player root defaults to z-index 999
  // (overridable via theme.video.zIndex / data-tourly-z-index) and the editor panel sits higher
  // still (2147483646).
  TourController.prototype._applyHiLayerZ = function () {
    if (!this._hiLayer) return;
    var body = document.body || document.documentElement;
    if (this._hiLayer.parentNode !== body) body.appendChild(this._hiLayer);
    this._hiLayer.style.removeProperty('z-index');
  };

  TourController.prototype._buildHiLayer = function () {
    if (this._hiLayer) {
      this._applyHiLayerZ();
      return;
    }
    this._ensureHiStyles();
    this._hiLayer = el('div', 'tourly-hi-layer');
    (document.body || document.documentElement).appendChild(this._hiLayer);
    this._applyHiLayerZ();
    this._hiOverlays = {};
    this._hiActiveKey = '';
    this._hiTargetStyleKey = {};
    this._hiTargetOrig = {};
  };

  TourController.prototype._hiStyleKey = function (h, kind, anim) {
    var span = Math.max(0.1, (h.end || 0) - (h.start || 0));
    return kind + '|' + anim + '|' + (h.color || '#ff4d8d') + '|' + span.toFixed(2);
  };

  TourController.prototype._hiSpan = function (h) {
    return Math.max(0.1, (h.end || 0) - (h.start || 0));
  };

  // Peak visibility for one-shot keyframes (25–75% hold); pulse reads best mid-span.
  TourController.prototype._hiPreviewSampleTime = function (h) {
    var span = Math.max(0, (h.end || 0) - (h.start || 0));
    if (span <= 0) return h.start || 0;
    return h.start + span * 0.5;
  };

  // Editor selection preview: mid-span follows the playhead; at/before start or at/after end
  // park on the peak frame so a picked item is always identifiable (h.end is faded out).
  TourController.prototype._hiRenderEntry = function (h, t, previewId) {
    var inside = t >= h.start && t < h.end;
    var pinned = previewId != null && String(previewId) === String(h.id);
    if (!inside && !pinned) return null;
    if (pinned && (t <= h.start || t >= h.end)) {
      return { h: h, at: this._hiPreviewSampleTime(h), preview: true };
    }
    return { h: h, at: t, preview: false };
  };

  TourController.prototype._hiTargetList = function (id) {
    var nodes = this._hiTargetNodes[id];
    if (!nodes) return [];
    return Array.isArray(nodes) ? nodes : [nodes];
  };

  TourController.prototype._hiAnimEl = function (ov, anim, kind, textNode) {
    if (anim === 'text-glow') return textNode;
    if (anim === 'box-glow') return ov.querySelector('.tourly-hi-glow-halo');
    if (kind === 'text' && anim !== 'box-glow') return textNode;
    return ov.querySelector('.tourly-hi-ring-path');
  };

  TourController.prototype._stampHiAnimEl = function (el, dur, delay, playState, loop) {
    if (!el) return;
    el.style.setProperty('--tly-hi-duration', dur);
    el.style.animationDuration = dur;
    el.style.animationDelay = delay;
    el.style.animationIterationCount = loop ? 'infinite' : '1';
    el.style.animationFillMode = 'both';
    el.style.animationPlayState = playState;
  };

  TourController.prototype._applyHiAnimTiming = function (ov, h, t, anim, kind, textNode, forceSync, isPreview) {
    var span = this._hiSpan(h);
    // Preview: pulse loops so it must run; one-shots park paused on the sampled peak frame.
    var playing = this.state === 'playing' || (!!isPreview && anim === 'pulse');
    var lastT = ov._hiAnimLastT;
    var seeked = forceSync || lastT == null || Math.abs(t - lastT) > SEEK_THRESHOLD;
    ov._hiAnimLastT = t;

    // While playing, follow video time each frame (like scroll). When paused, update only on seek/scrub.
    if (!playing && !seeked && !forceSync && !isPreview) return;

    var playState = playing ? 'running' : 'paused';
    var PULSE_DUR = 1.35;

    if (anim === 'pulse') {
      var pulseElapsed = clamp(t - h.start, 0, span);
      var phase = pulseElapsed % PULSE_DUR;
      var pulseDur = PULSE_DUR.toFixed(3) + 's';
      var pulseDelay = (-phase).toFixed(3) + 's';
      ov.style.setProperty('--tly-hi-duration', pulseDur);
      if (kind === 'text') {
        var pulseTargets = textNode ? [textNode] : this._hiTargetList(h.id);
        for (var pi = 0; pi < pulseTargets.length; pi++) {
          this._stampHiAnimEl(pulseTargets[pi], pulseDur, pulseDelay, playState, true);
        }
      } else {
        this._stampHiAnimEl(ov.querySelector('.tourly-hi-ring-path'), pulseDur, pulseDelay, playState, true);
        this._stampHiAnimEl(ov.querySelector('.tourly-hi-glow-halo'), pulseDur, pulseDelay, playState, true);
      }
      return;
    }

    var dur = span.toFixed(3) + 's';
    var elapsed = clamp(t - h.start, 0, span);
    var delay = (-elapsed).toFixed(3) + 's';
    ov.style.setProperty('--tly-hi-duration', dur);

    if (anim === 'text-glow') {
      var targets = this._hiTargetList(h.id);
      for (var ti = 0; ti < targets.length; ti++) {
        this._stampHiAnimEl(targets[ti], dur, delay, playState, false);
      }
      return;
    }

    var el = this._hiAnimEl(ov, anim, kind, textNode);
    this._stampHiAnimEl(el, dur, delay, playState, false);
    if (anim === 'box-glow') {
      var ringPath = ov.querySelector('.tourly-hi-ring-path');
      var glowPath = ov.querySelector('.tourly-hi-ring-glow');
      var halo = ov.querySelector('.tourly-hi-glow-halo');
      this._stampHiAnimEl(ringPath, dur, delay, playState, false);
      this._stampHiAnimEl(glowPath, dur, delay, playState, false);
      this._stampHiAnimEl(halo, dur, delay, playState, false);
    }
    if (anim === 'sweep') {
      var sweepGlow = ov.querySelector('.tourly-hi-ring-glow');
      var sweepPath = ov.querySelector('.tourly-hi-ring-path');
      this._stampHiAnimEl(sweepGlow, dur, delay, playState, false);
      this._stampHiAnimEl(sweepPath, dur, delay, playState, false);
    }
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
    var glowPath = ov.querySelector('.tourly-hi-ring-glow');
    var glowWrap = ov.querySelector('.tourly-hi-ring-glow-wrap');
    var halo = ov.querySelector('.tourly-hi-glow-halo');
    var shell = ov.querySelector('.tourly-hi-ring-shell');
    function resetAnim(el) {
      if (!el) return;
      el.style.animation = 'none';
      el.style.opacity = '';
      void el.offsetWidth;
      el.style.animation = '';
    }
    if (path) {
      path.style.strokeDashoffset = '';
      path.removeAttribute('stroke-dashoffset');
      path.style.filter = '';
    }
    resetAnim(path);
    resetAnim(glowPath);
    resetAnim(glowWrap);
    resetAnim(halo);
    resetAnim(shell);
  };

  TourController.prototype._ensureHiOuterClip = function (svg, clipId, innerW, innerH, inset, iw, ih, radii, stroke) {
    var defs = svg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS(SVG_NS, 'defs');
      svg.insertBefore(defs, svg.firstChild);
    }
    var clip = defs.querySelector('#' + clipId);
    if (!clip) {
      clip = document.createElementNS(SVG_NS, 'clipPath');
      clip.setAttribute('id', clipId);
      clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
      var cp = document.createElementNS(SVG_NS, 'path');
      cp.setAttribute('class', 'tourly-hi-outer-clip');
      clip.appendChild(cp);
      defs.appendChild(clip);
    }
    var cpPath = clip.querySelector('path');
    var clipD = outerAnnulusClipD(innerW, innerH, inset, iw, ih, radii, stroke);
    if (cpPath.getAttribute('d') !== clipD) {
      cpPath.setAttribute('d', clipD);
      cpPath.setAttribute('fill-rule', 'evenodd');
    }
    return clipId;
  };

  TourController.prototype._ensureHiRing = function (ov) {
    var legacyRing = ov.querySelector(':scope > .tourly-hi-ring');
    if (legacyRing) legacyRing.parentNode.removeChild(legacyRing);
    var shell = ov.querySelector('.tourly-hi-ring-shell');
    if (!shell) {
      shell = el('div', 'tourly-hi-ring-shell');
      ov.appendChild(shell);
    }
    var halo = shell.querySelector('.tourly-hi-glow-halo');
    if (!halo) {
      halo = el('div', 'tourly-hi-glow-halo');
      shell.appendChild(halo);
    }
    var svg = shell.querySelector('.tourly-hi-ring');
    if (!svg) {
      svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'tourly-hi-ring');
      svg.setAttribute('aria-hidden', 'true');
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', 'tourly-hi-ring-path');
      var glowWrap = document.createElementNS(SVG_NS, 'g');
      glowWrap.setAttribute('class', 'tourly-hi-ring-glow-wrap');
      var glowPath = document.createElementNS(SVG_NS, 'path');
      glowPath.setAttribute('class', 'tourly-hi-ring-glow');
      glowWrap.appendChild(glowPath);
      svg.appendChild(glowWrap);
      svg.appendChild(path);
      shell.appendChild(svg);
    }
    var glowPathLegacy = svg.querySelector('.tourly-hi-ring-glow');
    var glowWrapCheck = svg.querySelector('.tourly-hi-ring-glow-wrap');
    if (glowPathLegacy && !glowWrapCheck) {
      glowWrapCheck = document.createElementNS(SVG_NS, 'g');
      glowWrapCheck.setAttribute('class', 'tourly-hi-ring-glow-wrap');
      svg.insertBefore(glowWrapCheck, glowPathLegacy);
      glowWrapCheck.appendChild(glowPathLegacy);
    }
    return shell;
  };

  TourController.prototype._layoutHiRing = function (ov, m, anim) {
    var shell = this._ensureHiRing(ov);
    var svg = shell.querySelector('.tourly-hi-ring');
    var outset = hiRingOutset(anim);
    var innerW = Math.max(0, m.rect.width + m.pad * 2);
    var innerH = Math.max(0, m.rect.height + m.pad * 2);
    shell.style.display = '';
    shell.style.left = outset + 'px';
    shell.style.top = outset + 'px';
    shell.style.width = Math.round(innerW) + 'px';
    shell.style.height = Math.round(innerH) + 'px';
    shell.style.borderRadius = m.radii.css;
    var inset = m.stroke / 2;
    var iw = Math.max(0, innerW - m.stroke);
    var ih = Math.max(0, innerH - m.stroke);
    svg.setAttribute('viewBox', '0 0 ' + innerW + ' ' + innerH);
    var path = svg.querySelector('.tourly-hi-ring-path');
    var glowWrap = svg.querySelector('.tourly-hi-ring-glow-wrap');
    var glowPath = svg.querySelector('.tourly-hi-ring-glow');
    var d = roundedRectPath(inset, inset, iw, ih, m.radii.tl, m.radii.tr, m.radii.br, m.radii.bl);
    if (path.getAttribute('d') !== d) path.setAttribute('d', d);
    var len = path.getTotalLength();
    path.style.setProperty('--tly-hi-perimeter', String(len));
    path.style.setProperty('--tly-hi-perimeter-neg', String(-len));
    if (path.getAttribute('stroke-dasharray') !== String(len)) {
      path.setAttribute('stroke-dasharray', String(len));
    }
    if (glowPath && glowWrap) {
      if (hiRingUsesGlowPath(anim)) {
        var cx = innerW / 2;
        var cy = innerH / 2;
        var scale = hiRingGlowScale(anim);
        var tf = 'translate(' + cx + ' ' + cy + ') scale(' + scale + ') translate(' + (-cx) + ' ' + (-cy) + ')';
        if (glowWrap.getAttribute('transform') !== tf) glowWrap.setAttribute('transform', tf);
        if (glowPath.getAttribute('d') !== d) glowPath.setAttribute('d', d);
        glowPath.style.setProperty('--tly-hi-perimeter', String(len));
        glowPath.style.setProperty('--tly-hi-perimeter-neg', String(-len));
        if (glowPath.getAttribute('stroke-dasharray') !== String(len)) {
          glowPath.setAttribute('stroke-dasharray', String(len));
        }
        if (anim === 'sweep') {
          if (!ov._hiClipId) ov._hiClipId = 'tlyclip-' + Math.random().toString(36).slice(2, 9);
          this._ensureHiOuterClip(svg, ov._hiClipId, innerW, innerH, inset, iw, ih, m.radii, m.stroke);
          glowWrap.setAttribute('clip-path', 'url(#' + ov._hiClipId + ')');
        } else {
          glowWrap.removeAttribute('clip-path');
          glowPath.setAttribute('stroke-dashoffset', '0');
          path.setAttribute('stroke-dashoffset', '0');
        }
        glowWrap.style.display = '';
        glowPath.style.display = '';
      } else {
        glowWrap.removeAttribute('clip-path');
        glowWrap.removeAttribute('transform');
        glowWrap.style.display = 'none';
        glowPath.style.display = 'none';
      }
    }
    var halo = shell.querySelector('.tourly-hi-glow-halo');
    if (halo) halo.style.display = hiRingUsesGlowHalo(anim) ? '' : 'none';
    svg.style.display = '';
  };

  TourController.prototype._clearHiTargetById = function (id) {
    var nodes = this._hiTargetNodes[id];
    if (!nodes) return;
    var list = Array.isArray(nodes) ? nodes : [nodes];
    var origs = this._hiTargetOrig && this._hiTargetOrig[id];
    var multi = Array.isArray(origs);
    for (var i = 0; i < list.length; i++) {
      var node = list[i];
      HI_ANIM_CLASSES.forEach(function (c) { node.classList.remove(c); });
      node.classList.remove('tourly-hi-target-text', 'tourly-hi-target-text-glow');
      node.style.removeProperty('--tly-hi-color');
      node.style.animation = '';
      node.style.textShadow = '';
      var orig = multi ? origs[i] : (i === 0 ? origs : null);
      if (orig) {
        if (orig.color != null) node.style.color = orig.color || '';
        if (orig.position != null) node.style.position = orig.position || '';
        if (orig.zIndex != null) node.style.zIndex = orig.zIndex || '';
        if (orig.textShadow != null) node.style.textShadow = orig.textShadow || '';
        else node.style.removeProperty('text-shadow');
      } else {
        node.style.removeProperty('color');
        node.style.removeProperty('position');
        node.style.removeProperty('z-index');
        node.style.removeProperty('text-shadow');
      }
    }
    delete this._hiTargetNodes[id];
    if (this._hiTargetOrig) delete this._hiTargetOrig[id];
    if (this._hiTargetStyleKey) delete this._hiTargetStyleKey[id];
  };

  TourController.prototype._clearAllHiTargets = function () {
    var self = this;
    Object.keys(this._hiTargetNodes || {}).forEach(function (id) { self._clearHiTargetById(id); });
  };

  TourController.prototype._applyHiTarget = function (h, m, anim) {
    if (!m || !m.textLike || anim === 'text-glow') return;
    var node = m.node;
    var span = this._hiSpan(h);
    var styleKey = anim + '|' + (h.color || '#ff4d8d') + '|' + span.toFixed(2);
    var prev = this._hiTargetNodes[h.id];
    if (prev && (Array.isArray(prev) || prev !== node)) this._clearHiTargetById(h.id);
    if (this._hiTargetStyleKey[h.id] === styleKey && prev === node) return;
    this._hiTargetStyleKey[h.id] = styleKey;
    HI_ANIM_CLASSES.forEach(function (c) { node.classList.remove(c); });
    node.classList.add('tourly-hi-target-text');
    node.classList.remove('tourly-hi-target-text-glow');
    node.classList.add('tourly-hi-anim-' + anim);
    node.style.setProperty('--tly-hi-color', h.color || '#ff4d8d');
    node.style.animation = 'none';
    void node.offsetWidth;
    node.style.animation = '';
    this._hiTargetNodes[h.id] = node;
  };

  TourController.prototype._applyHiTextGlow = function (h, m) {
    if (!m || !m.node) return;
    var targets = textGlowTargets(m.node);
    if (!targets.length) return;
    var span = this._hiSpan(h);
    var styleKey = 'text-glow|' + (h.color || '#ff4d8d') + '|' + span.toFixed(2);
    var prev = this._hiTargetNodes[h.id];
    if (prev && (!Array.isArray(prev) || prev.length !== targets.length || prev[0] !== targets[0])) {
      this._clearHiTargetById(h.id);
      prev = null;
    }
    if (this._hiTargetStyleKey[h.id] === styleKey && Array.isArray(prev) && prev.length === targets.length) return;
    if (prev) this._clearHiTargetById(h.id);
    this._hiTargetStyleKey[h.id] = styleKey;
    var origs = [];
    for (var i = 0; i < targets.length; i++) {
      var node = targets[i];
      HI_ANIM_CLASSES.forEach(function (c) { node.classList.remove(c); });
      node.classList.add('tourly-hi-target-text', 'tourly-hi-target-text-glow', 'tourly-hi-anim-text-glow');
      node.style.setProperty('--tly-hi-color', h.color || '#ff4d8d');
      origs.push({ textShadow: node.style.textShadow || '' });
      node.style.animation = 'none';
      void node.offsetWidth;
      node.style.animation = '';
    }
    this._hiTargetNodes[h.id] = targets;
    this._hiTargetOrig[h.id] = origs;
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
    // Paint the ring at the depth its target paints at, so page chrome that covers the target
    // covers the ring too. Cached per node — this runs on every timeupdate.
    if (ov._hiZNode !== node) {
      ov._hiZNode = node;
      ov._hiZ = String(rootStackingZ(node));
    }
    if (ov.style.zIndex !== ov._hiZ) ov.style.zIndex = ov._hiZ;
    var ringOut = hiRingOutset(anim);
    if (anim === 'text-glow') {
      if (!nodeHasTextContent(node)) {
        this._clearHiTargetById(h.id);
        ov.style.display = 'none';
        ov._hiMode = null;
        return null;
      }
      ov._hiMode = 'text-glow';
      var shellHide = ov.querySelector('.tourly-hi-ring-shell');
      if (shellHide) shellHide.style.display = 'none';
      ov.style.display = 'none';
      return m;
    }
    var usesRing = anim === 'box-glow' || anim === 'outline' || anim === 'sweep' || anim === 'pulse' || !m.textLike;
    if (m.textLike && !usesRing) {
      ov._hiMode = 'text';
      var shellHide = ov.querySelector('.tourly-hi-ring-shell');
      if (shellHide) shellHide.style.display = 'none';
      ov.style.display = 'none';
      return m;
    }
    if (ov._hiMode !== 'ring') {
      this._clearHiTargetById(h.id);
      ov._hiMode = 'ring';
    }
    ov.style.display = 'block';
    ov.style.left = Math.round(r.left - pad - ringOut) + 'px';
    ov.style.top = Math.round(r.top - pad - ringOut) + 'px';
    ov.style.width = Math.round(Math.max(0, r.width + pad * 2 + ringOut * 2)) + 'px';
    ov.style.height = Math.round(Math.max(0, r.height + pad * 2 + ringOut * 2)) + 'px';
    ov.style.removeProperty('border-radius');
    ov.style.setProperty('--tly-hi-stroke', String(m.stroke));
    var width = Math.round(Math.max(0, r.width + pad * 2 + ringOut * 2));
    var height = Math.round(Math.max(0, r.height + pad * 2 + ringOut * 2));
    var layoutKey = [anim, width, height, Math.round(m.radii.tl), Math.round(m.radii.tr), Math.round(m.radii.br), Math.round(m.radii.bl)].join('|');
    if (ov._hiLayoutKey !== layoutKey) {
      ov._hiLayoutKey = layoutKey;
      this._layoutHiRing(ov, m, anim);
    }
    return m;
  };

  TourController.prototype._syncHighlights = function (t, forceSync) {
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
    var active = [], i, h, entry;
    for (i = 0; i < list.length; i++) {
      entry = this._hiRenderEntry(list[i], t, this._hiPreviewId);
      if (entry) active.push(entry);
    }
    var activeKey = active.map(function (e) { return e.h.id + (e.preview ? ':p' : ''); }).join(',');
    var seen = {};
    for (i = 0; i < active.length; i++) {
      var entry = active[i];
      h = entry.h;
      var at = entry.at;
      seen[h.id] = true;
      var ov = this._hiOverlays[h.id];
      if (!ov) {
        ov = el('div', 'tourly-hi-overlay');
        this._hiLayer.appendChild(ov);
        this._hiOverlays[h.id] = ov;
      }
      var color = h.color || '#ff4d8d';
      var node = this._queryTarget(h.target);
      if (!node) {
        ov.style.display = 'none';
        this._clearHiTargetById(h.id);
        continue;
      }
      var m = this._measureHighlightForOverlay(node, ov);
      var kind = m.textLike ? 'text' : 'box';
      var anim = resolveHiAnim((h.animation || 'pulse').replace(/\s+/g, '-'), kind);
      var styleKey = this._hiStyleKey(h, kind, anim);
      var styleChanged = ov._hiStyleKey !== styleKey;
      if (styleChanged) {
        ov._hiStyleKey = styleKey;
        ov.className = 'tourly-hi-overlay tourly-hi-kind-' + kind + ' tourly-hi-anim-' + anim;
        ov.style.setProperty('--tly-hi-color', color);
        ov._hiAnimLastT = null;
      }
      m = this._layoutHiOverlay(h, ov, anim);
      if (!m) continue;
      if (anim === 'text-glow') {
        if (styleChanged || !this._hiTargetNodes[h.id]) this._applyHiTextGlow(h, m);
        if (styleChanged) {
          var tgList = this._hiTargetList(h.id);
          for (var tgi = 0; tgi < tgList.length; tgi++) {
            tgList[tgi].style.animation = 'none';
            void tgList[tgi].offsetWidth;
            tgList[tgi].style.animation = '';
          }
        }
        var tg0 = this._hiTargetList(h.id)[0];
        this._applyHiAnimTiming(ov, h, at, anim, kind, tg0, styleChanged || forceSync, entry.preview);
      } else if (m.textLike && anim !== 'box-glow') {
        if (styleChanged || !this._hiTargetNodes[h.id]) this._applyHiTarget(h, m, anim);
        this._applyHiAnimTiming(ov, h, at, anim, kind, m.node, styleChanged || forceSync, entry.preview);
      } else {
        if (styleChanged) this._restartHiAnim(ov);
        this._applyHiAnimTiming(ov, h, at, anim, kind, null, styleChanged || forceSync, entry.preview);
      }
    }
    Object.keys(this._hiOverlays).forEach(function (id) {
      if (!seen[id]) {
        this._hiOverlays[id].style.display = 'none';
        this._clearHiTargetById(id);
        delete this._hiOverlays[id]._hiStyleKey;
        delete this._hiOverlays[id]._hiAnimLastT;
        delete this._hiOverlays[id]._hiMode;
      }
    }, this);
    this._hiActiveKey = activeKey;
  };

  TourController.prototype._updateSubPosition = function () {
    if (!this._subEl) return;
    var lift = this._subLift || 0;
    var playing = this.state === 'playing';
    var show = playing || (this.mode === 'edit' && !this._isLivePreview());
    var pos = this._subPos || 'bottom-center';
    var vec = exitVector(pos);
    var dx = 0, dy = 0, opacity;
    if (this._subVisible && show) {
      dy = -lift; opacity = '1';
    } else {
      // Leave toward the edge the cue is anchored to rather than always downward, so a top-placed
      // subtitle exits upward and a side-placed one exits sideways.
      var dist = this._subVisible ? SUB_EXIT_PX : SUB_IDLE_PX;
      dx = vec.x * dist;
      dy = vec.y * dist;
      opacity = '0';
    }
    this._subEl.style.transform = offsetTransform(pos, dx + 'px', dy + 'px');
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

  // Editor-only chrome (always-on guided frame, held notification, idle subtitle). Gated on mode as
  // well as the flag so a stray `previewTour` in a published config can never pin preview-only
  // furniture onto a real embed — the flag alone is not trusted.
  TourController.prototype._isLivePreview = function () {
    return this.mode === 'edit' && !!(this.config.behavior && this.config.behavior.previewTour);
  };

  TourController.prototype._guidedFrameColor = function () {
    var gf = (this.config.theme && this.config.theme.guidedFrame) || {};
    return gf.color || DEFAULT_FRAME_COLOR;
  };

  TourController.prototype._breakInsetPx = function () {
    return (this._breakCharge / BREAK_CHARGE_MAX) * BREAK_MAX_INSET;
  };

  TourController.prototype._clearBreakIdleTimer = function () {
    if (this._breakIdleTimer) { clearTimeout(this._breakIdleTimer); this._breakIdleTimer = 0; }
  };

  TourController.prototype._paintGuidedFrame = function (insetPx, animate) {
    if (!this._guidedFrame) return;
    var frame = this._guidedFrame;
    var always = this._isLivePreview() || this._frameHeld;
    var color = this._guidedFrameColor();
    var show = always || insetPx > 0.05;
    var dur = BREAK_RETRACT_MS + 'ms';
    frame.style.transition = animate ? ('box-shadow ' + dur + ' ease-out') : 'none';
    frame.style.transform = 'none';
    frame.style.borderWidth = this._frameHeld ? GUIDED_FRAME_BORDER_PREVIEW : GUIDED_FRAME_BORDER;
    if (!show) {
      frame.style.opacity = '0';
      frame.style.borderColor = 'transparent';
      frame.style.boxShadow = 'none';
      return;
    }
    frame.style.opacity = '1';
    frame.style.borderColor = color;
    frame.style.boxShadow = insetPx > 0.05
      ? ('inset 0 0 0 ' + insetPx.toFixed(2) + 'px ' + color)
      : 'none';
  };

  TourController.prototype._finishGuidedFrameRetract = function () {
    this._breakCharge = 0;
    this._breakExiting = false;
    this._paintGuidedFrame(0, false);
  };

  TourController.prototype._retractGuidedFrame = function () {
    var self = this;
    if (!this._guidedFrame || this._breakExiting) return;
    this._clearBreakIdleTimer();
    if (this._breakInsetPx() <= 0.05) {
      this._breakCharge = 0;
      if (!this._isLivePreview()) this._paintGuidedFrame(0, false);
      else this._paintGuidedFrame(0, false);
      return;
    }
    this._breakExiting = true;
    this._paintGuidedFrame(0, true);
    setTimeout(function () {
      if (self._destroyed) return;
      self._finishGuidedFrameRetract();
    }, BREAK_RETRACT_MS + 16);
  };

  TourController.prototype._resetGuidedFrame = function (instant) {
    if (!this._guidedFrame) return;
    this._clearBreakIdleTimer();
    this._breakCharge = 0;
    this._breakExiting = false;
    this._guidedFrame.style.transition = instant ? 'none' : '';
    this._guidedFrame.style.transform = 'none';
    this._paintGuidedFrame(0, !instant && this._isLivePreview());
  };

  TourController.prototype._updateGuidedFrame = function () {
    this._paintGuidedFrame(this._breakInsetPx(), false);
  };

  TourController.prototype._feedBreakCharge = function (weight) {
    if (!this._isLocked() || this._breakExiting) return;
    this._clearBreakIdleTimer();
    this._breakCharge = Math.min(BREAK_CHARGE_MAX, this._breakCharge + weight);
    this._paintGuidedFrame(this._breakInsetPx(), false);
    if (this._breakCharge >= BREAK_CHARGE_MAX) {
      this._triggerScrollBreak();
      return;
    }
    var self = this;
    this._breakIdleTimer = setTimeout(function () { self._retractGuidedFrame(); }, BREAK_IDLE_MS);
  };

  TourController.prototype._triggerScrollBreak = function () {
    if (this._breakExiting || !this._guidedFrame) return;
    this._clearBreakIdleTimer();
    this._hideToast();
    this._scrolledWhilePaused = true;
    this.pause(); // saves pre-play alignment tween; playback scroll follows video time on resume
    this._retractGuidedFrame();
  };

  // ---- scroll lock + toast ------------------------------------------------
  TourController.prototype._isLocked = function () {
    return this.state === 'playing' && this.config.behavior.scrollLock && this.mode !== 'edit-free';
  };

  TourController.prototype._bindListeners = function () {
    var self = this;
    this._onWheel = function (e) { if (self._isLocked()) { e.preventDefault(); self._feedBreakCharge(Math.min(Math.abs(e.deltaY) || 40, 120)); } };
    this._onTouch = function (e) {
      if (!self._isLocked()) return;
      e.preventDefault();
      self._feedBreakCharge(60);
    };
    this._onKey = function (e) { if (self._isLocked() && SCROLL_KEYS[e.key]) { e.preventDefault(); self._feedBreakCharge(90); } };
    this._onResize = debounce(function () {
      self._applyTheme();
      if (self._activeIdx >= 0 && self._points[self._activeIdx]) {
        var y = self.resolveTargetY(self._points[self._activeIdx].target);
        if (y != null) self._snapScroll(y);
      }
      self._syncHighlights(self.getTime(), true);
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
    if (this._toastHeld) return; // held open by the editor's radius preview
    this._toast.style.opacity = '0';
    this._toast.style.transform = 'translateX(-50%) translateY(24px)';
    this._subLift = 0;
    this._updateSubPosition();
  };

  // ---- editor helpers -----------------------------------------------------
  TourController.prototype.setConfig = function (cfg) {
    this.config = normalizeConfig(cfg);
    this._resortPoints();
    this._applyTheme();
    this._activeIdx = -2;              // force scroll re-evaluation
    this._lastSub = null;
    // While paused/idle (typical when editing Appearance), don't yank the page —
    // only seek/scrub should relocate scroll. While playing, re-snap so the tour
    // stays aligned after theme or point edits.
    this._syncScroll(this.getTime(), this.state === 'playing');
    this._syncSubtitles(this.getTime());
    this._syncHighlights(this.getTime(), true);
    if (this._startBtn) {
      var hideStart = this.state === 'playing' || (this.mode === 'edit' && !this._isLivePreview());
      this._startBtn.style.display = hideStart ? 'none' : 'flex';
    }
    this._updateSubPosition();
    this._updateGuidedFrame();
    this._emit('configchange', this.config);
  };
  TourController.prototype.setEditorUiRaised = function (raised) {
    this._editorUiRaised = !!raised;
    this._applyHiLayerZ();
    return this;
  };
  TourController.prototype.setPreviewVisible = function (visible) {
    if (!this._root) return this;
    if (visible) {
      this._root.style.display = '';
      this._syncSubtitles(this.getTime());
      this._updateSubPosition();
      this._updateGuidedFrame();
    } else {
      if (this.state === 'playing') this.pause();
      this._root.style.display = 'none';
      this._resetGuidedFrame(true);
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
  TourController.prototype.isTextHighlightTarget = function (target) {
    var node = this._queryTarget(target);
    return !!(node && isTextLikeNode(node));
  };
  TourController.prototype.highlightTargetHasText = function (target) {
    var node = this._queryTarget(target);
    return nodeHasTextContent(node);
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
    this._removeReopenHotspot();
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._tweenRAF) cancelAnimationFrame(this._tweenRAF);
    this._clearBreakIdleTimer();
    this._clearAlignHold();
    if (this._onTimelineEnd) {
      document.removeEventListener('mouseup', this._onTimelineEnd);
      document.removeEventListener('touchend', this._onTimelineEnd);
      this._onTimelineEnd = null;
    }
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
    _instances: [],
    // Shared with the editor pick overlay so highlight radius matches live highlight geometry
    // (transparent surfaces get the same default radius as engine outlines).
    overlayCornerRadiiCss: function (el) {
      if (!el || el.nodeType !== 1) return '0px';
      var rect = el.getBoundingClientRect();
      var cs = window.getComputedStyle(el);
      return readCornerRadii(cs, rect, isTransparentSurface(cs)).css;
    }
  };
  var _origMount = Tourly.mount;
  Tourly.mount = function (config, options) { var t = _origMount(config, options); Tourly._instances.push(t); return t; };

  window.Tourly = Tourly;

  function doMount(config) {
    if (window.__TOURLY_MOUNTED__) return;
    window.__TOURLY_MOUNTED__ = true;
    try { Tourly.mount(config, { mode: 'live' }); }
    catch (e) { console.error('[Tourly] mount failed:', e); }
  }

  // Concise export mode: a script tag with a data-tourly-id attribute and no inline config —
  // fetched by id at load time instead. Silent no-op on any failure (offline backend, deleted
  // tour, etc.) — a page must never break because a tour couldn't load.
  // Optional data-tourly-z-index on that same tag overrides theme.video.zIndex (the one page-author
  // knob without republishing the tour).
  // NOTE: this whole file is inlined verbatim into self-contained exports inside a real script
  // element — never write a literal closing script tag anywhere in this file, comments included
  // (e.g. spell it out in prose, or split it across a concatenation), or a browser's HTML parser
  // will terminate the surrounding tag early and corrupt the page.
  function readEmbedZIndex(scriptEl) {
    if (!scriptEl) return null;
    var raw = scriptEl.getAttribute('data-tourly-z-index');
    if (raw == null || raw === '') return null;
    var n = parseInt(raw, 10);
    return isFinite(n) ? n : null;
  }

  function applyEmbedOverrides(config, overrides) {
    if (!config || !overrides) return config;
    if (overrides.zIndex != null) {
      config.theme = config.theme || {};
      config.theme.video = Object.assign({}, config.theme.video, { zIndex: overrides.zIndex });
    }
    return config;
  }

  function fetchAndMount(tourId, overrides) {
    var url = TOURLY_BACKEND.url + '/rest/v1/rpc/get_tour_config';
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: TOURLY_BACKEND.anonKey },
      body: JSON.stringify({ tour_id: tourId })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (config) {
        if (!config) return;
        doMount(applyEmbedOverrides(config, overrides));
      })
      .catch(function () { /* offline/unreachable — silently skip, page still works */ });
  }

  function autoMount() {
    if (window.__TOURLY_MOUNTED__) return;
    if (window.TOURLY_CONFIG) { doMount(window.TOURLY_CONFIG); return; }
    var ref = document.querySelector('script[data-tourly-id]');
    var tourId = ref && ref.getAttribute('data-tourly-id');
    if (!tourId) return;
    var z = readEmbedZIndex(ref);
    fetchAndMount(tourId, z != null ? { zIndex: z } : null);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount);
  else autoMount();
})();
