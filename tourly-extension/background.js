// Service worker.
//  (a) Resolves a vidzflow embed URL to a direct MP4 for the editor's native-video preview.
//  (b) Shared Supabase backend: silent anonymous sign-in → JWT per install, RLS isolates tours.
//  (c) Proxies REST + edge functions so content scripts avoid CORS.
// Credentials: tourly-extension/supabase-config.js (gitignored, loaded at runtime).

const SESSION_KEY = 'tourly:session';
const LEGACY_CFG_KEY = 'tourly:supabase';
const SB_CFG_KEY = 'tourly:sbConfig';       // cached copy of supabase-config.js
var TOURLY_SUPABASE = null;
var _cfgReady = null;

// Register the message handler FIRST — must survive config-load failures.
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  // Fast ping — wakes the worker and confirms the channel is open.
  if (msg.type === 'ping') { sendResponse({ ok: true, pong: true }); return false; }
  handle(msg).then(sendResponse).catch(function (e) {
    sendResponse({ ok: false, error: String(e && e.message || e) });
  });
  return true;
});

function loadSupabaseConfig() {
  if (_cfgReady) return _cfgReady;
  _cfgReady = (async function () {
    // Prefer cached config (survives service-worker restarts).
    var cached = await storageGet(SB_CFG_KEY);
    if (cached && cached.url && cached.anonKey) {
      TOURLY_SUPABASE = cached;
      return TOURLY_SUPABASE;
    }
    try {
      var res = await fetch(chrome.runtime.getURL('supabase-config.js'));
      var code = await res.text();
      var urlM = code.match(/url:\s*'([^']+)'/);
      var keyM = code.match(/anonKey:\s*'([^']+)'/);
      if (urlM && keyM && keyM[1]) {
        TOURLY_SUPABASE = { url: urlM[1], anonKey: keyM[1] };
        await storageSet({ [SB_CFG_KEY]: TOURLY_SUPABASE });
        return TOURLY_SUPABASE;
      }
    } catch (e) { /* fall through */ }
    return null;
  })();
  return _cfgReady;
}

// Warm config + auth on install/update.
chrome.runtime.onInstalled.addListener(function () {
  loadSupabaseConfig().then(function () { return getConfig(); }).catch(function () {});
});

async function handle(msg) {
  switch (msg.type) {
    case 'resolveVideo': return { mp4: await resolveMp4(msg.url) };
    case 'getConfig':    return getConfig();
    case 'toursList':    return sb('GET', '?select=id,name,page_url,updated_at&order=updated_at.desc');
    case 'toursGet':     return sb('GET', '?page_url=eq.' + enc(msg.pageUrl || '') + '&limit=1');
    case 'toursSave':    return saveTour(msg.tour);
    case 'toursDelete':  return sb('DELETE', '?id=eq.' + enc(msg.id));
    case 'transcribeSubtitles': return transcribeSubtitles(msg.embedUrl, msg.videoId);
    case 'authAddEmail': return authAddEmail(msg.email);
    case 'authSignIn':   return authSignIn(msg.email);
    case 'authVerifyCode': return authVerifyCode(msg.mode, msg.email, msg.token);
    case 'authSignOut':  return authSignOut();
    default:             return { ok: false, error: 'unknown message ' + msg.type };
  }
}

// ---- vidzflow MP4 resolver ----
async function resolveMp4(embedUrl) {
  try {
    const res = await fetch(embedUrl);
    const html = await res.text();
    const all = [...html.matchAll(/https?:\/\/r2\.vidzflow\.com\/v\/[A-Za-z0-9_]+_(\d+)p_\d+\.mp4/g)];
    if (!all.length) return null;
    const best = all.find(m => m[1] === '576') || all.sort((a, b) => (+a[1]) - (+b[1]))[0];
    return best[0];
  } catch (e) { return null; }
}

// ---- shared supabase config ----
async function sbCfg() {
  await loadSupabaseConfig();
  const c = TOURLY_SUPABASE;
  const url = c && c.url ? c.url.replace(/\/+$/, '') : '';
  let anonKey = c && c.anonKey ? c.anonKey.trim() : '';
  // Fall back to credentials saved via the old popup if config file not filled yet
  if (!anonKey) {
    const legacy = await storageGet(LEGACY_CFG_KEY);
    if (legacy && legacy.anonKey) anonKey = legacy.anonKey.trim();
    if (!url && legacy && legacy.url) return { url: legacy.url.replace(/\/+$/, ''), anonKey };
  }
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

let lastAuthError = '';

function storageGet(key) { return new Promise(r => chrome.storage.local.get(key, o => r(o[key]))); }
function storageSet(obj) { return new Promise(r => chrome.storage.local.set(obj, r)); }

// ---- anonymous auth (silent sign-in per install) ----
async function ensureSession() {
  const cfg = await sbCfg();
  if (!cfg) return null;

  let session = await storageGet(SESSION_KEY);
  const now = Math.floor(Date.now() / 1000);
  if (session && session.access_token && session.expires_at > now + 60) return session;

  if (session && session.refresh_token) {
    const refreshed = await refreshSession(cfg, session.refresh_token);
    if (refreshed) return refreshed;
    // Stale refresh token — clear and sign in fresh.
    await storageSet({ [SESSION_KEY]: null });
  }

  return signInAnonymously(cfg);
}

async function signInAnonymously(cfg) {
  lastAuthError = '';
  try {
    const res = await fetch(cfg.url + '/auth/v1/signup', {
      method: 'POST',
      headers: authHeaders(cfg),
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (!res.ok) {
      lastAuthError = (data && (data.msg || data.message || data.error_description || data.error)) || ('HTTP ' + res.status);
      return null;
    }
    const session = await persistSession(data);
    if (!session) lastAuthError = 'Sign-in succeeded but no access token in response';
    return session;
  } catch (e) {
    lastAuthError = String(e && e.message || e);
    return null;
  }
}

async function refreshSession(cfg, refreshToken) {
  try {
    const res = await fetch(cfg.url + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: authHeaders(cfg),
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    const data = await res.json();
    if (!res.ok) return null;
    return await persistSession(data);
  } catch (e) { return null; }
}

async function persistSession(data) {
  if (!data) return null;
  // GoTrue may return tokens at the root or nested under session (newer API shapes).
  var tok = data.access_token || (data.session && data.session.access_token);
  var refresh = data.refresh_token || (data.session && data.session.refresh_token);
  var expiresIn = data.expires_in || (data.session && data.session.expires_in) || 3600;
  var user = data.user || (data.session && data.session.user);
  if (!tok) return null;
  var session = {
    access_token: tok,
    refresh_token: refresh,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    user_id: user && user.id,
    email: (user && user.email) || null,
    is_anonymous: !!(user && user.is_anonymous)
  };
  await storageSet({ [SESSION_KEY]: session });
  return session;
}

// Re-fetch /auth/v1/user with the current session's own token — used after a successful
// authAddEmail/authSignIn verify, since the verify response's session may be stale/partial
// compared to a fresh GET of the confirmed user record (is_anonymous flips server-side on confirm).
async function refreshUserFields(cfg, session) {
  try {
    var res = await fetch(cfg.url + '/auth/v1/user', { headers: authHeaders(cfg, session.access_token) });
    var user = await res.json();
    if (res.ok && user) {
      session.email = user.email || null;
      session.is_anonymous = !!user.is_anonymous;
      await storageSet({ [SESSION_KEY]: session });
    }
  } catch (e) { /* best-effort */ }
  return session;
}

function authHeaders(cfg, token) {
  const bearer = token || cfg.anonKey;
  return {
    'apikey': cfg.anonKey,
    'Authorization': 'Bearer ' + bearer,
    'Content-Type': 'application/json'
  };
}

async function getConfig() {
  const cfg = await sbCfg();
  if (!cfg) {
    return {
      ok: true, configured: false,
      error: 'Paste your anon key in tourly-extension/supabase-config.js, then reload the extension.'
    };
  }
  const session = await ensureSession();
  if (session) {
    return {
      ok: true, configured: true, url: cfg.url, error: null,
      userId: session.user_id,
      email: session.email || null,
      isAnonymous: session.is_anonymous !== false   // default true (older cached sessions predate this field)
    };
  }
  return {
    ok: true, configured: false, url: cfg.url,
    error: lastAuthError
      ? 'Sign-in failed: ' + lastAuthError
      : 'Sign-in failed — enable Anonymous sign-ins in Supabase → Authentication → Providers'
  };
}

// ---- identity upgrade: anonymous -> email (Flow A) and sign-in-on-another-device (Flow B) ----
// Both send a 6-digit code (not a clickable link — there's no clean way for an email click to
// land back inside a chrome-extension:// popup). Flow A links the SAME auth.uid() to an email,
// so every existing `tours` row (FK'd to that id) is already correctly attached the moment it
// confirms — no migration. Flow B is a real sign-in to a DIFFERENT (pre-existing) account, which
// replaces the current device's session entirely.

// Flow A — upgrade the current (anonymous) session by attaching an email to it.
async function authAddEmail(email) {
  email = (email || '').trim();
  if (!email) return { ok: false, error: 'Email required' };
  const cfg = await sbCfg();
  if (!cfg) return { ok: false, error: 'not configured' };
  const session = await ensureSession();
  if (!session) return { ok: false, error: lastAuthError || 'not authenticated' };

  try {
    const res = await fetch(cfg.url + '/auth/v1/user', {
      method: 'PUT', headers: authHeaders(cfg, session.access_token), body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: (data && (data.msg || data.message || data.error_code)) || ('HTTP ' + res.status) };
    return { ok: true, mode: 'email_change', email };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// Flow B — sign in to an EXISTING (already email-linked) account, e.g. on a new device.
// create_user:false so a typo or a never-upgraded email fails cleanly instead of silently
// creating a brand new, disconnected account.
async function authSignIn(email) {
  email = (email || '').trim();
  if (!email) return { ok: false, error: 'Email required' };
  const cfg = await sbCfg();
  if (!cfg) return { ok: false, error: 'not configured' };

  try {
    const res = await fetch(cfg.url + '/auth/v1/otp', {
      method: 'POST', headers: authHeaders(cfg), body: JSON.stringify({ email, create_user: false })
    });
    if (res.status === 422) return { ok: false, error: 'No account found for that email — use "Add email" instead if this is your first time.' };
    const data = await res.json().catch(function () { return null; });
    if (!res.ok) return { ok: false, error: (data && (data.msg || data.message || data.error_code)) || ('HTTP ' + res.status) };
    return { ok: true, mode: 'email', email };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// Shared verify step for both flows above. `mode` selects the GoTrue `type` — 'email_change' for
// Flow A (confirming an email attached to the current session), 'email' for Flow B (a fresh
// sign-in). On success, persist the returned session (Flow B's session belongs to the OTHER
// account and correctly replaces whatever was here before).
async function authVerifyCode(mode, email, token) {
  email = (email || '').trim(); token = (token || '').trim();
  if (!email || !token) return { ok: false, error: 'Email and code required' };
  if (mode !== 'email_change' && mode !== 'email') return { ok: false, error: 'Invalid verify mode' };
  const cfg = await sbCfg();
  if (!cfg) return { ok: false, error: 'not configured' };

  try {
    const res = await fetch(cfg.url + '/auth/v1/verify', {
      method: 'POST', headers: authHeaders(cfg), body: JSON.stringify({ type: mode, email, token })
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: (data && (data.msg || data.message || data.error_code)) || ('HTTP ' + res.status) };
    var session = await persistSession(data);
    if (!session) return { ok: false, error: 'Verified, but no session returned' };
    session = await refreshUserFields(cfg, session);
    return { ok: true, email: session.email, isAnonymous: session.is_anonymous };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// Drop the current session and fall back to a fresh local-only anonymous identity — never
// deletes anything already synced under the signed-in account, just stops acting as that user.
async function authSignOut() {
  const cfg = await sbCfg();
  const session = await storageGet(SESSION_KEY);
  if (cfg && session && session.access_token) {
    try { await fetch(cfg.url + '/auth/v1/logout', { method: 'POST', headers: authHeaders(cfg, session.access_token) }); } catch (e) {}
  }
  await storageSet({ [SESSION_KEY]: null });
  const fresh = await ensureSession();
  return { ok: !!fresh, email: null, isAnonymous: true };
}

// ---- supabase REST (uses per-install JWT; RLS scopes rows to auth.uid()) ----
async function sb(method, query, body) {
  const cfg = await sbCfg();
  if (!cfg) return { ok: false, error: 'supabase not configured' };
  const session = await ensureSession();
  if (!session) return { ok: false, error: lastAuthError || 'not authenticated' };

  const headers = authHeaders(cfg, session.access_token);
  if (method === 'POST') headers['Prefer'] = 'resolution=merge-duplicates,return=representation';

  try {
    const res = await fetch(cfg.url + '/rest/v1/tours' + (query || ''), {
      method, headers, body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) return { ok: false, status: res.status, error: (data && data.message) || text };
    return { ok: true, data };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

async function saveTour(tour) {
  const row = {
    id: tour.id,
    name: tour.name || null,
    page_url: tour.page_url || null,
    config: tour.config,
    updated_at: new Date().toISOString()
  };
  return sb('POST', '?on_conflict=id', row);
}

// ---- transcription (Supabase Edge Function → Whisper) ----
async function transcribeSubtitles(embedUrl, videoId) {
  const cfg = await sbCfg();
  if (!cfg) return { ok: false, error: 'transcription not configured' };
  const session = await ensureSession();
  if (!session) return { ok: false, error: lastAuthError || 'not authenticated' };

  const mp4 = await resolveMp4(embedUrl);
  if (!mp4) return { ok: false, error: 'could not resolve video MP4' };
  const vid = (videoId || '').trim() || mp4.match(/\/v\/([A-Za-z0-9_-]+)/)?.[1] || mp4;

  try {
    const res = await fetch(cfg.url + '/functions/v1/transcribe', {
      method: 'POST',
      headers: authHeaders(cfg, session.access_token),
      body: JSON.stringify({ mp4Url: mp4, videoId: vid })
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) return { ok: false, error: (data && data.error) || text || ('HTTP ' + res.status) };
    if (!data || !data.ok) return { ok: false, error: (data && data.error) || 'transcription failed' };
    return { ok: true, segments: data.segments || [], cached: !!data.cached };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// ---- utils ----
function enc(s) { return encodeURIComponent(s == null ? '' : s); }
