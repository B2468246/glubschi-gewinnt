// End-to-end test: two (and later a third) real headless Chrome instances play
// Glubschi gewinnt against each other through a local fake ntfy server.
// No npm installs: Chrome DevTools Protocol over node's built-in WebSocket.
//
// Run:  node test/e2e.mjs            (from the app folder, needs Google Chrome)
// Env:  CHROME=/path/to/chrome   SHOTS=/dir/for/screenshots   ONLY=1,2,3 (debug)
//
// Never talks to the real ntfy.sh: Chrome resolves ntfy.sh to nowhere and every
// request to it is counted (must stay 0).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const SHOTS = process.env.SHOTS || path.resolve(APP, '..', 'e2e-shots');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const fakeNtfy = require('./fake-ntfy.js');

const INVITE_LEAD = 'Lust auf eine Runde Glubschi gewinnt? 👀 Vier gewinnt mit Glubschaugen und Musik, also Ton an! 🔊\nTipp auf den Link und setz dich an meinen Tisch:';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(('+' + ((Date.now() - t0) / 1000).toFixed(1) + 's').padStart(8), ...a);

// ------------------------------------------------------------ cleanup
const cleanups = [];
let cleaning = null;
function cleanup() {
  if (!cleaning) cleaning = (async () => { for (const fn of cleanups.reverse()) { try { await fn(); } catch (e) { /* ignore */ } } })();
  return cleaning;
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup().then(() => process.exit(130)); });
process.on('exit', () => { for (const c of chromes) { try { c.proc.kill('SIGKILL'); } catch (e) { /* ignore */ } } });

// ------------------------------------------------------- static server
// Serves a temp dir that symlinks the app as /glubschi-gewinnt/ (like GitHub
// Pages). Test-only: audio.js gets a counter appended, the app itself is not
// changed.
const SFX_SPY = `
;(function () {
  if (typeof createGlubschiAudio !== 'function') return;
  var orig = createGlubschiAudio;
  window.__sfx = [];
  createGlubschiAudio = function () {
    var a = orig.apply(this, arguments), s = a.sfx;
    a.sfx = function (name) { window.__sfx.push(name); return s.apply(a, arguments); };
    window.__audio = a;
    return a;
  };
})();
`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };
function startStatic() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glubschi-site-'));
  fs.symlinkSync(APP, path.join(root, 'glubschi-gewinnt'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p === '/glubschi-gewinnt') { res.writeHead(301, { Location: '/glubschi-gewinnt/' + u.search }); res.end(); return; }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, path.normalize(p));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      if (p === '/glubschi-gewinnt/audio.js') buf = Buffer.concat([buf, Buffer.from(SFX_SPY)]);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    cleanups.push(() => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }));
    resolve('http://127.0.0.1:' + server.address().port);
  }));
}

// --------------------------------------------------------------- CDP
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiters = new Map(); this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (m.id && this.waiters.has(m.id)) {
        const w = this.waiters.get(m.id); this.waiters.delete(m.id);
        if (m.error) w.reject(new Error(w.method + ': ' + m.error.message)); else w.resolve(m.result);
      } else if (m.method) for (const h of this.handlers) h(m.method, m.params || {});
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)));
      ws.addEventListener('error', (e) => reject(new Error('ws error ' + url)));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(fn) { this.handlers.push(fn); }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

// ------------------------------------------------------------ Chrome
const chromes = [];
let portSeed = 9300 + Math.floor(Math.random() * 400);
async function launch(label) {
  const port = portSeed++;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glubschi-chrome-' + label + '-'));
  const args = [
    '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + dir, '--window-size=390,844',
    '--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-default-apps',
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--host-resolver-rules=MAP ntfy.sh ~NOTFOUND, MAP *.ntfy.sh ~NOTFOUND',
    'about:blank'
  ];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  const c = { label, proc, dir, port };
  chromes.push(c);
  const kill = async () => {
    if (c.closed) return;
    c.closed = true;
    try { c.page && c.page.cdp.close(); } catch (e) { /* ignore */ }
    try { proc.kill('SIGTERM'); } catch (e) { /* ignore */ }
    await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]);
    try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
    await sleep(200);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  c.kill = kill;
  cleanups.push(kill);
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(100);
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      target = list.find((t) => t.type === 'page');
    } catch (e) { /* not up yet */ }
  }
  if (!target) throw new Error('Chrome ' + label + ' did not start: ' + stderr);
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  c.page = new Page(label, cdp);
  await c.page.init();
  return c.page;
}

// -------------------------------------------------------------- Page
const realNtfy = [];
class Page {
  constructor(label, cdp) {
    this.label = label; this.cdp = cdp;
    this.errors = []; this.allowed = []; this.requests = []; this.consoleLines = [];
    cdp.on((method, p) => {
      if (method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails || {};
        this.err('exception: ' + ((d.exception && d.exception.description) || d.text) + ' @' + d.url + ':' + d.lineNumber);
      } else if (method === 'Log.entryAdded') {
        const e = p.entry;
        if (e.level === 'error') this.err('log[' + e.source + ']: ' + e.text + (e.url ? ' ' + e.url : ''));
      } else if (method === 'Runtime.consoleAPICalled') {
        const text = (p.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
        this.consoleLines.push(p.type + ': ' + text);
        if (p.type === 'error' || p.type === 'assert') this.err('console.' + p.type + ': ' + text);
      } else if (method === 'Network.requestWillBeSent') {
        const url = p.request.url;
        this.requests.push({ t: Date.now(), url, method: p.request.method, type: p.type });
        try {
          const h = new URL(url).hostname;
          if (h === 'ntfy.sh' || h.endsWith('.ntfy.sh')) { realNtfy.push(this.label + ' ' + url); this.err('REAL ntfy.sh request: ' + url); }
        } catch (e) { /* data: etc */ }
      }
    });
  }
  err(text) {
    if (this.allowed.some((re) => re.test(text))) { this.consoleLines.push('allowed error: ' + text); return; }
    this.errors.push(text);
    log('  [' + this.label + '] ERROR ' + text);
  }
  async init() {
    await Promise.all(['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable'].map((m) => this.cdp.send(m)));
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  }
  async eval(expr) {
    const r = await this.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(this.label + ' eval failed: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text) + '\n  in: ' + expr.slice(0, 200));
    return r.result.value;
  }
  async goto(url) {
    await this.cdp.send('Page.navigate', { url });
    await this.waitFor('document loaded', 'document.readyState === "complete"');
  }
  async reload() {
    await this.cdp.send('Page.reload', { ignoreCache: false });
    await sleep(300);
    await this.waitFor('document reloaded', 'document.readyState === "complete"');
  }
  async waitFor(what, expr, ms = 15000) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      try { last = await this.eval(expr); if (last) return last; } catch (e) { last = e.message; }
      await sleep(80);
    }
    throw new Error(this.label + ': timeout waiting for ' + what + ' (last: ' + JSON.stringify(last) + ')');
  }
  // real mouse click in the middle of the element (counts as a user gesture)
  async click(sel, { index = 0 } = {}) {
    const r = await this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(sel)})[${index}];
      if (!el) return { err: 'no element' };
      let b = el.getBoundingClientRect();
      if (b.top < 0 || b.bottom > innerHeight) { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); b = el.getBoundingClientRect(); }
      if (!b.width || !b.height) return { err: 'not visible' };
      const x = b.left + b.width / 2, y = b.top + Math.min(b.height / 2, b.height - 2);
      const hit = document.elementFromPoint(x, y);
      return { x, y, ok: !!hit && (el === hit || el.contains(hit)), hit: hit ? hit.tagName + '.' + hit.className : null };
    })()`);
    if (r.err) throw new Error(this.label + ': cannot click ' + sel + ': ' + r.err);
    if (!r.ok) throw new Error(this.label + ': ' + sel + ' is covered by ' + r.hit);
    const base = { x: r.x, y: r.y, button: 'left', clickCount: 1 };
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }
  async clickText(sel, text) {
    const i = await this.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].findIndex((e) => e.textContent.trim() === ${JSON.stringify(text)})`);
    if (i < 0) throw new Error(this.label + ': no ' + sel + ' with text ' + text);
    await this.click(sel, { index: i });
  }
  async type(sel, text) {
    await this.click(sel);
    await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.select && e.select(); })()`);
    await this.cdp.send('Input.insertText', { text });
  }
  async shot(name, { keepScroll = false } = {}) {
    fs.mkdirSync(SHOTS, { recursive: true });
    if (!keepScroll) await this.eval('window.scrollTo(0, 0)');
    await sleep(120);
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(SHOTS, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    shots.push(file);
    return file;
  }
  board() { return this.eval(BOARD_EXPR); }
  sfx() { return this.eval('(window.__sfx || []).slice()'); }
  resetSfx() { return this.eval('window.__sfx = []; true'); }
  text(sel) { return this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.textContent.trim() : null; })()`); }
  visible(sel) { return this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); return !e.closest('[hidden]') && r.width > 0 && r.height > 0; })()`); }
  waitVisible(sel, ms) { return this.waitFor(sel + ' visible', `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); return !e.closest('[hidden]') && r.width > 0 && r.height > 0; })()`, ms); }
  waitHidden(sel, ms) { return this.waitFor(sel + ' hidden', `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !e || !!e.closest('[hidden]'); })()`, ms); }
  waitText(sel, text, ms) { return this.waitFor(sel + ' == ' + JSON.stringify(text), `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.textContent.trim() === ${JSON.stringify(text)}; })()`, ms); }
}

// ------------------------------------------------------------ helpers
// board as 42 digits (row-major, row 0 = top), from the DOM (chips being flushed away do not count)
const BOARD_EXPR = `(() => { const cols = document.querySelectorAll('#board .col'); let out = ''; for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) { const ch = cols[c].querySelectorAll('.cell')[r].querySelector('.chip:not(.flush)'); out += ch ? ch.dataset.p : '0'; } return out; })()`;
const shots = [];
const results = [];
function assert(cond, msg) { if (!cond) throw new Error('assertion failed: ' + msg); }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('assertion failed: ' + msg + '\n    got:      ' + JSON.stringify(a) + '\n    expected: ' + JSON.stringify(b)); }
const count = (list, name) => list.filter((x) => x === name).length;
function boardStr(cells) { return cells.join(''); }
function emptyBoard() { return Array(42).fill(0); }
function dropInto(cells, col, p) {
  for (let r = 5; r >= 0; r--) if (!cells[r * 7 + col]) { cells[r * 7 + col] = p; return; }
  throw new Error('column full');
}
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',').map(Number)) : null;
async function scenario(n, name, fn) {
  if (only && !only.has(n)) return;
  log('--- ' + n + '. ' + name);
  const before = pages().map((p) => p.errors.length);
  try {
    const notes = await fn();
    const errs = pages().flatMap((p, i) => p.errors.slice(before[i] || 0).map((e) => p.label + ': ' + e));
    if (errs.length) throw new Error('console errors: ' + errs.join(' | '));
    results.push({ name: n + '. ' + name, result: 'pass', notes: notes || '' });
    log('    pass' + (notes ? ': ' + notes : ''));
  } catch (e) {
    results.push({ name: n + '. ' + name, result: 'fail', notes: e.message });
    log('    FAIL: ' + e.message);
    throw e;
  }
}
let A, B, C;
const pages = () => [A, B, C].filter(Boolean);

async function waitBoards(list, cells, what) {
  const want = boardStr(cells);
  for (const p of list) await p.waitFor(p.label + ' board ' + what, `${BOARD_EXPR} === ${JSON.stringify(want)}`, 10000).catch(async (e) => {
    throw new Error(e.message + '\n    board now: ' + (await p.board()) + '\n    expected:  ' + want);
  });
}

// ---------------------------------------------------------------- main
async function main() {
  // index.html and sw.js must reference the current content hashes of audio.js and relay.js
  const stamp = spawnSync(process.execPath, [path.join(APP, 'tools', 'stamp.mjs'), '--check'], { encoding: 'utf8' });
  if (stamp.status !== 0) throw new Error((stamp.stderr || stamp.stdout).trim());
  log(stamp.stdout.trim());
  const fake = await fakeNtfy.start(0);
  cleanups.push(() => fake.close());
  const site = await startStatic();
  const NTFY = fake.url;
  const START = site + '/glubschi-gewinnt/?ntfy=' + encodeURIComponent(NTFY);
  log('site ' + site + '/glubschi-gewinnt/  fake ntfy ' + NTFY + '  shots ' + SHOTS);
  fs.rmSync(SHOTS, { recursive: true, force: true });

  let code, roomUrl;
  const want = emptyBoard();

  A = await launch('A');
  await A.goto(START);

  await scenario(1, 'A creates a game, sits on Rot, big invite card, WhatsApp text', async () => {
    await A.waitVisible('#start');
    await A.waitFor('fonts', 'document.fonts.ready.then(() => true)');
    assert(!(await A.visible('#recent')), 'no recent rooms on a fresh profile');
    await A.shot('01-start');
    await A.type('#name', 'Ben');
    await A.click('#new-form button[type=submit]');
    await A.waitFor('?raum= in URL', 'new URLSearchParams(location.search).get("raum")');
    code = await A.eval('new URLSearchParams(location.search).get("raum")');
    assert(/^[a-z2-9]{10}$/.test(code), 'room code ' + code);
    await A.waitVisible('#game');
    await A.waitText('#seat1 .seat-name-text', 'Ben');
    await A.waitVisible('#seat1 .you');
    await A.waitFor('conn live', 'document.querySelector("#conn").dataset.s === "live"');
    assert(await A.eval('document.querySelector("#invite").classList.contains("is-big") && document.querySelector("#invite").parentNode.id === "invite-slot-top"'), 'invite card is big and on top');
    assert(await A.visible('#invite-title'), 'invite title visible');
    eq(await A.text('#code-big'), code.slice(0, 4).toUpperCase() + '-' + code.slice(4, 8).toUpperCase() + '-' + code.slice(8).toUpperCase(), 'formatted code');
    roomUrl = site + '/glubschi-gewinnt/?raum=' + code + '&ntfy=' + encodeURIComponent(NTFY);
    const href = await A.eval('document.querySelector("#wa-link").href');
    const u = new URL(href);
    eq(u.origin + u.pathname, 'https://wa.me/', 'WhatsApp link target');
    eq(u.searchParams.get('text'), INVITE_LEAD + '\n' + roomUrl, 'WhatsApp text');
    eq(await A.eval('location.href'), roomUrl, 'A URL equals the shared room URL');
    eq(await A.text('#status-text'), 'Warte auf deinen Gegner', 'status while waiting alone');
    eq(await A.text('#quip'), "Schick ihm den Link. Sobald er sitzt, geht's los.", 'quip while waiting');
    eq(await A.eval('document.title'), 'Glubschi gewinnt', 'no "Du bist dran!" title while alone');
    assert(!(await A.eval('document.querySelector("#seat1").classList.contains("is-turn")')), 'no Dran! sticker while alone');
    await A.shot('03-game-invite');
    return 'room ' + code + ', WhatsApp text ok';
  });

  await scenario(2, 'B opens the room link, name step, auto-seated on Gelb', async () => {
    B = await launch('B');
    await B.goto(roomUrl);
    await B.waitVisible('#name-step');
    await B.waitFor('fonts', 'document.fonts.ready.then(() => true)');
    await B.waitFor('B loaded', 'document.querySelector("#seat1 .seat-name-text").textContent === "Ben"');
    await B.shot('02-name-step');
    await B.type('#name-step-input', 'Cedrik');
    await B.click('#name-step-go');
    await B.waitHidden('#name-step');
    await B.waitText('#seat2 .seat-name-text', 'Cedrik');
    await B.waitVisible('#seat2 .you');
    assert(!(await B.visible('#seat1 .you')), 'B is not on Rot');
    await A.waitText('#seat2 .seat-name-text', 'Cedrik');
    await A.waitText('#status-text', 'Du bist dran!');
    eq(await A.eval('document.title'), 'Du bist dran! · Glubschi gewinnt', 'A title once the opponent sits');
    await B.waitText('#status-text', 'Ben ist dran');
    await A.waitFor('A invite small', '!document.querySelector("#invite").classList.contains("is-big")');
    return 'both see Ben (Rot) and Cedrik (Gelb)';
  });

  await scenario(3, 'Alternate moves until A wins; boards identical; win, score, confetti once', async () => {
    await A.resetSfx(); await B.resetSfx();
    const seq = [[A, 1, 0], [B, 2, 1], [A, 1, 0], [B, 2, 1], [A, 1, 0], [B, 2, 1], [A, 1, 0]];
    let n = 0;
    for (const [mover, p, col] of seq) {
      const other = mover === A ? B : A;
      await mover.waitText('#status-text', 'Du bist dran!');
      if (n === 6) { await A.eval('scrollTo(0, 0), true'); await B.eval('scrollTo(0, 0), true'); } // like a phone user at the top of the page
      await mover.click('#board .col', { index: col });
      dropInto(want, col, p);
      n++;
      await waitBoards([A, B], want, 'after move ' + n);
      await sleep(500); // drop + land sounds
      for (const pg of [A, B]) {
        const s = await pg.sfx();
        eq(count(s, 'drop'), n, pg.label + ' drop sounds after move ' + n + ' ' + JSON.stringify(s));
        eq(count(s, 'land'), n, pg.label + ' land sounds after move ' + n);
      }
      if (n === 4) { await A.shot('04-midgame-A'); await B.shot('05-midgame-B'); }
      void other;
    }
    await A.waitText('#status-text', 'Du gewinnst!');
    await B.waitText('#status-text', 'Ben gewinnt!');
    for (const pg of [A, B]) await pg.waitFor(pg.label + ' Nochmal! scrolled into view', '(() => { const r = document.querySelector("#again").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()', 4000);
    await A.shot('06-win-A', { keepScroll: true });
    await B.shot('07-win-B', { keepScroll: true });
    for (const pg of [A, B]) {
      await pg.waitFor(pg.label + ' win sound', '(window.__sfx || []).includes("win")', 3000);
      await sleep(300);
      const s = await pg.sfx();
      eq(count(s, 'win'), 1, pg.label + ' exactly one win sound');
      eq(count(s, 'drop'), 7, pg.label + ' 7 drop sounds');
      eq(await pg.text('#seat1 .seat-score b'), '1', pg.label + ' Rot score');
      eq(await pg.text('#seat2 .seat-score b'), '0', pg.label + ' Gelb score');
      eq(await pg.eval('document.querySelectorAll("#board .chip.win").length'), 4, pg.label + ' 4 winning chips');
      assert(await pg.eval('document.querySelector("#confetti").width === Math.round(innerWidth * devicePixelRatio)'), pg.label + ' confetti burst');
      assert(await pg.visible('#again'), pg.label + ' Nochmal! visible');
    }
    return '7 moves, 7 drop/land sounds and 1 win sound per player, score 1:0, confetti on both';
  });

  await scenario(4, 'Taunt from B shows on A; rematch, the other player starts', async () => {
    await A.resetSfx(); await B.resetSfx();
    await B.waitVisible('#taunts');
    await B.clickText('#taunts .btn--taunt', 'Hehe.');
    await B.waitVisible('#seat2 .bubble');
    await A.waitVisible('#seat2 .bubble', 5000);
    eq(await A.text('#seat2 .bubble'), 'Hehe.', 'bubble text on A');
    await sleep(200);
    eq(count(await A.sfx(), 'taunt'), 1, 'A taunt sound once');
    eq(count(await B.sfx(), 'taunt'), 1, 'B taunt sound once');
    await A.click('#again');
    want.fill(0);
    await waitBoards([A, B], want, 'after rematch');
    await B.waitText('#status-text', 'Du bist dran!');
    await A.waitText('#status-text', 'Cedrik ist dran');
    for (const pg of [A, B]) {
      eq(await pg.text('#meta'), 'Runde 2 · Zug 0 von 42', pg.label + ' round 2');
      assert(!(await pg.visible('#again')), pg.label + ' Nochmal! hidden');
      await sleep(100);
      eq(count(await pg.sfx(), 'flush'), 1, pg.label + ' one flush sound');
    }
    return 'bubble "Hehe." on A, round 2 starts with Gelb';
  });

  await scenario(5, 'B reloads mid-game: restored from history, still Gelb, no replays', async () => {
    await B.click('#board .col', { index: 3 }); dropInto(want, 3, 2);
    await waitBoards([A, B], want, 'B col 4');
    await A.waitText('#status-text', 'Du bist dran!');
    await A.click('#board .col', { index: 4 }); dropInto(want, 4, 1);
    await waitBoards([A, B], want, 'A col 5');
    await sleep(300);
    await B.reload();
    await B.waitFor('B restored', `document.querySelector("#status-text").textContent === "Du bist dran!"`, 10000);
    await waitBoards([B], want, 'after reload');
    assert(await B.visible('#seat2 .you'), 'B still Gelb');
    assert(!(await B.visible('#name-step')), 'no name step after reload');
    eq(await B.eval('document.querySelectorAll("#board .chip.drop, #board .chip.flush").length'), 0, 'no drop/flush animation after reload');
    await sleep(5500); // past the 4 s catch-up poll
    const s = await B.sfx();
    eq(s.filter((x) => ['drop', 'land', 'win', 'flush', 'seat', 'draw', 'taunt'].includes(x)), [], 'no replayed sounds after reload');
    eq(await B.eval('document.querySelectorAll("#board .chip.drop").length'), 0, 'still no drop animation');
    eq(await B.text('#meta'), 'Runde 2 · Zug 2 von 42', 'meta after reload');
    eq(await B.text('#seat1 .seat-seen'), 'gerade da', 'B sees A as present after the reload');
    // play on after the reload
    await A.resetSfx();
    await B.click('#board .col', { index: 3 }); dropInto(want, 3, 2);
    await waitBoards([A, B], want, 'B moves after reload');
    await sleep(500);
    eq(count(await A.sfx(), 'drop'), 1, 'A hears the move once');
    return 'board, seat and turn restored, 0 sounds on reload, play continues';
  });

  await scenario(6, 'New profile with the same name (like the iPhone app next to Safari) gets its seat back with one tap', async () => {
    const bChrome = chromes.find((c) => c.label === 'B');
    await bChrome.kill();
    B = null;
    C = await launch('C');
    await C.goto(START);
    await C.waitVisible('#start');
    await C.type('#name', 'Cedrik');
    const formatted = await A.text('#code-big');
    await C.type('#join-code', formatted);
    await C.click('#join-form button[type=submit]');
    await C.waitFor('C in room', `new URLSearchParams(location.search).get("raum") === ${JSON.stringify(code)}`);
    const joinedAt = Date.now();
    await C.waitText('#quip', 'Bist du das? Tipp bei deinem Platz auf „Das bin ich“.', 10000);
    await waitBoards([C], want, 'C sees the game');
    assert(!(await C.visible('#name-step')), 'no name step (name typed on start screen)');
    assert(!(await C.visible('#sit1')) && !(await C.visible('#sit2')), 'no free seat');
    await C.waitVisible('#take2', 5000);
    const waited = Date.now() - joinedAt;
    assert(waited < 10000, 'own seat offered without the 15 s grace (' + waited + ' ms)');
    eq(await C.text('#take2'), 'Das bin ich: Platz übernehmen', 'take-over text for the own name');
    await C.shot('10-self-seat-C');
    await C.waitFor('C sees A as present', 'document.querySelector("#seat1 .seat-seen").textContent === "gerade da"', 10000);
    assert(!(await C.visible('#take1')), 'Rot (A, online) must not be offered for take-over');
    await C.click('#take2');
    await C.waitVisible('#seat2 .you');
    await C.waitText('#status-text', 'Ben ist dran');
    await A.waitText('#status-text', 'Du bist dran!');
    await waitBoards([A, C], want, 'after take-over');
    await A.click('#board .col', { index: 4 }); dropInto(want, 4, 1);
    await waitBoards([A, C], want, 'A after take-over');
    await C.waitText('#status-text', 'Du bist dran!');
    await C.click('#board .col', { index: 2 }); dropInto(want, 2, 2);
    await waitBoards([A, C], want, 'C moves');
    return 'own seat offered after ' + waited + ' ms, one tap, game continues';
  });

  await scenario(9, 'Back to start, recent rooms list, browser back/forward', async () => {
    await A.click('#back');
    await A.waitVisible('#start');
    await A.waitVisible('#recent');
    const fc = await A.text('#code-big');
    const items = await A.eval('[...document.querySelectorAll("#recent-list .recent-item")].map((b) => b.textContent)');
    assert(items.length === 1 && items[0].includes(fc) && items[0].includes('Gegen Cedrik'), 'recent list: ' + JSON.stringify(items));
    await A.shot('08-start-recent');
    eq(await A.eval('location.search'), '?ntfy=' + encodeURIComponent(NTFY), 'start URL keeps only the test server');
    // "Start" went back in history instead of stacking a new entry, so forward returns to the room
    await A.eval('history.forward(), true');
    await A.waitVisible('#game');
    await A.waitFor('A back in room', `new URLSearchParams(location.search).get("raum") === ${JSON.stringify(code)} && document.querySelector("#conn").dataset.s === "live"`);
    await waitBoards([A], want, 'after browser forward');
    await A.waitText('#status-text', 'Du bist dran!');
    await A.eval('history.back(), true');
    await A.waitVisible('#start');
    await A.click('#recent-list .recent-item');
    await A.waitVisible('#game');
    await waitBoards([A], want, 'after recent item');
    await A.waitText('#status-text', 'Du bist dran!');
    return 'recent shows ' + fc + ' "Gegen Cedrik", back/forward/recent all work';
  });

  await scenario(7, 'Local hot-seat game without any network request', async () => {
    await A.click('#back');
    await A.waitVisible('#start');
    await sleep(300);
    const fakeBefore = fake.log().length;
    const reqBefore = A.requests.length;
    await A.resetSfx();
    await A.click('#local-btn');
    await A.waitVisible('#game');
    eq(await A.eval('location.hash'), '#lokal', 'hash');
    assert(!(await A.visible('#conn')), 'no connection pill');
    assert(!(await A.visible('#invite')), 'no invite');
    const loc = emptyBoard();
    const moves = [0, 1, 0, 1, 0, 1, 0];
    for (let i = 0; i < moves.length; i++) {
      await A.click('#board .col', { index: moves[i] });
      dropInto(loc, moves[i], i % 2 ? 2 : 1);
      await waitBoards([A], loc, 'local move ' + (i + 1));
      await sleep(120);
    }
    await A.waitText('#status-text', 'Rot gewinnt!');
    await sleep(800);
    eq(count(await A.sfx(), 'win'), 1, 'local win sound once');
    await A.click('#again');
    await waitBoards([A], emptyBoard(), 'local rematch');
    await A.waitText('#status-text', 'Gelb ist dran');
    await sleep(500);
    const reqs = A.requests.slice(reqBefore).filter((r) => !r.url.startsWith('data:'));
    eq(reqs.map((r) => r.method + ' ' + r.url), [], 'network requests during the local game');
    eq(fake.log().length - fakeBefore, 0, 'requests to the fake ntfy');
    return '7 moves, Rot wins, rematch, 0 network requests';
  });

  await scenario(8, 'One 429 from the server: waiting state, then recovery', async () => {
    await A.click('#back');
    await A.waitVisible('#start');
    eq(await A.eval('(() => { const c = document.querySelector("#confetti"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return false; return true; })()'), true, 'no confetti left on the start screen');
    await A.click('#recent-list .recent-item');
    await A.waitFor('A live', 'document.querySelector("#conn").dataset.s === "live"');
    await waitBoards([A], want, 'A back online');
    await A.waitText('#status-text', 'Du bist dran!');
    A.allowed.push(/status of 429/);
    await fetch(NTFY + '/__ctl/fail?status=429&code=42901&count=1&method=POST', { method: 'POST' });
    await A.click('#board .col', { index: 6 }); dropInto(want, 6, 1);
    await A.waitFor('A waiting state', 'document.querySelector("#conn").dataset.s === "ratelimited"', 5000);
    eq(await A.text('#conn-text'), 'kurz warten…', 'waiting text');
    await A.shot('09-ratelimited-A');
    await A.waitFor('A recovered', 'document.querySelector("#conn").dataset.s === "live"', 15000);
    await waitBoards([A, C], want, 'move after 429');
    await C.waitText('#status-text', 'Du bist dran!');
    const injected = fake.log().filter((e) => e.injected === 429).length;
    eq(injected, 1, 'exactly one injected 429');
    A.allowed.pop();
    // bonus: the server drops every stream, the next move still arrives
    for (const pg of [A, C]) pg.allowed.push(/net::ERR_|EventSource|status of 4/);
    await fetch(NTFY + '/__ctl/drop', { method: 'POST' });
    await sleep(300);
    await C.click('#board .col', { index: 6 }); dropInto(want, 6, 2);
    await waitBoards([A, C], want, 'move after dropped streams');
    await A.waitFor('A live again', 'document.querySelector("#conn").dataset.s === "live"', 15000);
    for (const pg of [A, C]) pg.allowed.pop();
    return 'conn "kurz warten…", move delivered after the wait, streams survive a drop';
  });

  await scenario(10, 'Daily quota (42908): moves and taunts blocked, "Neu verbinden" recovers', async () => {
    await A.waitText('#status-text', 'Du bist dran!');
    await sleep(2000); // let the last taunt/ping throttles of scenario 8 pass
    A.allowed.push(/status of 429/);
    await fetch(NTFY + '/__ctl/fail?status=429&code=42908&count=1&method=POST', { method: 'POST' });
    await A.click('#board .col', { index: 5 });
    await A.waitFor('A quota', 'document.querySelector("#conn").dataset.s === "quota"', 5000);
    await waitBoards([A], want, 'quota move reverted');
    eq(await A.text('#conn-text'), 'Tageslimit voll', 'quota pill');
    await A.waitVisible('#reconnect');
    assert((await A.text('#notice-text')).includes('Neu verbinden'), 'notice tells you to tap Neu verbinden');
    await A.shot('11-quota-A');
    const postsBefore = fake.log().filter((e) => e.method === 'POST').length;
    await A.resetSfx();
    await A.click('#board .col', { index: 5 });
    await A.clickText('#taunts .btn--taunt', 'Hehe.');
    await sleep(600);
    await waitBoards([A], want, 'no move while quota');
    assert(!(await A.visible('#seat1 .bubble')), 'no taunt bubble while quota (it would never arrive)');
    eq(count(await A.sfx(), 'nope'), 2, 'move and taunt both rejected with the nope sound');
    eq(fake.log().filter((e) => e.method === 'POST').length, postsBefore, 'no POST while quota');
    await A.click('#reconnect');
    await A.waitFor('A live after Neu verbinden', 'document.querySelector("#conn").dataset.s === "live"', 10000);
    await A.waitHidden('#notice');
    await A.waitText('#status-text', 'Du bist dran!');
    assert(await A.visible('#seat1 .you'), 'A still Rot after the reconnect');
    await A.click('#board .col', { index: 5 }); dropInto(want, 5, 1);
    await waitBoards([A, C], want, 'move after Neu verbinden');
    A.allowed.pop();
    return 'quota blocks moves and taunts without POSTs, one tap on "Neu verbinden" and the move arrives';
  });

  await scenario(11, 'Layouts: whole board visible on phones, seat cards intact up to 900 px', async () => {
    const notes = [];
    let touch = true;
    try { await A.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }); } catch (e) { touch = false; }
    touch = touch && await A.eval('matchMedia("(hover: none)").matches');
    assert(touch, 'touch emulation (hover: none) works');
    // a long but common name on the opponent's card (display only, repainted later)
    const longName = 'document.querySelector("#seat2 .seat-name-text").textContent = "Maximilian", true';
    const measure = `(() => {
      const b = document.querySelector('#board').getBoundingClientRect();
      const bad = [];
      for (const id of ['#seat1', '#seat2']) {
        const s = document.querySelector(id).getBoundingClientRect();
        for (const el of document.querySelectorAll(id + ' > *')) {
          const r = el.getBoundingClientRect();
          if (!r.width || el.classList.contains('sticker') || el.classList.contains('bubble')) continue;
          if (r.left < s.left - 1 || r.right > s.right + 1) bad.push(id + ' ' + el.className + ' ' + Math.round(r.left) + '-' + Math.round(r.right) + ' outside ' + Math.round(s.left) + '-' + Math.round(s.right));
        }
      }
      const n = document.querySelector('#seat2 .seat-name-text');
      const lh = parseFloat(getComputedStyle(n).lineHeight) || 20;
      return { boardBottom: Math.round(b.bottom), ih: innerHeight, sw: document.documentElement.scrollWidth, iw: innerWidth, bad, nameLines: Math.round(n.getBoundingClientRect().height / lh), nameW: Math.round(n.getBoundingClientRect().width), nameBox: Math.round(n.parentNode.getBoundingClientRect().width) };
    })()`;
    for (const [w, h] of [[390, 664], [360, 640], [390, 844]]) {
      await A.cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
      await sleep(400);
      await A.eval('scrollTo(0, 0), ' + longName);
      await sleep(150);
      const m = await A.eval(measure);
      notes.push(w + 'x' + h + ' board bottom ' + m.boardBottom + '/' + m.ih + ', name lines ' + m.nameLines + ' (' + m.nameW + '/' + m.nameBox + ' px)');
      await A.shot('12-phone-' + w + 'x' + h, { keepScroll: true });
      assert(m.boardBottom <= m.ih, w + 'x' + h + ': board bottom ' + m.boardBottom + ' below the viewport ' + m.ih);
      assert(m.sw <= m.iw, w + 'x' + h + ': horizontal scroll ' + m.sw);
      eq(m.bad, [], w + 'x' + h + ': seat card contents inside the card');
      eq(m.nameLines, 1, w + 'x' + h + ': "Maximilian" on one line');
    }
    await A.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    for (const w of [768, 820, 860, 900, 901, 1000]) {
      await A.cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 1000, deviceScaleFactor: 1, mobile: false });
      await sleep(400);
      await A.eval('scrollTo(0, 0), ' + longName);
      await sleep(150);
      const m = await A.eval(measure);
      if (w === 820 || w === 1000) await A.shot('13-wide-' + w, { keepScroll: true });
      assert(m.sw <= m.iw, w + ': horizontal scroll ' + m.sw);
      eq(m.bad, [], w + ': seat card contents inside the card');
      notes.push(w + ' ok');
    }
    await A.cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    return notes.join(', ');
  });

  // budget: posts per client
  const posts = fake.log().filter((e) => e.method === 'POST');
  log('fake ntfy: ' + fake.log().length + ' requests, ' + posts.length + ' POSTs (' + posts.filter((e) => !e.cached).length + ' uncached)');
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error(e.stack || e.message);
  for (const p of pages()) {
    try { await p.shot('fail-' + p.label); } catch (x) { /* ignore */ }
    console.error('--- ' + p.label + ' console (last 30):\n  ' + p.consoleLines.slice(-30).join('\n  '));
  }
} finally {
  await cleanup();
}
const real = realNtfy.length;
console.log('\nRESULTS');
for (const r of results) console.log('  ' + r.result.toUpperCase().padEnd(5) + r.name + (r.notes ? '  (' + r.notes.split('\n')[0] + ')' : ''));
console.log('real ntfy.sh requests: ' + real);
console.log('screenshots: ' + shots.join(', '));
fs.mkdirSync(SHOTS, { recursive: true });
fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify({ results, real, shots }, null, 2));
process.exit(failed || real ? 1 : 0);
