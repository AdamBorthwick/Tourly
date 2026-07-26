// Quick rebuild of store-assets/tourly-extension.zip for a Chrome Web Store upload
// (no version bump, no git/GitHub involvement — use store-assets/release.js for that).
const path = require('path');
const { makeZip } = require('./zip-lib');

const dest = path.resolve(__dirname, 'tourly-extension.zip');
const files = makeZip(path.resolve(__dirname, '../tourly-extension'), dest);
console.log('wrote', dest, '(' + files.length + ' files)');
files.forEach(f => console.log('  ' + f));
