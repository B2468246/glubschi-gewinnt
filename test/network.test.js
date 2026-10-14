'use strict';
// Live test against the public ntfy.sh server.
// Run: node --experimental-eventsource test/network.test.js
// Budget: both clients share this machine's IP (ntfy: burst 60, then 1 per 5 s),
// so every HTTP request is counted and the total must stay <= 40.
// If ntfy answers 429, wait a few minutes and rerun; do not loop.
const assert = require('node:assert/strict');
const path = require('node:path');
const G = require(path.join(__dirname, '..', 'relay.js'));

const LIMIT = 40;
if (typeof EventSource === 'undefined') {
  console.error('EventSource missing: run with node --experimental-eventsource');
  process.exit(2);
}

const counter = { fetch: 0, sse: 0, log: [] };
function countingFetch(url, init) {
  counter.fetch++;
  counter.log.push(((init && init.method) || 'GET') + ' ' + url.replace(/^https:\/\/ntfy\.sh/, ''));
  if (counter.fetch + counter.sse > LIMIT) return Promise.reject(new Error('request budget exceeded'));
  return fetch(url, init).then((r) => {
    if (r.status === 429) counter.log.push('  -> 429');
    return r;
  });
}
const esInstances = [];
class CountingEventSource extends EventSource {
  constructor(url) {
    counter.sse++;
    counter.log.push('SSE ' + url.replace(/^https:\/\/ntfy\.sh/, ''));
    super(url);
    esInstances.push(this);
  }
}

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, cond, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error('timeout waiting for ' + what);
}

function client(code, id) {
  const log = { states: [], status: [], taunts: [], presence: [] };
  const room = G.joinRoom({
    code, clientId: id,
    onState: (s, meta) => log.states.push({ s, meta }),
    onStatus: (s) => log.status.push(s),
    onTaunt: (t) => log.taunts.push(t),
    onPresence: (p) => log.presence.push(p),
    options: { fetch: countingFetch, EventSource: CountingEventSource, storage: memStorage(), pingMs: 600000, document: null, window: null },
  });
  return { room, log, id };
}

async function play(mover, others, col) {
  const next = G.applyMove(mover.room.state, col);
  assert.ok(next, 'legal move ' + col);
  assert.equal(await mover.room.propose(next), true, mover.id + ' move ' + col + ' confirmed');
  for (const o of others) await waitFor(o.id + ' sees seq ' + next.seq, () => o.room.confirmed.seq === next.seq);
  return next;
}

(async () => {
  const t0 = Date.now();
  const code = G.newRoomCode();
  console.log('room', G.formatRoomCode(code), 'topic glubschi-gewinnt-' + code);
  const all = [];
  try {
    // 1) A creates the room and takes red
    const A = client(code, 'alice'); all.push(A);
    await waitFor('A live', () => A.room.status === 'live');
    assert.equal(A.log.states[0].meta.source, 'history');
    const s1 = G.withSeat(A.room.state, 1, { id: 'alice', name: 'Alice' });
    assert.equal(await A.room.propose(s1), true);
    console.log('ok  A created room, seq 1 confirmed');
    await sleep(1500); // let ntfy.sh flush its cache batch

    // 2) B joins and sees the room via history, takes yellow
    const B = client(code, 'bob'); all.push(B);
    await waitFor('B live', () => B.room.status === 'live');
    assert.equal(B.log.states[0].meta.source, 'history');
    assert.equal(B.log.states[0].s.seq, 1);
    assert.equal(B.log.states[0].s.players['1'].name, 'Alice');
    const s2 = G.withSeat(B.room.state, 2, { id: 'bob', name: 'Bob' });
    assert.equal(await B.room.propose(s2), true);
    await waitFor('A sees B seated', () => A.room.confirmed.seq === 2);
    console.log('ok  B joined via history and took yellow');

    // 3) alternate moves to a red vertical win in column 0
    for (const [who, col] of [[A, 0], [B, 1], [A, 0], [B, 1], [A, 0], [B, 1], [A, 0]]) {
      await play(who, [A, B].filter((x) => x !== who), col);
    }
    assert.equal(A.room.confirmed.winner, 1);
    assert.deepEqual(A.room.confirmed.winLine, [14, 21, 28, 35]);
    assert.deepEqual(A.room.confirmed.score, { '1': 1, '2': 0 });
    assert.deepEqual(A.room.confirmed, B.room.confirmed);
    console.log('ok  red vertical win, both states identical (seq ' + A.room.confirmed.seq + ')');

    // presence: both saw each other's join ping
    assert.ok(B.log.presence.some((p) => 'alice' in p) || A.log.presence.some((p) => 'bob' in p));

    // 4) rematch (yellow starts)
    const r = G.rematch(A.room.state);
    assert.equal(await A.room.propose(r), true);
    await waitFor('B sees rematch', () => B.room.confirmed.round === 2);
    assert.equal(B.room.confirmed.turn, 2);
    console.log('ok  rematch, round 2, yellow starts');

    // 5) B moves, closes; A moves; B rejoins and catches up
    await play(B, [A], 3);
    B.room.close();
    await play(A, [], 3);
    await sleep(1500);
    const B2 = client(code, 'bob'); all.push(B2);
    await waitFor('B2 live', () => B2.room.status === 'live');
    assert.deepEqual(B2.room.confirmed, A.room.confirmed);
    console.log('ok  B closed and rejoined, caught up via history (seq ' + B2.room.confirmed.seq + ')');

    // 6) B2's stream dies; A moves meanwhile; B2 reconnects with since=<lastId>
    const lastId = B2.room.lastId;
    assert.ok(lastId);
    const es = esInstances[esInstances.length - 1];
    const sseBefore = counter.sse;
    es.close();
    es.onerror && es.onerror(new Event('error'));
    assert.equal(B2.room.status, 'reconnecting');
    await play(A, [], 4);
    await waitFor('B2 reconnected', () => B2.room.status === 'live' && counter.sse > sseBefore);
    const reconnectUrl = counter.log.filter((l) => l.startsWith('SSE')).pop();
    assert.ok(reconnectUrl.endsWith('since=' + lastId), reconnectUrl);
    await waitFor('B2 caught up', () => B2.room.confirmed.seq === A.room.confirmed.seq);
    assert.deepEqual(B2.room.confirmed, A.room.confirmed);
    console.log('ok  stream drop: reconnected with since=' + lastId + ' and caught up');

    // 7) simultaneous proposals for the same seq converge
    const base = A.room.state;
    const pa = A.room.propose(G.applyMove(base, 5));
    const pb = B2.room.propose(G.applyMove(B2.room.state, 6));
    const [ra, rb] = await Promise.all([pa, pb]);
    assert.ok(ra !== rb, 'exactly one proposal wins: ' + ra + ' ' + rb);
    await waitFor('converged', () => A.room.confirmed.seq === base.seq + 1 && B2.room.confirmed.seq === base.seq + 1 &&
      JSON.stringify(A.room.state) === JSON.stringify(B2.room.state));
    assert.deepEqual(A.room.confirmed, B2.room.confirmed);
    const loser = ra ? B2 : A;
    assert.equal(loser.log.states[loser.log.states.length - 1].meta.source, 'revert');
    console.log('ok  race for seq ' + (base.seq + 1) + ' converged, winner ' + (ra ? 'A' : 'B') + ', loser got revert');

    // 8) taunt (uncached, live only)
    assert.equal(B2.room.taunt(2, 'Gleich hab ich dich!'), true);
    await waitFor('A gets taunt', () => A.log.taunts.length === 1);
    assert.deepEqual(A.log.taunts[0], { seat: 2, text: 'Gleich hab ich dich!', from: 'bob', fromMe: false });
    console.log('ok  taunt delivered live');
  } catch (e) {
    process.exitCode = 1;
    console.error('FAIL', e && e.stack ? e.stack : e);
  } finally {
    for (const c of all) c.room.close();
    const total = counter.fetch + counter.sse;
    console.log('\nrequests: ' + total + ' (fetch ' + counter.fetch + ', SSE opens ' + counter.sse + '), limit ' + LIMIT + ', ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
    console.log(counter.log.map((l) => '  ' + l).join('\n'));
    if (total > LIMIT) process.exitCode = 1;
    console.log(process.exitCode ? 'NETWORK TEST FAILED' : 'NETWORK TEST PASSED');
  }
})();
