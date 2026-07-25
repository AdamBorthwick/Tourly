// Popup: open the editor and list cloud-synced tours (shared backend — no user setup).
const $ = id => document.getElementById(id);
const statusEl = $('status');

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Wake the service worker with retries (MV3 workers sleep; first message often fails).
function bg(msg, tries) {
  tries = tries || 0;
  return new Promise(function (res) {
    try {
      chrome.runtime.sendMessage(msg, function (r) {
        if (chrome.runtime.lastError) {
          if (tries < 4) {
            sleep(80 * (tries + 1)).then(function () { res(bg(msg, tries + 1)); });
            return;
          }
          res(null);
          return;
        }
        res(r);
      });
    } catch (e) { res(null); }
  });
}

async function wakeBackground() {
  return bg({ type: 'ping' });
}

$('open').addEventListener('click', async () => {
  statusEl.textContent = 'Injecting…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) { statusEl.textContent = 'No active tab.'; return; }
    if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
      statusEl.textContent = 'Open a normal web page (e.g. your Webflow page) first.';
      return;
    }
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/editor.css'] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['lib/playerjs.min.js', 'content/engine.js', 'content/editor.js']
    });
    statusEl.textContent = 'Editor opened.';
    window.close();
  } catch (e) {
    statusEl.textContent = 'Error: ' + e.message;
  }
});

async function refreshConfig() {
  await wakeBackground();
  var cfg = await bg({ type: 'getConfig' });
  var el = $('syncStatus');
  if (!cfg) {
    el.className = 'sync-err';
    el.textContent = 'Background not responding — click Reload on chrome://extensions, then reopen this popup';
    return cfg;
  }
  if (cfg.configured) {
    el.className = 'sync-ok';
    el.textContent = 'Synced · account ' + (cfg.userId || '').slice(0, 8);
  } else {
    el.className = 'sync-err';
    el.textContent = cfg.error || 'Cloud sync unavailable — tours saved locally only.';
  }
  return cfg;
}

function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

function tourPageLabel(pageUrl) {
  if (!pageUrl) return '';
  try {
    var u = new URL(pageUrl);
    return u.pathname + (u.search || '') || pageUrl;
  } catch (e) {
    return pageUrl;
  }
}

function openTourPage(pageUrl) {
  if (!pageUrl) return;
  chrome.tabs.create({ url: pageUrl });
  window.close();
}

async function loadTours() {
  var cfg = await refreshConfig();
  var box = $('tours');
  if (!cfg || !cfg.configured) {
    box.innerHTML = '<span class="muted">' + esc((cfg && cfg.error) || 'Cloud sync unavailable — tours saved locally in your browser.') + '</span>';
    return;
  }
  box.textContent = 'Loading…';
  var res = await bg({ type: 'toursList' });
  if (!res || !res.ok) {
    box.innerHTML = '<span class="muted">Could not load tours: ' + esc((res && res.error) || 'error') + '</span>';
    return;
  }
  var rows = res.data || [];
  if (!rows.length) { box.innerHTML = '<span class="muted">No saved tours yet.</span>'; return; }
  box.innerHTML = '';
  rows.forEach(function (r) {
    var pageUrl = r.page_url || '';
    var el = document.createElement('div');
    el.className = 'tour' + (pageUrl ? ' tour-clickable' : '');
    if (pageUrl) {
      el.title = 'Open ' + pageUrl;
      el.addEventListener('click', function () { openTourPage(pageUrl); });
    }
    var left = document.createElement('div');
    var name = document.createElement('b');
    name.textContent = r.name || 'Untitled';
    left.appendChild(name);
    if (pageUrl) {
      var url = document.createElement('small');
      url.className = 'tour-url';
      url.textContent = tourPageLabel(pageUrl);
      left.appendChild(document.createElement('br'));
      left.appendChild(url);
    }
    var right = document.createElement('small');
    right.textContent = r.updated_at ? new Date(r.updated_at).toLocaleDateString() : '';
    el.appendChild(left);
    el.appendChild(right);
    box.appendChild(el);
  });
}

$('refresh').addEventListener('click', loadTours);

(async function () { await loadTours(); })();
