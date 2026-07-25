// Keeps the extension's copy of the engine in sync with the canonical root engine.js.
// The root engine.js is the single source of truth (also what jsDelivr will serve).
// Run `node sync-engine.js` after editing engine.js.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, 'engine.js');
const dst = path.join(__dirname, 'tourly-extension', 'content', 'engine.js');
fs.copyFileSync(src, dst);
console.log('synced engine.js →', path.relative(__dirname, dst), '(' + fs.statSync(dst).size + ' bytes)');
