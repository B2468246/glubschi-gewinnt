'use strict';
// Unit tests for relay.js. No network: in-memory fake ntfy + fake timers.
// Run: node test/unit.test.js
const assert = require('node:assert/strict');
const path = require('node:path');
const G = require(path.join(__dirname, '..', 'relay.js'));

// ------------------------------------------------------------------ runner
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ------------------------------------------------------------- fake clock
function makeClock() {
  let t = 1700000000000;
  let timers = [];
  let idc = 0;
  const clock = {
    now: () => t,
    setTimeout(fn, ms) { const id = ++idc; timers.push({ id, at: t + Math.max(0, ms || 0), fn }); return id; },
    clearTimeout(id) { timers = timers.filter((x) => x.id !== id); },
    pending: () => timers.length,
    async advance(ms) {
      const end = t + ms;
      await flush();
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const nx = timers[0];
        if (!nx || nx.at > end) break;
        timers.shift();
        t = nx.at;
        nx.fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
  return clock;
}
async function flush() {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

// -------------------------------------------------------------- fake ntfy
function resp(status, text) {
  return { status, ok: status >= 200 && status < 300, text: async () => text, json: async () => JSON.parse(text) };
}

class FakeNtfy {
  constructor(clock) {
    this.clock = clock;
    this.cached = [];
    this.nextId = 1;
    this.streams = new Set();
    this.requests = [];
    this.esOpens = [];
    this.force429 = 0;       // number of upcoming HTTP requests answered with 429
    this.always429 = false;
    this.networkDown = false;
    this.refuseSSE = false;
    this.duplicateDelivery = false;
    this.quota = false;      // daily message quota used up: POST -> 429 code 42908 (true, or a predicate on the body = per IP)
    const srv = this;
    this.fetch = (url, init) => srv._fetch(url, init);
    this.EventSource = class FakeEventSource {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.onopen = this.onmessage = this.onerror = null;
        this._listeners = {};
        const u = new URL(url);
        this.topic = u.pathname.split('/')[1];
        this.since = u.searchParams.get('since') || 'all';
        srv.esOpens.push(url);
        this._queue = [];
        const open = () => {
          if (this.readyState === 2) return;
          if (srv.refuseSSE || srv.networkDown || srv.always429) { this.readyState = 2; if (this.onerror) this.onerror({}); return; }
          // replay + subscribe atomically, so nothing published in between is lost
          const replay = srv._since(this.topic, this.since);
          srv.streams.add(this);
          this.readyState = 1;
          if (this.onopen) this.onopen({});
          // like ntfy: a named "open" event (also dispatched to onopen) with the server time
          if (this.onopen) this.onopen({ data: JSON.stringify({ id: 'open' + srv.nextId, time: Math.floor(srv.clock.now() / 1000), event: 'open', topic: this.topic }) });
          for (const m of replay) this._deliver(m);
        };
        if (srv.openDelayMs) srv.clock.setTimeout(open, srv.openDelayMs); else queueMicrotask(open); // openDelayMs: slow network
      }
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
      _deliver(m) {
        queueMicrotask(() => {
          if (this.readyState !== 1) return;
          if (this.onmessage) this.onmessage({ data: JSON.stringify(m) });
          if (srv.duplicateDelivery && this.onmessage) this.onmessage({ data: JSON.stringify(m) });
        });
      }
      _raw(data) { if (this.readyState === 1 && this.onmessage) this.onmessage({ data }); }
      _keepalive() { (this._listeners.keepalive || []).forEach((f) => f({ data: '{}' })); }
      _drop() { srv.streams.delete(this); this.readyState = 0; if (this.onerror) this.onerror({}); }
      close() { this.readyState = 2; srv.streams.delete(this); }
    };
  }
  _id() { return 'id' + String(this.nextId++).padStart(10, '0'); }
  publish(topic, body, cache = true) {
    const time = Math.floor(this.clock.now() / 1000);
    const m = { id: this._id(), time, event: 'message', topic, message: body };
    if (cache) { m.expires = time + 43200; this.cached.push(m); }
    for (const s of [...this.streams]) if (s.topic === topic) s._deliver(m);
    return m;
  }
  _since(topic, since) {
    const list = this.cached.filter((m) => m.topic === topic);
    if (since === 'all') return list;
    const i = list.findIndex((m) => m.id === since);
    return i < 0 ? list : list.slice(i + 1);
  }
  async _fetch(url, init = {}) {
    const method = init.method || 'GET';
    this.requests.push({ method, url, at: this.clock.now(), body: init.body ? String(init.body) : '' });
    await null;
    if (this.networkDown) throw new TypeError('fetch failed');
    if (this.always429) return resp(429, '{"code":42901,"error":"limit reached"}');
    if (this.force429 > 0) { this.force429--; return resp(429, '{"code":42901}'); }
    if (this.quota && method === 'POST' && (this.quota === true || this.quota(String(init.body)))) return resp(429, '{"code":42908,"http":429,"error":"limit reached: daily message quota reached"}');
    const u = new URL(url);
    const topic = u.pathname.split('/')[1];
    if (method === 'POST') {
      const cache = u.searchParams.get('cache') !== 'no';
      const m = this.publish(topic, String(init.body), cache);
      return resp(200, JSON.stringify(m));
    }
    if (u.pathname.endsWith('/json') && u.searchParams.get('poll') === '1') {
      const list = this._since(topic, u.searchParams.get('since') || 'all');
      return resp(200, list.map((m) => JSON.stringify(m)).join('\n') + (list.length ? '\n' : ''));
    }
    return resp(404, '');
  }
  dropAll() { for (const s of [...this.streams]) s._drop(); }
  posts() { return this.requests.filter((r) => r.method === 'POST'); }
  statePosts() { return this.posts().filter((r) => r.body.includes('"k":"s"')); }
}

function memStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

function makeClient(srv, clock, code, clientId, extra = {}) {
  const log = { states: [], taunts: [], presence: [], status: [] };
  const room = G.joinRoom({
    code, clientId,
    onState: (s, meta) => log.states.push({ s, meta }),
    onTaunt: (t) => log.taunts.push(t),
    onPresence: (p) => log.presence.push(p),
    onStatus: (st) => log.status.push(st),
    options: Object.assign({
      fetch: srv.fetch, EventSource: srv.EventSource, storage: memStorage(), now: clock.now,
      timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
      document: null, window: null, random: () => 0.5, pingMs: 25000,
    }, extra),
  });
  return { room, log };
}

// --------------------------------------------------------- state builders
function stateFrom(moves, starter = 1) {
  let s = G.blankState();
  if (starter === 2) { s.starter = 2; s.turn = 2; }
  for (const c of moves) {
    const n = G.applyMove(s, c);
    assert.ok(n, 'move ' + c + ' should be legal');
    s = n;
  }
  return s;
}
const idx = (r, c) => r * 7 + c;

// ==================================================================== TESTS
test('room codes: new, normalize, format, url', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = G.newRoomCode();
    assert.match(c, /^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/);
    seen.add(c);
  }
  assert.equal(seen.size, 200);
  assert.equal(G.normalizeRoomCode('K7MP-2QXA-9D'), 'k7mp2qxa9d');
  assert.equal(G.normalizeRoomCode('  k7mp 2qxa 9d '), 'k7mp2qxa9d');
  assert.equal(G.normalizeRoomCode('Spiel mit mir! https://b2468246.github.io/glubschi-gewinnt/?raum=k7mp2qxa9d&x=1'), 'k7mp2qxa9d');
  assert.equal(G.normalizeRoomCode('https://x.y/?a=b&raum=K7MP-2QXA-9D#top'), 'k7mp2qxa9d');
  assert.equal(G.normalizeRoomCode('k7mp2qxa9'), null);       // too short
  assert.equal(G.normalizeRoomCode('k7mp2qxa9o'), null);      // o not in alphabet
  assert.equal(G.normalizeRoomCode('k7mp2qxa9d1'), null);
  assert.equal(G.normalizeRoomCode(null), null);
  assert.equal(G.normalizeRoomCode({}), null);
  assert.equal(G.formatRoomCode('k7mp2qxa9d'), 'K7MP-2QXA-9D');
  assert.equal(G.roomUrl('k7mp2qxa9d'), 'https://b2468246.github.io/glubschi-gewinnt/?raum=k7mp2qxa9d');
  const old = G.config.base;
  G.config.base = 'http://localhost:8080/';
  assert.equal(G.roomUrl('k7mp2qxa9d'), 'http://localhost:8080/?raum=k7mp2qxa9d');
  G.config.base = old;
});

test('blankState shape', () => {
  const b = G.blankState();
  assert.deepEqual(b, {
    v: 1, seq: 0, board: new Array(42).fill(0), turn: 1, starter: 1, winner: 0, winLine: [], last: -1,
    round: 1, players: { '1': null, '2': null }, score: { '1': 0, '2': 0 },
  });
  assert.deepEqual(G.sanitizeState(b), b);
});

test('sanitizeState accepts valid states and returns copies', () => {
  const s = stateFrom([3, 3, 4]);
  s.players['1'] = { id: 'alice_1', name: 'Alice' };
  const out = G.sanitizeState(Object.assign({ extra: 'x', __proto__: { evil: 1 } }, s));
  assert.ok(out);
  assert.equal(out.extra, undefined);
  assert.notEqual(out.board, s.board);
  assert.deepEqual(out.board, s.board);
});

test('sanitizeState rejects wrong types', () => {
  const ok = stateFrom([0, 1]);
  const bad = (patch) => G.sanitizeState(Object.assign(JSON.parse(JSON.stringify(ok)), patch));
  assert.equal(G.sanitizeState(null), null);
  assert.equal(G.sanitizeState('x'), null);
  assert.equal(G.sanitizeState([]), null);
  assert.equal(bad({ v: 2 }), null);
  assert.equal(bad({ seq: '3' }), null);
  assert.equal(bad({ seq: -1 }), null);
  assert.equal(bad({ seq: 1.5 }), null);
  assert.equal(bad({ seq: Infinity }), null);
  assert.equal(bad({ board: ok.board.slice(0, 41) }), null);
  assert.equal(bad({ board: ok.board.map((v, i) => (i === 41 ? 3 : v)) }), null);
  assert.equal(bad({ board: ok.board.map((v, i) => (i === 35 && v ? '1' : v)) }), null);
  assert.equal(bad({ turn: 3 }), null);
  assert.equal(bad({ starter: 0 }), null);
  assert.equal(bad({ winner: 4 }), null);
  assert.equal(bad({ winLine: 'x' }), null);
  assert.equal(bad({ round: 0 }), null);
  assert.equal(bad({ players: null }), null);
  assert.equal(bad({ players: { '1': { id: 'a', name: 5 }, '2': null } }), null);
  assert.equal(bad({ players: { '1': 'alice', '2': null } }), null);
  assert.equal(bad({ score: { '1': -1, '2': 0 } }), null);
  assert.equal(bad({ score: { '1': '1', '2': 0 } }), null);
  assert.equal(bad({ last: 42 }), null);
});

test('sanitizeState rejects floating chips', () => {
  const s = G.blankState();
  s.board[idx(4, 2)] = 1; // row 4, nothing below at row 5
  s.turn = 2; s.last = idx(4, 2);
  assert.equal(G.sanitizeState(s), null);
  s.board[idx(5, 2)] = 2; s.board[idx(5, 3)] = 1; s.turn = 2; s.last = idx(4, 2);
  // now 2 red, 1 yellow, red starter -> yellow's turn: valid stack
  assert.ok(G.sanitizeState(s));
});

test('sanitizeState rejects bad piece counts and turn', () => {
  const s = G.blankState();
  s.board[idx(5, 0)] = 1; s.board[idx(5, 1)] = 1; s.last = idx(5, 1); s.turn = 2;
  assert.equal(G.sanitizeState(s), null); // 2 red, 0 yellow
  const t = stateFrom([0, 1]);
  t.turn = 2; // should be 1
  assert.equal(G.sanitizeState(t), null);
  const u = stateFrom([0]);
  u.starter = 2; // yellow started, but only a red chip exists
  assert.equal(G.sanitizeState(u), null);
  const w = stateFrom([0]);
  w.last = -1;
  assert.equal(G.sanitizeState(w), null);
  const x = stateFrom([0, 0]);
  x.last = idx(5, 0); // not the top chip of its column
  assert.equal(G.sanitizeState(x), null);
});

test('sanitizeState rejects fake winners and recomputes winLine', () => {
  const s = stateFrom([0, 1, 0]);
  s.winner = 1; s.winLine = [0, 7, 14, 21];
  assert.equal(G.sanitizeState(s), null);
  const d = stateFrom([0, 1]);
  d.winner = 3;
  assert.equal(G.sanitizeState(d), null); // draw with empty cells
  const w = stateFrom([0, 1, 0, 1, 0, 1, 0]); // red vertical win
  assert.equal(w.winner, 1);
  const fake = JSON.parse(JSON.stringify(w));
  fake.winner = 0; fake.winLine = [];
  assert.equal(G.sanitizeState(fake), null); // line on board but no winner
  const wrong = JSON.parse(JSON.stringify(w));
  wrong.winner = 2;
  assert.equal(G.sanitizeState(wrong), null);
  const lying = JSON.parse(JSON.stringify(w));
  lying.winLine = [1, 2, 3, 4];
  assert.deepEqual(G.sanitizeState(lying).winLine, w.winLine);
});

test('sanitizeState names and ids', () => {
  const s = stateFrom([]);
  const RLO = String.fromCharCode(0x202e);
  const NUL = String.fromCharCode(0);
  const ZW = String.fromCharCode(0x200b);
  s.players['1'] = { id: 'abc-DEF_123', name: '  Bo' + RLO + 'b' + NUL + ZW + '  der  Große  ' };
  s.players['2'] = { id: 'x', name: 'A'.repeat(25) };
  const out = G.sanitizeState(s);
  assert.equal(out.players['1'].name, 'Bob der Große');
  assert.equal(out.players['2'].name, 'A'.repeat(20));
  const big = JSON.parse(JSON.stringify(s));
  big.players['2'].name = 'A'.repeat(5000);
  assert.equal(G.sanitizeState(big), null);
  const badId = JSON.parse(JSON.stringify(s));
  badId.players['1'].id = 'has space';
  assert.equal(G.sanitizeState(badId), null);
  badId.players['1'].id = 'x'.repeat(65);
  assert.equal(G.sanitizeState(badId), null);
  badId.players['1'].id = '';
  assert.equal(G.sanitizeState(badId), null);
  const emoji = JSON.parse(JSON.stringify(s));
  emoji.players['1'].name = '😀'.repeat(30);
  assert.equal(Array.from(G.sanitizeState(emoji).players['1'].name).length, 20);
});

test('applyMove: horizontal, vertical, both diagonals, 5-long line', () => {
  // horizontal bottom row: red 0,1,2,3 ; yellow on top
  let s = stateFrom([0, 0, 1, 1, 2, 2, 3]);
  assert.equal(s.winner, 1);
  assert.deepEqual(s.winLine, [idx(5, 0), idx(5, 1), idx(5, 2), idx(5, 3)]);
  assert.equal(s.score['1'], 1);
  assert.equal(s.turn, 2);
  assert.equal(s.last, idx(5, 3));
  assert.equal(G.applyMove(s, 4), null); // game over
  assert.ok(G.sanitizeState(s));
  // vertical
  s = stateFrom([6, 5, 6, 5, 6, 5, 6]);
  assert.equal(s.winner, 1);
  assert.deepEqual(s.winLine, [idx(2, 6), idx(3, 6), idx(4, 6), idx(5, 6)]);
  // diagonal "/" for red: (5,0) (4,1) (3,2) (2,3)
  s = stateFrom([0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3]);
  assert.equal(s.winner, 1);
  assert.deepEqual(s.winLine, [idx(2, 3), idx(3, 2), idx(4, 1), idx(5, 0)]);
  // diagonal "\" for yellow: (2,0) (3,1) (4,2) (5,3)
  s = stateFrom([3, 2, 2, 1, 1, 0, 1, 0, 0, 6, 0], 2);
  assert.equal(s.winner, 2);
  assert.equal(s.score['2'], 1);
  assert.deepEqual(s.winLine, [idx(2, 0), idx(3, 1), idx(4, 2), idx(5, 3)]);
  assert.ok(G.sanitizeState(s));
  // 5-long: red 0,1,3,4 then 2 fills the gap
  s = stateFrom([0, 0, 1, 1, 3, 3, 4, 4, 2]);
  assert.equal(s.winner, 1);
  assert.deepEqual(s.winLine, [35, 36, 37, 38, 39]);
  // illegal moves
  assert.equal(G.applyMove(G.blankState(), 7), null);
  assert.equal(G.applyMove(G.blankState(), -1), null);
  assert.equal(G.applyMove(G.blankState(), 1.5), null);
  const full = stateFrom([0, 0, 0, 0, 0, 0]);
  assert.equal(G.applyMove(full, 0), null);
  // purity
  const before = JSON.stringify(full);
  G.applyMove(full, 1);
  assert.equal(JSON.stringify(full), before);
});

test('applyMove: draw', () => {
  // seeded search for a full board without four in a row
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
  let draw = null;
  for (let attempt = 0; attempt < 5000 && !draw; attempt++) {
    let s = G.blankState();
    for (;;) {
      const options = [];
      for (let c = 0; c < 7; c++) {
        const n = G.applyMove(s, c);
        if (n && n.winner === 0 || n && n.winner === 3) options.push(n);
      }
      if (!options.length) break;
      s = options[Math.floor(rand() * options.length)];
      if (s.winner === 3) { draw = s; break; }
    }
  }
  assert.ok(draw, 'found a draw');
  assert.equal(draw.winner, 3);
  assert.deepEqual(draw.winLine, []);
  assert.equal(draw.seq, 42);
  assert.deepEqual(draw.score, { '1': 0, '2': 0 });
  assert.ok(G.sanitizeState(draw));
});

test('rematch, withSeat, withoutSeat, resetAll', () => {
  let s = stateFrom([0, 1, 0, 1, 0, 1, 0]);
  s = G.withSeat(s, 1, { id: 'alice', name: 'Alice' });
  s = G.withSeat(s, '2', { id: 'bob', name: 'Bob' });
  assert.equal(s.seq, 9);
  const r = G.rematch(s);
  assert.equal(r.seq, 10);
  assert.equal(r.round, 2);
  assert.equal(r.starter, 2);
  assert.equal(r.turn, 2);
  assert.equal(r.winner, 0);
  assert.equal(r.last, -1);
  assert.deepEqual(r.board, new Array(42).fill(0));
  assert.deepEqual(r.score, { '1': 1, '2': 0 });
  assert.equal(r.players['2'].name, 'Bob');
  assert.ok(G.sanitizeState(r));
  const w = G.withoutSeat(r, 2);
  assert.equal(w.players['2'], null);
  assert.equal(w.seq, 11);
  assert.equal(G.withSeat(r, 3, { id: 'x', name: 'y' }), null);
  assert.equal(G.withSeat(r, 1, { id: 'bad id', name: 'y' }), null);
  const z = G.resetAll(w);
  assert.equal(z.seq, 12);
  assert.deepEqual(z.score, { '1': 0, '2': 0 });
  assert.equal(z.players['1'], null);
});

// ------------------------------------------------------------- room tests
async function setupPair(code) {
  const clock = makeClock();
  const srv = new FakeNtfy(clock);
  code = code || G.newRoomCode();
  const A = makeClient(srv, clock, code, 'alice');
  await clock.advance(10);
  const B = makeClient(srv, clock, code, 'bob');
  await clock.advance(10);
  return { clock, srv, A, B, code };
}

test('join: loading -> history -> live; echo confirmation', async () => {
  const { clock, srv, A, B } = await setupPair();
  assert.deepEqual(A.log.status, ['loading', 'live']);
  assert.equal(A.log.states[0].meta.source, 'history');
  assert.equal(A.log.states[0].s.seq, 0);
  assert.ok(srv.esOpens[0].endsWith('/sse?since=all'));
  const s1 = G.withSeat(A.room.state, 1, { id: 'alice', name: 'Alice' });
  const p = A.room.propose(s1);
  assert.equal(A.room.state.seq, 1); // optimistic immediately
  assert.equal(A.room.confirmed.seq, 0);
  assert.equal(await p, true);
  assert.equal(A.room.confirmed.seq, 1);
  const srcs = A.log.states.map((x) => x.meta.source);
  assert.deepEqual(srcs, ['history', 'optimistic', 'live']);
  assert.equal(A.log.states[2].meta.fromMe, true);
  await clock.advance(10);
  const bl = B.log.states[B.log.states.length - 1];
  assert.equal(bl.s.seq, 1);
  assert.deepEqual(bl.meta, { source: 'live', fromMe: false });
  // wrong seq rejected without publishing
  const before = srv.posts().length;
  assert.equal(await A.room.propose(s1), false);
  assert.equal(await A.room.propose(G.applyMove(G.applyMove(A.room.state, 0), 1)), false);
  assert.equal(await A.room.propose({ junk: true }), false);
  assert.equal(srv.posts().length, before);
  // presence: B saw A's ping
  assert.ok(B.log.presence.some((p) => typeof p.alice === 'number'));
  assert.ok(!B.log.presence.some((p) => 'bob' in p));
  // storage saved
  A.room.close(); B.room.close();
});

test('join after the fact sees history silently, state from history', async () => {
  const { clock, srv, A, code } = await setupPair();
  let s = G.withSeat(A.room.state, 1, { id: 'alice', name: 'Alice' });
  assert.equal(await A.room.propose(s), true);
  s = G.applyMove(A.room.state, 3);
  assert.equal(await A.room.propose(s), true);
  A.room.taunt(1, 'Ha!');
  await clock.advance(10);
  // a cached taunt (malicious or old) sitting in history
  srv.publish('glubschi-gewinnt-' + code, JSON.stringify({ v: 1, k: 't', f: 'alice', n: 'n1', t: { seat: 1, text: 'OLD' } }), true);
  const C = makeClient(srv, clock, code, 'carol');
  await clock.advance(10);
  assert.equal(C.log.states.length, 1);
  assert.equal(C.log.states[0].meta.source, 'history');
  assert.equal(C.log.states[0].meta.fromMe, false);
  assert.equal(C.log.states[0].s.seq, 2);
  assert.deepEqual(C.log.taunts, []);
  assert.ok(C.log.presence.every((p) => !('alice' in p))); // history never counts as presence
  A.room.close(); C.room.close();
});

test('taunts: live only, fromMe flag, sanitized, throttled', async () => {
  const { clock, srv, A, B } = await setupPair();
  const RLO = String.fromCharCode(0x202e);
  assert.equal(A.room.taunt(1, '  Du ' + RLO + 'schaffst das nie!  '), true);
  assert.equal(A.room.taunt(1, 'spam'), false); // throttle
  assert.equal(A.room.taunt(3, 'x'), false);
  await clock.advance(2000);
  assert.equal(A.room.taunt(2, ''), false);
  assert.deepEqual(B.log.taunts, [{ seat: 1, text: 'Du schaffst das nie!', from: 'alice', fromMe: false }]);
  assert.deepEqual(A.log.taunts, [{ seat: 1, text: 'Du schaffst das nie!', from: 'alice', fromMe: true }]);
  // taunt and ping are uncached
  assert.ok(srv.posts().filter((r) => !r.url.includes('cache=no')).length === 0);
  assert.equal(srv.cached.length, 0);
  A.room.close(); B.room.close();
});

test('concurrent proposals with equal seq converge (first arrival wins)', async () => {
  const { clock, A, B } = await setupPair();
  assert.equal(await A.room.propose(G.withSeat(A.room.state, 1, { id: 'alice', name: 'A' })), true);
  await clock.advance(10);
  assert.equal(B.room.confirmed.seq, 1);
  const a2 = G.applyMove(A.room.state, 0);
  const b2 = G.withSeat(B.room.state, 2, { id: 'bob', name: 'B' });
  const pa = A.room.propose(a2); // A's POST hits the fake server first
  const pb = B.room.propose(b2);
  const [ra, rb] = await Promise.all([pa, pb]);
  await clock.advance(10);
  assert.equal(ra, true);
  assert.equal(rb, false);
  assert.deepEqual(A.room.confirmed, a2);
  assert.deepEqual(B.room.confirmed, a2);
  assert.deepEqual(B.room.state, a2);
  const bsrc = B.log.states.map((x) => x.meta.source);
  assert.equal(bsrc[bsrc.length - 1], 'revert');
  assert.equal(B.log.states[B.log.states.length - 1].s.seq, 2);
  assert.equal(B.log.states[B.log.states.length - 1].s.board[35], 1);
  // B's late message (seq 2) was ignored by A too: no extra onState on A
  assert.equal(A.log.states.filter((x) => x.s.seq === 2).length, 2); // optimistic + live
  // both can continue from the converged state
  const b3 = G.withSeat(B.room.state, 2, { id: 'bob', name: 'B' });
  assert.equal(await B.room.propose(b3), true);
  await clock.advance(10);
  assert.deepEqual(A.room.confirmed, B.room.confirmed);
  A.room.close(); B.room.close();
});

test('chained proposals: second is cancelled when first loses', async () => {
  const { clock, srv, A, B } = await setupPair();
  const a1 = G.withSeat(A.room.state, 1, { id: 'alice', name: 'A' });
  const b1 = G.withSeat(B.room.state, 2, { id: 'bob', name: 'B' });
  const pb = B.room.propose(b1); // B first on the server
  const pa1 = A.room.propose(a1);
  const pa2 = A.room.propose(G.applyMove(A.room.state, 0)); // built on a1 (seq 2)
  assert.equal(A.room.state.seq, 2);
  const res = await Promise.all([pb, pa1, pa2]);
  await clock.advance(10);
  assert.deepEqual(res, [true, false, false]);
  assert.deepEqual(A.room.confirmed, b1);
  assert.deepEqual(A.room.state, b1);
  // A's second proposal was never sent (cancelled while queued)
  assert.equal(srv.cached.length, 2);
  A.room.close(); B.room.close();
});

test('dedupe duplicate ids', async () => {
  const { clock, srv, A, B } = await setupPair();
  srv.duplicateDelivery = true;
  const before = B.log.states.length;
  assert.equal(await A.room.propose(G.withSeat(A.room.state, 1, { id: 'alice', name: 'A' })), true);
  await clock.advance(10);
  assert.equal(B.log.states.length - before, 1);
  // resync re-polls with since=<lastId>: nothing new, nothing re-emitted
  await clock.advance(5000);
  await B.room.resync();
  await clock.advance(10);
  assert.equal(B.log.states.length - before, 1);
  // a poll with overlap (since=all) is also deduped
  const all = srv._since(A.room.topic, 'all');
  for (const m of all) srv.streams.forEach((s) => s.topic === m.topic && s._raw(JSON.stringify(m)));
  await clock.advance(10);
  assert.equal(B.log.states.length - before, 1);
  A.room.close(); B.room.close();
});

test('reconnect resumes with since=<lastId> and misses nothing', async () => {
  const { clock, srv, A, B } = await setupPair();
  assert.equal(await A.room.propose(G.withSeat(A.room.state, 1, { id: 'alice', name: 'A' })), true);
  await clock.advance(10);
  const lastId = B.room.lastId;
  assert.ok(lastId);
  srv.refuseSSE = true;
  srv.dropAll(); // both drop; A reconnects too, B must catch up
  await clock.advance(10);
  assert.ok(B.log.status.includes('reconnecting'));
  // while disconnected: A publishes two states (POST works, SSE refused)
  const s2 = G.applyMove(A.room.state, 0);
  const p2 = A.room.propose(s2);
  await clock.advance(10);
  srv.refuseSSE = false;
  await clock.advance(1500); // first backoff ~1 s
  assert.equal(await p2, true);
  const s3 = G.applyMove(A.room.state, 1);
  srv.refuseSSE = true;
  srv.dropAll();
  const p3 = A.room.propose(s3);
  await clock.advance(10);
  srv.refuseSSE = false;
  await clock.advance(40000);
  assert.equal(await p3, true);
  const bUrls = srv.esOpens.slice(2);
  assert.ok(bUrls.every((u) => !u.endsWith('since=all')), 'reconnects use since=<id>: ' + bUrls.join(' '));
  assert.ok(bUrls.some((u) => u.endsWith('since=' + lastId)));
  const seqs = B.log.states.map((x) => x.s.seq);
  assert.deepEqual(seqs, [0, 1, 2, 3]);
  assert.deepEqual(B.room.confirmed, s3);
  assert.equal(B.room.status, 'live');
  A.room.close(); B.room.close();
});

test('reconnect backoff grows and is bounded (no tight loop)', async () => {
  const { clock, srv, A, B } = await setupPair();
  B.room.close();
  srv.refuseSSE = true;
  const opens0 = srv.esOpens.length;
  srv.dropAll();
  await clock.advance(120000);
  const opens = srv.esOpens.length - opens0;
  // 1+2+4+8+16+30+30+30 ~ 121 s -> about 7 attempts
  assert.ok(opens >= 5 && opens <= 9, 'reconnect attempts in 120 s: ' + opens);
  assert.equal(A.room.status, 'reconnecting');
  srv.refuseSSE = false;
  await clock.advance(31000);
  assert.equal(A.room.status, 'live');
  A.room.close();
});

test('restore after empty history republishes saved state', async () => {
  const clock = makeClock();
  const srv = new FakeNtfy(clock);
  const code = G.newRoomCode();
  let saved = G.withSeat(G.blankState(), 1, { id: 'alice', name: 'Alice' });
  saved = G.withSeat(saved, 2, { id: 'bob', name: 'Bob' });
  for (const c of [3, 3, 4, 4]) saved = G.applyMove(saved, c);
  const storage = memStorage({ ['glubschi-room-' + code]: JSON.stringify(saved) });
  const A = makeClient(srv, clock, code, 'alice', { storage });
  await clock.advance(50);
  const srcs = A.log.states.map((x) => x.meta.source + ':' + x.s.seq);
  assert.deepEqual(srcs, ['history:0', 'restore:6', 'live:6']);
  assert.deepEqual(A.room.confirmed, saved);
  assert.equal(srv.cached.length, 1);
  const B = makeClient(srv, clock, code, 'bob');
  await clock.advance(50);
  assert.deepEqual(B.room.confirmed, saved);
  assert.equal(B.log.states[0].meta.source, 'history');
  // no restore when history exists (B had nothing saved anyway); A did it only once
  assert.equal(srv.cached.length, 1);
  // storage updated after confirmed states
  assert.deepEqual(JSON.parse(storage.getItem('glubschi-room-' + code)), saved);
  // a corrupt saved state is ignored
  const code2 = G.newRoomCode();
  const C = makeClient(srv, clock, code2, 'carol', { storage: memStorage({ ['glubschi-room-' + code2]: '{"v":1,"seq":5' }) });
  await clock.advance(50);
  assert.deepEqual(C.log.states.map((x) => x.meta.source), ['history']);
  // throwing storage does not break anything
  const D = makeClient(srv, clock, code2, 'dave', { storage: { getItem() { throw new Error('x'); }, setItem() { throw new Error('y'); } } });
  await clock.advance(50);
  assert.equal(await D.room.propose(G.withSeat(D.room.state, 1, { id: 'dave', name: 'D' })), true);
  A.room.close(); B.room.close(); C.room.close(); D.room.close();
});

test('429 on join: status ratelimited, bounded request rate', async () => {
  const clock = makeClock();
  const srv = new FakeNtfy(clock);
  srv.always429 = true;
  const A = makeClient(srv, clock, G.newRoomCode(), 'alice');
  await clock.advance(120000);
  const n = srv.requests.length;
  // waits 5,10,20,40,60 -> requests at 0,5,15,35,75,135 -> 5 within 120 s
  assert.ok(n >= 4 && n <= 6, 'requests in 120 s while rate limited: ' + n);
  assert.ok(A.log.status.includes('ratelimited'));
  assert.equal(A.room.loaded, false);
  srv.always429 = false;
  await clock.advance(61000);
  assert.equal(A.room.loaded, true);
  assert.equal(A.room.status, 'live');
  A.room.close();
});

test('429 on publish: waits 5 s doubling, then succeeds', async () => {
  const { clock, srv, A, B } = await setupPair();
  const posts0 = srv.statePosts().length;
  srv.always429 = true;
  const p = A.room.propose(G.withSeat(A.room.state, 1, { id: 'alice', name: 'A' }));
  await clock.advance(30000);
  const during = srv.requests.filter((r) => r.at > clock.now() - 30000).length;
  // POST at 0 (429) -> wait 5 s -> POST at 5 (429) -> wait 10 s -> POST at 15 (429) -> wait 20 s
  assert.ok(during <= 4, 'requests in 30 s under 429: ' + during);
  assert.equal(A.room.status, 'ratelimited');
  srv.always429 = false;
  await clock.advance(30000);
  assert.equal(await p, true);
  assert.equal(A.room.status, 'live');
  assert.ok(srv.statePosts().length - posts0 <= 5, 'state posts: ' + (srv.statePosts().length - posts0));
  // permanent 429 -> gives up after 6 attempts and reverts
  srv.always429 = true;
  const before = srv.requests.length;
  const q = A.room.propose(G.applyMove(A.room.state, 2));
  await clock.advance(400000);
  assert.equal(await q, false);
  const src = A.log.states[A.log.states.length - 1].meta.source;
  assert.equal(src, 'revert');
  assert.equal(A.room.state.seq, A.room.confirmed.seq);
  assert.ok(srv.requests.length - before <= 20, 'requests over 400 s: ' + (srv.requests.length - before));
  srv.always429 = false;
  A.room.close(); B.room.close();
});

test('network failure: 1 + 5 retries with backoff, then revert', async () => {
  const { clock, srv, A, B } = await setupPair();
  srv.networkDown = true;
  const before = srv.statePosts().length;
  const p = A.room.propose(G.withSeat(A.room.state, 1, { id: 'alice', name: 'A' }));
  await clock.advance(500);
  assert.equal(srv.statePosts().length - before, 1);
  await clock.advance(60000);
  assert.equal(await p, false);
  assert.equal(srv.statePosts().length - before, 6);
  const last = A.log.states[A.log.states.length - 1];
  assert.equal(last.meta.source, 'revert');
  assert.equal(last.s.seq, 0);
  srv.networkDown = false;
  A.room.close(); B.room.close();
});

test('offline/online/visibility events trigger status and resync', async () => {
  const clock = makeClock();
  const srv = new FakeNtfy(clock);
  const mkTarget = () => {
    const l = {};
    return { visibilityState: 'visible', addEventListener: (t, f) => { (l[t] = l[t] || []).push(f); }, removeEventListener: (t, f) => { l[t] = (l[t] || []).filter((x) => x !== f); }, fire: (t) => (l[t] || []).forEach((f) => f({})), l };
  };
  const doc = mkTarget();
  const win = mkTarget();
  const code = G.newRoomCode();
  const A = makeClient(srv, clock, code, 'alice', { document: doc, window: win });
  const B = makeClient(srv, clock, code, 'bob');
  await clock.advance(10);
  win.fire('offline');
  assert.equal(A.room.status, 'offline');
  // phone goes to background: stream dies silently, B publishes
  srv.refuseSSE = true;
  const aStream = [...srv.streams][0]; // A joined first
  aStream.close(); // silent death, no onerror
  await clock.advance(10);
  const s1 = G.withSeat(B.room.state, 2, { id: 'bob', name: 'B' });
  assert.equal(await B.room.propose(s1), true);
  srv.refuseSSE = false;
  doc.visibilityState = 'hidden';
  doc.fire('visibilitychange');
  doc.visibilityState = 'visible';
  const polls0 = srv.requests.filter((r) => r.url.includes('poll=1')).length;
  win.fire('online');
  await clock.advance(10);
  assert.deepEqual(A.room.confirmed, s1);
  assert.equal(srv.requests.filter((r) => r.url.includes('poll=1')).length - polls0, 1);
  // repeated events are coalesced
  for (let i = 0; i < 20; i++) doc.fire('visibilitychange');
  await clock.advance(10);
  assert.ok(srv.requests.filter((r) => r.url.includes('poll=1')).length - polls0 <= 2);
  A.room.close(); B.room.close();
  assert.equal((doc.l.visibilitychange || []).length, 0);
  assert.equal((win.l.online || []).length, 0);
});

test('stale stream watchdog reconnects', async () => {
  const clock = makeClock();
  const srv = new FakeNtfy(clock);
  const code = G.newRoomCode();
  const A = makeClient(srv, clock, code, 'alice', { pingMs: 3600000 }); // own pings would count as activity
  const B = makeClient(srv, clock, code, 'bob', { pingMs: 3600000 });
  await clock.advance(10);
  B.room.close();
  const opens0 = srv.esOpens.length;
  // keepalives keep it open
  for (let i = 0; i < 6; i++) { [...srv.streams].forEach((s) => s._keepalive()); await clock.advance(45000); }
  assert.equal(srv.esOpens.length, opens0);
  // silence -> reconnect within ~2.5 min
  await clock.advance(150000);
  assert.ok(srv.esOpens.length > opens0);
  A.room.close();
});

test('malformed messages are ignored without throwing', async () => {
  const { clock, srv, A, B } = await setupPair();
  const topic = A.room.topic;
  const good = G.withSeat(A.room.state, 1, { id: 'alice', name: 'A' });
  const env = (o) => JSON.stringify(Object.assign({ v: 1, k: 's', f: 'evil', n: 'n1' }, o));
  const bad = [
    'not json', '', '{', 'null', '[]', '{"v":1}', env({ k: 'x', s: good }), env({ f: 'bad id!', s: good }),
    env({ n: '', s: good }), env({ s: null }), env({ s: 'str' }), env({ s: Object.assign({}, good, { seq: 99, board: good.board.map(() => 1) }) }),
    env({ s: Object.assign({}, good, { players: { '1': { id: 'a', name: 'x'.repeat(300) }, '2': null } }) }),
    '{"__proto__":{"polluted":1},"v":1,"k":"s","f":"evil","n":"n","s":{"__proto__":{"seq":5}}}',
    env({ k: 't', t: { seat: 9, text: 'x' } }), env({ k: 't', t: 'boo' }), env({ k: 't', t: { seat: 1, text: 42 } }),
    'x'.repeat(5000),
  ];
  for (const b of bad) srv.publish(topic, b, true);
  // raw junk directly on the stream
  for (const s of srv.streams) {
    s._raw('garbage'); s._raw('{"event":"message","id":"zz","message":5}'); s._raw('{"event":"keepalive","id":"k1"}');
    s._raw(JSON.stringify({ event: 'message', id: 'has space', message: env({ s: good }) }));
    s._raw(JSON.stringify({ event: 'message', id: 'other1', topic: 'other-topic', message: env({ s: good }) }));
    s._raw(undefined);
  }
  await clock.advance(100);
  assert.equal(({}).polluted, undefined);
  assert.equal(A.room.confirmed.seq, 0);
  assert.equal(B.room.confirmed.seq, 0);
  assert.equal(B.log.taunts.length, 0);
  // a throwing UI callback does not break the relay
  const code = A.room.code;
  const T = G.joinRoom({ code, clientId: 'thrower', onState() { throw new Error('ui bug'); }, onStatus() { throw new Error('ui bug'); }, onPresence() { throw new Error('x'); },
    options: { fetch: srv.fetch, EventSource: srv.EventSource, storage: null, now: clock.now, timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }, document: null, window: null } });
  await clock.advance(50);
  assert.equal(await T.propose(good), true);
  await clock.advance(10);
  assert.deepEqual(A.room.confirmed, good);
  // after junk, the relay still works normally
  assert.equal(await A.room.propose(G.applyMove(A.room.state, 2)), true);
  A.room.close(); B.room.close(); T.close();
});

test('close: no timers left, no callbacks afterwards, pending resolves false', async () => {
  const { clock, srv, A, B } = await setupPair();
  srv.networkDown = true;
  const p = A.room.propose(G.withSeat(A.room.state, 1, { id: 'alice', name: 'A' }));
  const n = A.log.states.length;
  A.room.close();
  B.room.close();
  assert.equal(await p, false);
  assert.equal(clock.pending(), 0);
  await clock.advance(100000);
  assert.equal(A.log.states.length, n);
  assert.equal(srv.streams.size, 0);
  assert.throws(() => G.joinRoom({ code: 'nope' }));
});

test('budget: 15 minute game stays far below the rate limit', async () => {
  const { clock, srv, A, B } = await setupPair();
  const t0 = clock.now();
  let s = G.withSeat(A.room.state, 1, { id: 'alice', name: 'A' });
  await A.room.propose(s);
  await clock.advance(1000);
  await B.room.propose(G.withSeat(B.room.state, 2, { id: 'bob', name: 'B' }));
  let games = 0;
  let mover = A;
  const cols = [3, 2, 4, 1, 5, 0, 6];
  let k = 0;
  while (clock.now() - t0 < 15 * 60000) {
    [...srv.streams].forEach((x) => x._keepalive());
    await clock.advance(10000); // think time
    const cur = mover.room.state;
    let next = cur.winner ? G.rematch(cur) : null;
    if (!next) { for (let j = 0; j < 7 && !next; j++) next = G.applyMove(cur, cols[(k + j) % 7]); k++; }
    if (!next) next = G.rematch(cur);
    if (cur.winner) games++;
    await mover.room.propose(next);
    mover = mover === A ? B : A;
    if (k % 20 === 0) srv.dropAll(); // occasional network hiccup
  }
  await clock.advance(10);
  assert.deepEqual(A.room.confirmed, B.room.confirmed);
  const total = srv.requests.length + srv.esOpens.length;
  // worst 5-minute window for the shared fake server (both clients!)
  const times = srv.requests.map((r) => r.at).sort((a, b) => a - b);
  let worst = 0;
  for (let i = 0, j = 0; i < times.length; i++) { while (times[i] - times[j] > 300000) j++; worst = Math.max(worst, i - j + 1); }
  // ntfy allows 60 + 300/5 = 120 requests per 5 minutes per IP; two clients on
  // one IP here, so one client alone uses about half.
  assert.ok(worst < 100, 'worst 5-min window (both clients): ' + worst);
  console.log('    budget: total requests incl. SSE opens over 15 min (2 clients) =', total, ', worst 5-min window =', worst, ', moves/rematches =', A.room.confirmed.seq);
  void games;
  A.room.close(); B.room.close();
});

// ------------------------------------------------------ regression tests
const mkTarget = () => {
  const l = {};
  return { visibilityState: 'visible', addEventListener: (t, f) => { (l[t] = l[t] || []).push(f); }, removeEventListener: (t, f) => { l[t] = (l[t] || []).filter((x) => x !== f); }, fire: (t) => (l[t] || []).forEach((f) => f({})), l };
};
const postsBy = (srv, id) => srv.posts().filter((r) => r.body.includes('"f":"' + id + '"'));
const firstStream = (srv) => [...srv.streams].find((s) => s.url === srv.esOpens[0]);
const topicOf = (code) => 'glubschi-gewinnt-' + code;
// EventSource + fetch for one client: remembers its streams; with mute set,
// its streams open but deliver nothing and its polls return nothing
function trackES(srv) {
  const tr = { list: [], mute: false, last: () => tr.list[tr.list.length - 1] };
  tr.ES = class Tracked extends srv.EventSource {
    constructor(u) { super(u); tr.list.push(this); }
    _deliver(m) { if (!tr.mute) super._deliver(m); }
  };
  tr.fetch = (u, i) => ((!i || i.method !== 'POST') && tr.mute ? Promise.resolve(resp(200, '')) : srv.fetch(u, i));
  return tr;
}
// await a promise while the fake clock runs (gives up after maxMs)
async function settle(clock, p, maxMs = 120000) {
  let done = false, val;
  p.then((v) => { done = true; val = v; });
  for (let t = 0; !done && t < maxMs; t += 100) await clock.advance(100);
  assert.ok(done, 'promise did not settle within ' + maxMs + ' ms');
  return val;
}

test('quota: few POSTs per client and hour, no periodic pings', async () => {
  const clock = makeClock();
  const srv = new FakeNtfy(clock);
  const code = G.newRoomCode();
  const doc = mkTarget();
  const A = makeClient(srv, clock, code, 'alice', { document: doc, pingMs: undefined }); // default gap
  await clock.advance(10);
  const B = makeClient(srv, clock, code, 'bob', { pingMs: undefined });
  await clock.advance(10);
  // 1 h idle, visible, stream alive
  for (let i = 0; i < 80; i++) { [...srv.streams].forEach((s) => s._keepalive()); await clock.advance(45000); }
  const idleA = postsBy(srv, 'alice').length, idleB = postsBy(srv, 'bob').length;
  assert.ok(idleA <= 2 && idleB <= 2, 'POSTs in an idle hour: alice ' + idleA + ', bob ' + idleB);
  // 1 h of switching apps every minute (WhatsApp!) plus B rejoining every 10 min
  let Bx = B;
  const a0 = postsBy(srv, 'alice').length;
  for (let m = 1; m <= 60; m++) {
    doc.visibilityState = 'hidden'; doc.fire('visibilitychange');
    await clock.advance(20000);
    doc.visibilityState = 'visible'; doc.fire('visibilitychange');
    if (m % 10 === 0) { Bx.room.close(); Bx = makeClient(srv, clock, code, 'bob', { pingMs: undefined }); }
    [...srv.streams].forEach((s) => s._keepalive());
    await clock.advance(40000);
  }
  const busyA = postsBy(srv, 'alice').length - a0;
  // at most 1 ping per 5 min for visibility + 1 reply per 5 min
  assert.ok(busyA <= 24, 'alice POSTs in a busy hour without moves: ' + busyA);
  // the old 25 s pings alone were 144 per hour; a whole idle day now stays far below 250
  assert.ok(idleA * 24 < 60, 'idle day projection: ' + idleA * 24);
  A.room.close(); Bx.room.close();
});

test('quota: 429 code 42908 -> status quota, fail at once, no retry loop', async () => {
  const { clock, srv, A, B } = await setupPair();
  assert.equal(await A.room.propose(G.withSeat(A.room.state, 1, { id: 'alice', name: 'A' })), true);
  srv.quota = (body) => body.includes('"f":"alice"'); // only alice's IP is out of quota
  const posts0 = postsBy(srv, 'alice').length;
  const t0 = clock.now();
  const p = A.room.propose(G.applyMove(A.room.state, 3));
  let res = null; p.then((v) => { res = v; });
  await clock.advance(500);
  assert.equal(res, false, 'resolved false right away');
  assert.ok(clock.now() - t0 < 1000);
  assert.equal(A.room.status, 'quota');
  assert.equal(A.log.states[A.log.states.length - 1].meta.source, 'revert');
  assert.equal(postsBy(srv, 'alice').length - posts0, 1);
  // further publishes fail without a request, reads keep working, status stays 'quota'
  assert.equal(await A.room.propose(G.applyMove(A.room.state, 3)), false);
  assert.equal(A.room.taunt(1, 'hallo'), true);
  await clock.advance(10 * 60000);
  assert.equal(postsBy(srv, 'alice').length - posts0, 1, 'no POST while the quota is used up');
  await A.room.resync();
  assert.equal(A.room.status, 'quota');
  assert.ok(!A.log.status.slice(A.log.status.indexOf('quota')).includes('live'), 'no flip-flop to live: ' + A.log.status.join(','));
  assert.equal(A.log.status.filter((x) => x === 'ratelimited').length, 0);
  // B (other IP) still plays and A sees it (streams went stale meanwhile: let the clock run)
  assert.equal(await settle(clock, B.room.propose(G.applyMove(B.room.state, 2))), true);
  await clock.advance(10);
  assert.deepEqual(A.room.confirmed, B.room.confirmed);
  // quota back after the probe interval
  srv.quota = false;
  await clock.advance(21 * 60000);
  assert.equal(A.room.status, 'live');
  assert.equal(await settle(clock, A.room.propose(G.applyMove(A.room.state, 4))), true);
  A.room.close(); B.room.close();
});

test('restore: newer saved state wins over an older restore (empty cache)', async () => {
  const clock = makeClock();
  const srv = new FakeNtfy(clock);
  const code = G.newRoomCode();
  let s = G.withSeat(G.blankState(), 1, { id: 'alice', name: 'A' });
  s = G.withSeat(s, 2, { id: 'bob', name: 'B' });
  for (const c of [3, 3, 4]) s = G.applyMove(s, c);
  const older = s;                  // seq 5: bob closed here
  const newer = G.applyMove(s, 4);  // seq 6: alice's move afterwards
  const key = 'glubschi-room-' + code;
  const stB = memStorage({ [key]: JSON.stringify(older) });
  const stA = memStorage({ [key]: JSON.stringify(newer) });
  const B = makeClient(srv, clock, code, 'bob', { storage: stB });
  await clock.advance(60000);
  assert.equal(B.room.confirmed.seq, 5);
  const A = makeClient(srv, clock, code, 'alice', { storage: stA });
  await clock.advance(60000);
  assert.deepEqual(A.room.confirmed, newer);
  assert.deepEqual(B.room.confirmed, newer);
  assert.equal(JSON.parse(stA.getItem(key)).seq, 6);
  assert.equal(JSON.parse(stB.getItem(key)).seq, 6);
  assert.ok(A.log.states.some((x) => x.meta.source === 'restore' && x.s.seq === 6));
  // a late joiner computes the same from the history
  const C = makeClient(srv, clock, code, 'carol');
  await clock.advance(1000);
  assert.deepEqual(C.room.confirmed, newer);
  A.room.close(); B.room.close(); C.room.close();
});

test('restore: open client answers an older restore once, both converge', async () => {
  const clock = makeClock();
  const srv = new FakeNtfy(clock);
  const code = G.newRoomCode();
  const A = makeClient(srv, clock, code, 'alice');
  await clock.advance(10);
  let older = null;
  const steps = [(x) => G.withSeat(x, 1, { id: 'alice', name: 'A' }), (x) => G.withSeat(x, 2, { id: 'bob', name: 'B' }),
    (x) => G.applyMove(x, 3), (x) => G.applyMove(x, 3), (x) => G.applyMove(x, 4), (x) => G.applyMove(x, 4)];
  for (const f of steps) {
    assert.equal(await A.room.propose(f(A.room.state)), true);
    if (A.room.confirmed.seq === 5) older = A.room.confirmed;
  }
  assert.equal(A.room.confirmed.seq, 6);
  srv.cached.length = 0; // 12 h cache expiry, A's tab stayed open
  const B = makeClient(srv, clock, code, 'bob', { storage: memStorage({ ['glubschi-room-' + code]: JSON.stringify(older) }) });
  await clock.advance(20000);
  assert.deepEqual(B.room.confirmed, A.room.confirmed);
  assert.equal(B.room.confirmed.seq, 6);
  assert.equal(srv.statePosts().filter((r) => r.body.includes('"r":1')).length, 2, 'one restore by B, one answer by A');
  // play goes on normally: both see the same turn and B's move reaches A
  assert.equal(A.room.state.turn, B.room.state.turn);
  assert.equal(await B.room.propose(G.applyMove(B.room.state, 0)), true);
  await clock.advance(10);
  assert.deepEqual(A.room.confirmed, B.room.confirmed);
  assert.equal(A.room.confirmed.seq, 7);
  A.room.close(); B.room.close();
});

test('chained proposal waits for its parent; a lost parent never overwrites the winner', async () => {
  const { clock, srv, A, B } = await setupPair();
  firstStream(srv).close(); // A's stream dies silently
  const b1 = G.withSeat(B.room.state, 2, { id: 'bob', name: 'Bob' });
  const pb = B.room.propose(b1);
  await flush();
  const pa1 = A.room.propose(G.withSeat(A.room.state, 1, { id: 'alice', name: 'Alice' }));
  const pa2 = A.room.propose(G.applyMove(A.room.state, 3));
  await clock.advance(60000);
  assert.deepEqual([await pb, await pa1, await pa2], [true, false, false]);
  assert.deepEqual(A.room.confirmed, b1);
  assert.deepEqual(B.room.confirmed, b1);
  assert.equal(srv.cached.length, 2, 'the chained state was never sent');
  assert.ok(!A.log.states.some((x) => x.s.seq === 2 && x.meta.source !== 'optimistic'));
  // normal chaining still works and only sends after the echo (A's dead
  // stream gets replaced by the missing-echo check, so let the clock run)
  const c1 = A.room.propose(G.applyMove(A.room.state, 0));
  const c2 = A.room.propose(G.applyMove(A.room.state, 1));
  assert.deepEqual([await settle(clock, c1), await settle(clock, c2)], [true, true]);
  await clock.advance(10);
  assert.deepEqual(A.room.confirmed, B.room.confirmed);
  assert.equal(B.room.confirmed.seq, 3);
  A.room.close(); B.room.close();
});

test('uncached state messages are ignored', async () => {
  const { clock, srv, A, B, code } = await setupPair();
  assert.equal(await A.room.propose(G.withSeat(A.room.state, 1, { id: 'alice', name: 'Alice' })), true);
  await clock.advance(10);
  const lastA = A.room.lastId;
  const forged = G.applyMove(A.room.state, 0);
  srv.publish(topicOf(code), JSON.stringify({ v: 1, k: 's', f: 'evil', n: 'x1', s: forged }), false);
  await clock.advance(10);
  assert.equal(A.room.confirmed.seq, 1);
  assert.equal(B.room.confirmed.seq, 1);
  assert.equal(A.room.lastId, lastA, 'uncached id is no since= marker');
  B.room.close();
  const B2 = makeClient(srv, clock, code, 'bob');
  await clock.advance(5000);
  assert.equal(await B2.room.propose(G.withSeat(B2.room.state, 2, { id: 'bob', name: 'Bob' })), true);
  await clock.advance(10);
  assert.deepEqual(A.room.confirmed, B2.room.confirmed);
  assert.equal(A.room.confirmed.players['2'].name, 'Bob');
  A.room.close(); B2.room.close();
});

test('forged states: only legal successors are accepted, room stays playable', async () => {
  const { clock, srv, A, B, code } = await setupPair();
  assert.equal(await A.room.propose(G.withSeat(A.room.state, 1, { id: 'alice', name: 'A' })), true);
  await clock.advance(10);
  const good = A.room.confirmed;
  const pub = (s) => srv.publish(topicOf(code), JSON.stringify({ v: 1, k: 's', f: 'evil', n: 'x' + srv.nextId, s }), true);
  const huge = JSON.parse(JSON.stringify(good)); huge.seq = 1e9;
  const score = G.applyMove(good, 0); score.score['2'] = 7;                        // forged score
  const twice = G.applyMove(G.applyMove(good, 0), 1); twice.seq = good.seq + 1;    // two chips at once
  const polls0 = srv.requests.filter((r) => r.url.includes('since=all')).length;
  for (const f of [huge, score, twice]) pub(f);
  await clock.advance(10);
  assert.deepEqual(A.room.confirmed, good);
  assert.deepEqual(B.room.confirmed, good);
  // the full re-read that repairs real gaps is throttled (2 clients -> 2 reads)
  assert.ok(srv.requests.filter((r) => r.url.includes('since=all')).length - polls0 <= 2);
  assert.ok(G.applyMove(A.room.state, 0));
  assert.equal(await A.room.propose(G.applyMove(A.room.state, 0)), true);
  await clock.advance(10);
  assert.deepEqual(A.room.confirmed, B.room.confirmed);
  // propose also refuses non-helper states
  const bad = G.applyMove(A.room.state, 1); bad.score['1'] = 3;
  assert.equal(await A.room.propose(bad), false);
  // a newcomer agrees
  const C = makeClient(srv, clock, code, 'carol');
  await clock.advance(100);
  assert.deepEqual(C.room.confirmed, A.room.confirmed);
  // applyMove has the MAX_INT guard like the other helpers
  const top = G.blankState(); top.seq = 1e9;
  assert.equal(G.applyMove(top, 0), null);
  A.room.close(); B.room.close(); C.room.close();
});

test('gap: own state expired from history -> adopt what a newcomer computes', async () => {
  const { clock, srv, A, B } = await setupPair();
  for (const c of [0, 1, 0]) assert.equal(await B.room.propose(G.applyMove(B.room.state, c)), true);
  await clock.advance(10);
  assert.equal(A.room.confirmed.seq, 3);
  srv.refuseSSE = true;
  firstStream(srv)._drop();
  for (const c of [1, 2, 2]) assert.equal(await B.room.propose(G.applyMove(B.room.state, c)), true);
  srv.cached.splice(0, 4); // rolling expiry: seq 1..4 gone, A's seq 3 too
  srv.refuseSSE = false;
  await clock.advance(40000);
  assert.deepEqual(A.room.confirmed, B.room.confirmed);
  assert.equal(A.room.confirmed.seq, 6);
  A.room.close(); B.room.close();
});

test('fork repair: a client on the losing side of an unseen race converges', async () => {
  const clock = makeClock();
  const srv = new FakeNtfy(clock);
  const code = G.newRoomCode();
  const A = makeClient(srv, clock, code, 'alice');
  await clock.advance(10);
  const bes = trackES(srv);
  const B = makeClient(srv, clock, code, 'bob', { EventSource: bes.ES, fetch: bes.fetch });
  await clock.advance(10);
  assert.equal(await A.room.propose(G.applyMove(A.room.state, 0)), true);
  await clock.advance(10);
  // B misses A's next move on a live stream (cannot happen on TCP, but the
  // relay must not stay split if it ever does)
  bes.mute = true;
  assert.equal(await A.room.propose(G.applyMove(A.room.state, 1)), true);
  await clock.advance(10);
  bes.mute = false;
  assert.equal(B.room.confirmed.seq, 1);
  assert.equal(await B.room.propose(G.applyMove(B.room.state, 5)), true); // B: own echo, A: loser
  await clock.advance(10);
  assert.equal(A.room.confirmed.board[idx(5, 5)], 0);
  // A moves on: B sees a non-successor, re-reads the history and joins A's chain
  assert.equal(await A.room.propose(G.applyMove(A.room.state, 2)), true);
  await clock.advance(100);
  assert.deepEqual(B.room.confirmed, A.room.confirmed);
  assert.equal(B.log.states[B.log.states.length - 1].meta.source, 'catchup');
  A.room.close(); B.room.close();
});

test('back from background: stream is reconnected, moves arrive at once', async () => {
  const clock = makeClock();
  const srv = new FakeNtfy(clock);
  const code = G.newRoomCode();
  const doc = mkTarget();
  const aes = trackES(srv);
  const A = makeClient(srv, clock, code, 'alice', { document: doc, EventSource: aes.ES, fetch: aes.fetch });
  await clock.advance(10);
  const B = makeClient(srv, clock, code, 'bob');
  await clock.advance(10);
  await A.room.propose(G.withSeat(A.room.state, 1, { id: 'alice', name: 'A' }));
  await clock.advance(30000);
  doc.visibilityState = 'hidden'; doc.fire('visibilitychange');
  aes.last().close(); // switching to WhatsApp: the OS kills the socket, no onerror
  await clock.advance(60000);
  doc.visibilityState = 'visible'; doc.fire('visibilitychange');
  await clock.advance(1000);
  assert.equal(aes.list.length, 2, 'stream replaced on return');
  assert.ok(aes.last().url.includes('since=' + A.room.lastId));
  await B.room.propose(G.withSeat(B.room.state, 2, { id: 'bob', name: 'B' }));
  await clock.advance(100);
  assert.equal(A.room.confirmed.seq, 2, 'B\'s move arrives at once');
  assert.equal(A.room.status, 'live');
  // short switches (< 5 s) keep the stream and only poll
  doc.visibilityState = 'hidden'; doc.fire('visibilitychange');
  await clock.advance(2000);
  doc.visibilityState = 'visible'; doc.fire('visibilitychange');
  await clock.advance(100);
  assert.equal(aes.list.length, 2);
  // missing own echo: the dead stream is replaced (not just one poll), again
  // with backoff while the echo stays missing
  aes.mute = true; // the echo does not come back, neither by stream nor by poll
  const p = A.room.propose(G.applyMove(A.room.state, 0));
  await clock.advance(7500);
  assert.equal(aes.list.length, 2);
  await clock.advance(1500);
  assert.equal(aes.list.length, 3, 'reconnect after the missing echo (8 s)');
  await clock.advance(16000);
  assert.equal(aes.list.length, 4, 're-armed with backoff (16 s later)');
  aes.mute = false;
  assert.equal(await settle(clock, p), true);
  assert.ok(aes.list.length <= 5, 'found by the catch-up poll or the next check');
  assert.equal(await B.room.propose(G.applyMove(B.room.state, 1)), true);
  await clock.advance(100);
  assert.deepEqual(A.room.confirmed, B.room.confirmed);
  A.room.close(); B.room.close();
});

test('catch-up after missed moves: one catchup event, presence from message time', async () => {
  const clock = makeClock();
  const srv = new FakeNtfy(clock);
  const code = G.newRoomCode();
  const aes = trackES(srv);
  const A = makeClient(srv, clock, code, 'alice', { EventSource: aes.ES });
  await clock.advance(10);
  const B = makeClient(srv, clock, code, 'bob');
  await clock.advance(10);
  srv.refuseSSE = true;
  aes.last()._drop();
  const t0 = clock.now();
  for (let i = 0; i < 5; i++) { await B.room.propose(G.applyMove(B.room.state, i % 2)); await clock.advance(100); }
  await clock.advance(2 * 3600000); // A's network is gone for 2 h
  const before = A.log.states.length;
  const presBefore = A.log.presence.length;
  srv.refuseSSE = false;
  await clock.advance(60000);
  const ev = A.log.states.slice(before).map((x) => x.meta.source + ':' + x.s.seq);
  assert.deepEqual(ev, ['catchup:5']);
  assert.deepEqual(A.room.confirmed, B.room.confirmed);
  // old messages do not make B look online now
  assert.ok(A.room.presence.bob <= t0 + 2000, 'bob last seen ' + (clock.now() - A.room.presence.bob) + ' ms ago');
  assert.ok(A.log.presence.slice(presBefore).every((p) => p.bob <= t0 + 2000));
  // the same through a poll (resync) also gives one event
  aes.last().close(); // silent death
  for (let i = 0; i < 3; i++) { await B.room.propose(G.applyMove(B.room.state, 2 + i)); await clock.advance(100); }
  const b2 = A.log.states.length;
  await clock.advance(5000);
  await A.room.resync();
  await clock.advance(100);
  assert.deepEqual(A.log.states.slice(b2).map((x) => x.meta.source + ':' + x.s.seq), ['catchup:8']);
  // real-time moves stay 'live'
  await clock.advance(10000);
  A.room.close();
  const A2 = makeClient(srv, clock, code, 'alice');
  await clock.advance(100);
  const b3 = A2.log.states.length;
  await B.room.propose(G.applyMove(B.room.state, 6));
  await clock.advance(100);
  assert.deepEqual(A2.log.states.slice(b3).map((x) => x.meta.source + ':' + x.s.seq), ['live:9']);
  A2.room.close(); B.room.close();
});

test('confirmed state is not retried when its POST response is lost', async () => {
  const clock = makeClock();
  const srv = new FakeNtfy(clock);
  const code = G.newRoomCode();
  let hang = 0;
  const fetchHang = (u, i) => {
    if (hang > 0 && (i && i.method) === 'POST' && String(i.body).includes('"k":"s"')) {
      hang--;
      srv.requests.push({ method: 'POST', url: u, at: clock.now(), body: String(i.body) });
      srv.publish(new URL(u).pathname.split('/')[1], String(i.body), true);
      return new Promise(() => {}); // published, but the response never arrives
    }
    return srv.fetch(u, i);
  };
  const A = makeClient(srv, clock, code, 'alice', { fetch: fetchHang });
  await clock.advance(10);
  hang = 3;
  const posts0 = srv.statePosts().length;
  assert.equal(await A.room.propose(G.withSeat(A.room.state, 1, { id: 'alice', name: 'A' })), true);
  const t0 = clock.now();
  let done = null;
  A.room.propose(G.withSeat(A.room.state, 2, { id: 'bob', name: 'B' })).then((v) => { done = v; });
  while (done === null && clock.now() - t0 < 120000) await clock.advance(100);
  assert.equal(done, true);
  assert.ok(clock.now() - t0 <= 1000, 'second proposal waited ' + (clock.now() - t0) + ' ms');
  await clock.advance(120000);
  assert.equal(srv.statePosts().length - posts0, 2, 'no retries of confirmed states');
  assert.equal(A.room.confirmed.seq, 2);
  A.room.close();
});

test('presence: every newcomer gets a reply (reload, second app), bounded', async () => {
  const clock = makeClock();
  const srv = new FakeNtfy(clock);
  const code = G.newRoomCode();
  const replies = () => postsBy(srv, 'alice').filter((r) => r.body.includes('"re":1')).length;
  const A = makeClient(srv, clock, code, 'alice', { pingMs: undefined });
  await clock.advance(6000); // alice's own join ping is over
  let B = makeClient(srv, clock, code, 'bob', { pingMs: undefined });
  await clock.advance(1000);
  assert.equal(replies(), 1, 'reply to bob');
  assert.ok(typeof B.room.presence.alice === 'number', 'bob sees alice');
  // 20 s later the same person opens the home-screen app (new id): alice answers again
  await clock.advance(20000);
  const B2 = makeClient(srv, clock, code, 'bob-app', { pingMs: undefined });
  await clock.advance(1000);
  assert.equal(replies(), 2, 'reply to the new id');
  assert.ok(typeof B2.room.presence.alice === 'number', 'the app sees alice');
  // bob reloads 2 min after the first join: alice answers again (gap per client 10 s)
  await clock.advance(100000);
  B.room.close();
  B = makeClient(srv, clock, code, 'bob', { pingMs: undefined });
  await clock.advance(1000);
  assert.equal(replies(), 3, 'reply after a reload');
  assert.ok(typeof B.room.presence.alice === 'number', 'reloaded bob sees alice');
  // bob reloads again 15 s later (iOS likes to reload tabs): still answered
  await clock.advance(15000);
  B.room.close();
  B = makeClient(srv, clock, code, 'bob', { pingMs: undefined });
  await clock.advance(1000);
  assert.equal(replies(), 4, 'reply after a quick second reload');
  assert.ok(typeof B.room.presence.alice === 'number', 'bob sees alice after the quick reload');
  // a reload storm stays bounded: max 20 replies per hour
  for (let i = 0; i < 400; i++) {
    B.room.close();
    B = makeClient(srv, clock, code, 'bob' + (i % 3), { pingMs: undefined });
    await clock.advance(9000);
  }
  const n = replies();
  assert.ok(n <= 4 + 20 + 1, 'replies in an hour of reloads: ' + n);
  A.room.close(); B.room.close(); B2.room.close();
});

test('presence: the join ping waits for the own stream, so the reply is not lost', async () => {
  const clock = makeClock();
  const srv = new FakeNtfy(clock);
  const code = G.newRoomCode();
  const A = makeClient(srv, clock, code, 'alice', { pingMs: undefined });
  await clock.advance(6000); // alice's own join ping is over
  srv.openDelayMs = 1500;    // slow mobile network: bob's stream opens late
  const B = makeClient(srv, clock, code, 'bob', { pingMs: undefined });
  await clock.advance(4000);
  const bobPings = postsBy(srv, 'bob').filter((r) => r.body.includes('"k":"p"'));
  assert.equal(bobPings.length, 1, 'one join ping');
  assert.ok(bobPings[0].at - 1700000006000 >= 1500, 'ping sent after the stream opened');
  assert.ok(typeof B.room.presence.alice === 'number', 'bob sees alice although his stream opened late');
  A.room.close(); B.room.close();
});

// ------------------------------------------------------------------- main
let running = null;
process.on('exit', () => {
  // an await that never resolves empties the event loop: report it, never pass silently
  if (running) { console.log('HANG ' + running + ' (a promise never settled)'); process.exitCode = 1; }
});
(async () => {
  let pass = 0, fail = 0;
  const only = process.env.ONLY || '';
  for (const t of tests.filter((x) => x.name.startsWith(only))) {
    running = t.name;
    try {
      await t.fn();
      pass++;
      console.log('ok   ' + t.name);
    } catch (e) {
      fail++;
      console.log('FAIL ' + t.name + '\n     ' + (e && e.stack ? e.stack.split("\n").slice(0, 14).join('\n     ') : e));
    }
  }
  running = null;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
