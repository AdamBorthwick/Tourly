// Release helper: bump manifest.json's version, rebuild the store zip, commit + tag.
// Pass --publish to also push and create a GitHub Release with the zip attached
// (requires `gh auth login` once — see README below).
//
// Usage:
//   node store-assets/release.js            # patch bump, local only (bump+zip+commit+tag)
//   node store-assets/release.js minor       # minor bump
//   node store-assets/release.js 1.4.0       # explicit version
//   node store-assets/release.js --publish   # also push + gh release create
//   node store-assets/release.js minor --publish
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { makeZip } = require('./zip-lib');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'tourly-extension', 'manifest.json');

function sh(cmd, opts) {
  console.log('$ ' + cmd);
  return execSync(cmd, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', ...opts }).trim();
}
function shOk(cmd) {
  try { sh(cmd); return true; } catch (e) { return false; }
}

function bumpVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind; // explicit version
  const [maj, min, pat] = current.split('.').map(Number);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`; // patch (default)
}

function main() {
  const args = process.argv.slice(2);
  const publish = args.includes('--publish');
  const kind = args.find(a => a !== '--publish') || 'patch';

  const manifestText = fs.readFileSync(MANIFEST, 'utf8');
  const manifest = JSON.parse(manifestText);
  const oldVersion = manifest.version;
  const newVersion = bumpVersion(oldVersion, kind);
  const tag = 'v' + newVersion;

  console.log(`\nTourly release: ${oldVersion} → ${newVersion}\n`);

  // 1. Bump version in-place (regex replace so the rest of the file's formatting is untouched)
  const bumped = manifestText.replace(
    /("version"\s*:\s*")[^"]+(")/,
    `$1${newVersion}$2`
  );
  if (bumped === manifestText) throw new Error('Could not find a "version" field to bump in manifest.json');
  fs.writeFileSync(MANIFEST, bumped);
  console.log('✓ bumped tourly-extension/manifest.json');

  // 2. Rebuild the zip (stable name for direct Web Store upload, plus a versioned copy for the GitHub Release asset)
  const stableZip = path.join(__dirname, 'tourly-extension.zip');
  const versionedZip = path.join(__dirname, `tourly-extension-${tag}.zip`);
  const files = makeZip(path.join(ROOT, 'tourly-extension'), stableZip);
  fs.copyFileSync(stableZip, versionedZip);
  console.log(`✓ built ${path.relative(ROOT, stableZip)} and ${path.relative(ROOT, versionedZip)} (${files.length} files)`);

  // 3. Commit just the version bump, tag it
  sh(`git add "${MANIFEST}"`);
  sh(`git commit -m "Release ${tag}"`);
  sh(`git tag ${tag}`);
  console.log(`✓ committed and tagged ${tag}`);

  // 4. Warn about anything else left uncommitted, so it's never silently excluded from a release
  const dirty = sh('git status --porcelain');
  if (dirty) {
    console.log('\n⚠ Other uncommitted changes exist (NOT included in this release commit):');
    console.log(dirty.split('\n').map(l => '  ' + l).join('\n'));
  }

  if (!publish) {
    console.log(`\nLocal steps done. To publish:`);
    console.log(`  git push && git push --tags`);
    console.log(`  gh release create ${tag} "${path.relative(ROOT, versionedZip)}" --title "${tag}" --notes "Tourly ${tag}"`);
    console.log(`\n(or re-run with --publish to do both automatically)`);
    return;
  }

  // 5. --publish: push, then create the GitHub Release with the zip attached
  const authed = shOk('gh auth status');
  if (!authed) {
    console.log('\n⚠ gh is not authenticated. Run `gh auth login` once, then re-run with --publish.');
    console.log(`  (the commit and tag above are already done locally — nothing lost)`);
    process.exitCode = 1;
    return;
  }

  sh('git push');
  sh('git push --tags');
  sh(`gh release create ${tag} "${versionedZip}" --title "${tag}" --notes "Tourly ${tag}"`);
  console.log(`\n✓ Published ${tag} to GitHub Releases.`);
  console.log(`  Chrome Web Store still needs a separate manual upload of ${path.relative(ROOT, stableZip)} in the Developer Dashboard.`);
}

main();
