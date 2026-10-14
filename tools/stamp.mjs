// Versions the app's own scripts before every deploy.
//
//   node tools/stamp.mjs           rewrite index.html and sw.js
//   node tools/stamp.mjs --check   exit 1 if they are not up to date (used by the e2e test)
//
// index.html loads ./audio.js?v=HASH and ./relay.js?v=HASH (content hashes), and
// sw.js precaches exactly those URLs under VERSION = 'glubschi-' + hash of the whole
// shell. So a new index.html can never run with an old cached relay.js, and every
// deploy changes sw.js, which makes the "Neue Version da" toast appear.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(APP, f));
const hash = (...bufs) => { const h = crypto.createHash('sha256'); for (const b of bufs) h.update(b); return h.digest('hex').slice(0, 10); };
const SCRIPTS = ['audio.js', 'relay.js'];
const SHELL_EXTRA = ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];

const v = Object.fromEntries(SCRIPTS.map((f) => [f, hash(read(f))]));

let index = read('index.html').toString('utf8');
for (const f of SCRIPTS) {
  const re = new RegExp('<script src="\\./' + f.replace('.', '\\.') + '(\\?v=[0-9a-f]*)?"></script>', 'g');
  const n = (index.match(re) || []).length;
  if (n !== 1) throw new Error('index.html: expected one <script src="./' + f + '">, found ' + n);
  index = index.replace(re, '<script src="./' + f + '?v=' + v[f] + '"></script>');
}

let sw = read('sw.js').toString('utf8');
for (const f of SCRIPTS) {
  const re = new RegExp("'\\./" + f.replace('.', '\\.') + "(\\?v=[0-9a-f]*)?'", 'g');
  const n = (sw.match(re) || []).length;
  if (n !== 1) throw new Error("sw.js: expected one './" + f + "' in PRECACHE, found " + n);
  sw = sw.replace(re, "'./" + f + '?v=' + v[f] + "'");
}
const shell = hash(Buffer.from(index), ...SCRIPTS.map(read), ...SHELL_EXTRA.map(read),
  Buffer.from(sw.replace(/const VERSION = '[^']*';/, '')));
const vre = /const VERSION = '[^']*';/;
if (!vre.test(sw)) throw new Error('sw.js: no VERSION line');
sw = sw.replace(vre, "const VERSION = 'glubschi-" + shell + "';");

const check = process.argv.includes('--check');
const stale = [];
if (index !== read('index.html').toString('utf8')) stale.push('index.html');
if (sw !== read('sw.js').toString('utf8')) stale.push('sw.js');
if (check) {
  if (stale.length) { console.error('stamp: out of date: ' + stale.join(', ') + '. Run: node tools/stamp.mjs'); process.exit(1); }
  console.log('stamp: up to date (glubschi-' + shell + ')');
} else {
  if (stale.includes('index.html')) fs.writeFileSync(path.join(APP, 'index.html'), index);
  if (stale.includes('sw.js')) fs.writeFileSync(path.join(APP, 'sw.js'), sw);
  console.log('stamp: ' + (stale.length ? 'updated ' + stale.join(', ') : 'nothing to do') + ' -> glubschi-' + shell + ', ' + SCRIPTS.map((f) => f + '?v=' + v[f]).join(', '));
}
