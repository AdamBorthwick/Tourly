const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = 8777;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

// Resolve a vidzflow embed URL to a direct MP4 (mirrors the extension's background.js; for harness testing).
function resolveMp4(embedUrl, cb) {
  https.get(embedUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' } }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => {
      const all = [...d.matchAll(/https?:\/\/r2\.vidzflow\.com\/v\/[A-Za-z0-9_]+_(\d+)p_\d+\.mp4/g)];
      if (!all.length) return cb(null);
      const best = all.find(m => m[1] === '576') || all.sort((a, b) => (+a[1]) - (+b[1]))[0];
      cb(best[0]);
    });
  }).on('error', () => cb(null));
}

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/resolve') {
    const q = req.url.split('?')[1] || '';
    const m = q.match(/url=([^&]+)/);
    const target = m ? decodeURIComponent(m[1]) : '';
    return resolveMp4(target, mp4 => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ mp4: mp4 || null }));
    });
  }
  // Dev stub for auto-generate subtitles (editor-harness without Supabase).
  if (p === '/transcribe' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        cached: false,
        segments: [
          { start: 0.0, end: 8.0, text: 'Welcome — let me walk you through this project and explain the core problem users were hitting.' },
          { start: 8.0, end: 18.0, text: "Here's what our research surfaced, and the design we landed on after several iterations." },
          { start: 18.0, end: 25.0, text: 'Finally, the outcome and impact on the business.' }
        ]
      }));
    });
    return;
  }
  if (p === '/transcribe' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  if (p === '/') p = '/test-harness.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found: ' + p); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(PORT, () => console.log('Tourly dev server on http://localhost:' + PORT));
