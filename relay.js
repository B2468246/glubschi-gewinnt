/*!
 * Glubschi gewinnt - relay.js
 * Multiplayer sync layer (DOM-light) on top of the public ntfy.sh pub/sub server.
 * Classic browser script, plain ES2019, no modules. Defines window.GlubschiNet
 * (and module.exports for node tests).
 *
 * ============================================================================
 * PURE HELPERS
 * ----------------------------------------------------------------------------
 * GlubschiNet.config                  { base, ntfy, topicPrefix } (mutable)
 *     base: 'https://b2468246.github.io/glubschi-gewinnt/'  (used by roomUrl)
 *     ntfy: 'https://ntfy.sh'                               (default server)
 * GlubschiNet.newRoomCode()           -> 10 chars of "abcdefghjkmnpqrstuvwxyz23456789"
 *                                        (crypto.getRandomValues, unbiased)
 * GlubschiNet.normalizeRoomCode(x)    -> code (lower case) or null. Accepts a bare
 *                                        code in any case with spaces/dashes
 *                                        ("K7MP-2QXA-9D") or any URL/text that
 *                                        contains "raum=<code>".
 * GlubschiNet.formatRoomCode(code)    -> "K7MP-2QXA-9D"
 * GlubschiNet.roomUrl(code)           -> config.base + "?raum=" + code
 * GlubschiNet.blankState()            -> fresh state (see STATE)
 * GlubschiNet.sanitizeState(raw)      -> deep-copied, validated state or null
 * GlubschiNet.applyMove(state, col)   -> next state or null (game over, full
 *                                        column, bad col, invalid state)
 * GlubschiNet.rematch(state)          -> next state (board cleared, round+1,
 *                                        starter flips, turn = starter)
 * GlubschiNet.withSeat(state, seat, {id, name}) -> next state or null
 * GlubschiNet.withoutSeat(state, seat)          -> next state or null
 * GlubschiNet.resetAll(state)         -> blankState() with seq = state.seq + 1
 * GlubschiNet.winLines(board, player) -> array of runs (each an array of cell
 *                                        indices, 4 or more) for that player
 * GlubschiNet.cleanText(text, max)    -> text with control/bidi/zero-width chars
 *                                        stripped, whitespace collapsed,
 *                                        trimmed, cut to max code points
 * All helpers that return a "next state" are pure (input is never mutated) and
 * bump seq by exactly 1, so the result can be passed straight to room.propose.
 *
 * STATE
 * { v:1, seq:0, board:[42 x 0|1|2] (row-major, row 0 = top, 7 columns),
 *   turn:1|2, starter:1|2, winner:0|1|2|3 (0 none, 1 red, 2 yellow, 3 draw),
 *   winLine:[cell indices of every 4+ run of the winner], last:-1|0..41,
 *   round:1.., players:{"1":{id,name}|null, "2":{id,name}|null},
 *   score:{"1":n, "2":n} }
 * turn always flips after a move, also on the winning move (so piece counts
 * always determine turn). Names: max 20 chars; ids: [A-Za-z0-9_-]{1,64}.
 *
 * ============================================================================
 * ROOM
 * ----------------------------------------------------------------------------
 * var room = GlubschiNet.joinRoom({ code, clientId, onState, onTaunt,
 *                                   onPresence, onStatus, options });
 *   code      room code (anything normalizeRoomCode accepts). Throws if invalid.
 *   clientId  [A-Za-z0-9_-]{1,64}; generated if missing/invalid (room.clientId).
 *   onState(state, meta)  meta = { source, fromMe }
 *       source 'history'    once after the initial load (always fires, even for
 *                           an empty room with seq 0)
 *              'live'       a newer state arrived in real time (also the echo
 *                           that confirms your own optimistic state, fromMe true)
 *              'catchup'    newer state(s) found while catching up (poll after a
 *                           resync, stream replay after a reconnect, messages
 *                           older than ~10 s). Fires once per batch with the
 *                           final state: show it without drop animations/sounds.
 *              'optimistic' your propose() was applied locally
 *              'restore'    your saved state (storage) is newer than the server
 *                           history (e.g. the 12 h cache expired) and is being
 *                           republished
 *              'revert'     your optimistic state lost (someone else was first,
 *                           or publishing failed); state = what to show now
 *   onTaunt({ seat, text, from, fromMe })   live taunts only (never history)
 *   onPresence({ clientId: lastSeenMs })   other clients only; lastSeenMs is
 *                           the (server) time of their newest message, so a
 *                           catch-up of old messages does not look like "online"
 *   onStatus('loading'|'live'|'reconnecting'|'offline'|'ratelimited'|'quota')
 *       'quota' = ntfy.sh's daily message quota for this IP (250 messages per
 *       day, shared by everyone on the same Wi-Fi) is used up: reading still
 *       works, publishing fails at once (no retry loop) until a probe 30 min
 *       later succeeds.
 *   options (all optional, inject for tests):
 *     base 'https://ntfy.sh', fetch, EventSource,
 *     pingMs 300000  minimum gap between presence pings. Pings are sent only on
 *                    join, on becoming visible and as a reply to a newcomer's
 *                    ping (max 1 per 10 s per newcomer, 1 per 2 s and 20
 *                    per hour overall), never periodically (each one counts
 *                    against the daily message quota).
 *     storage (localStorage-like or null), now () => ms, document, window,
 *     timers { setTimeout, clearTimeout }  (extension: fake timers in tests)
 *     random () => [0,1)                   (extension: jitter source)
 *     staleMs 100000  (extension: SSE silent this long -> reconnect)
 *     echoMs 8000     (extension: own echo missing this long -> reconnect the
 *                     stream, then again with backoff while it stays missing)
 * Callbacks are called asynchronously (never during joinRoom itself) and with
 * deep copies; exceptions thrown by callbacks are swallowed.
 *
 * room.code, room.clientId, room.topic
 * room.state        what to display: newest pending optimistic state, else
 *                   confirmed (a copy)
 * room.confirmed    last confirmed state (a copy)
 * room.status       current status string
 * room.loaded       true after the initial history load
 * room.presence     copy of { clientId: lastSeenMs }
 * room.lastId       ntfy id used for since= (debug)
 * room.propose(next) -> Promise<boolean>. Requires next to be a legal
 *                   successor of room.state, i.e. the result of applyMove,
 *                   rematch, resetAll, withSeat or withoutSeat on room.state
 *                   (else resolves false immediately, nothing published).
 *                   Applies optimistically, publishes, resolves true when its
 *                   own echo is accepted from the server stream, false when
 *                   superseded (onState 'revert') or when publishing failed
 *                   (onState 'revert'). Proposals may be chained (seq+1 on top
 *                   of a pending one); a chained proposal is only sent after
 *                   its parent was confirmed, so the promise is final.
 * room.taunt(seat, text) -> boolean (false if dropped: invalid, not loaded,
 *                   or client-side throttle of 1 per 1.5 s / 2 queued).
 * room.resync()     -> Promise. Catch up via poll since lastId and reconnect
 *                   the stream now if it is not live. Coalesced (max 1 poll per
 *                   3 s, none while rate limited).
 * room.close()      stops everything; no callbacks afterwards.
 *
 * ============================================================================
 * PROTOCOL
 * ----------------------------------------------------------------------------
 * Topic "glubschi-gewinnt-" + code on ntfy. Published body (JSON, < 3 KB):
 *   { v:1, k:'s'|'t'|'p', f:clientId, n:nonce, s?:state, t?:{seat,text},
 *     r?:1 (state is a restore), re?:1 (ping is a reply) }
 *   's' state (stored in the 12 h history), 't' taunt and 'p' presence ping
 *   (not stored: published with "?cache=no", the query-param form of the
 *   "Cache: no" header, which keeps the POST a CORS simple request and so
 *   avoids a preflight request per taunt/ping in browsers). Uncached messages
 *   still count against ntfy.sh's daily quota of 250 messages per IP.
 * Acceptance (deterministic, all clients see the same server order). A state
 * envelope counts only if it was cached (msg.expires present) and passes
 * sanitizeState. Then it is accepted iff
 *   - it is a legal successor of confirmed (seq + 1 and equal to applyMove /
 *     rematch / resetAll of confirmed, or the same game with only the seats
 *     changed); first arrival wins for equal seq, or
 *   - it is a restore (r:1) with seq >= confirmed.seq, different from
 *     confirmed and at most 100000 above it, or
 *   - during the initial history load only: it is the first state on top of
 *     the blank start (seq <= 100000).
 * A rejected non-restore state with a higher seq means this client missed
 * something: one full re-read of the history (since=all, max 1 per 30 s)
 * repairs it. A restore below the own confirmed state is answered once per
 * session by republishing the own confirmed state as a restore, so every
 * client converges on the highest saved state. Messages are deduped by ntfy id.
 * Join: read the saved state, poll /json?poll=1&since=all, then restore the
 * saved state if it is newer than the history, then SSE
 * /sse?since=<lastId|all>. The join presence ping is sent once that stream
 * is open (at the latest 5 s later), so the uncached replies reach us.
 * Reconnect: SSE error -> backoff 1,2,4..30 s (+-20 % jitter), since=<lastId>.
 * Coming back to the app after > 5 s in the background always reconnects the
 * stream (a socket killed by the OS often gives no error). A missing own echo
 * also reconnects it (8 s, then doubling up to 60 s while still missing).
 * Every stream open is followed by one catch-up poll (since=<lastId>) 4 s
 * later, because ntfy.sh writes its cache in batches and a message published
 * just before the (re)connect can be missing from the since= replay.
 * lastId only advances on cached messages (uncached ones are not valid since=
 * markers on ntfy).
 * Publish queue: one request at a time; a chained state waits until its parent
 * state was confirmed; network errors / 5xx retried up to 5 times
 * (1,2,4,8,16 s); HTTP 429 code 42908 (daily quota) -> status 'quota', fail at
 * once, no request for 30 min; other 429 -> status 'ratelimited', wait 5 s
 * doubling up to 60 s (shared by every request type), give up after 6
 * consecutive 429s. A state whose echo already arrived is never retried.
 * Pings/taunts expire after 20 s in the queue. Every retry path goes through a
 * timer, so no code path loops without delay.
 * Storage key "glubschi-room-" + code holds the last confirmed state.
 * ============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object' && typeof window !== 'undefined' && root === window) root.GlubschiNet = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var ROWS = 6;
  var COLS = 7;
  var CELLS = ROWS * COLS;
  var ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
  var CODE_LEN = 10;
  var ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var NONCE_RE = /^[A-Za-z0-9_-]{1,32}$/;
  var NAME_MAX = 20;
  var NAME_RAW_MAX = 200;
  var TAUNT_MAX = 80;
  var MAX_BODY = 3000;
  var MAX_INT = 1000000000;
  var MAX_SCORE = 1000000;
  var SEEN_MAX = 1000;
  var PRESENCE_MAX = 16;
  var MAX_NET_RETRIES = 5;
  var MAX_429 = 6;
  var MAX_JUMP = 100000;           // largest seq jump of a non-successor state
  var QUOTA_CODE = 42908;          // ntfy: daily message quota reached
  var QUOTA_MS = 30 * 60000;       // no publish attempt for this long after 42908
  var REBASE_GAP = 30000;          // min gap between full history re-reads
  var CATCHUP_AGE = 10000;         // older SSE messages count as catch-up
  var HIDDEN_RECONNECT_MS = 5000;  // background longer -> reconnect the stream
  var REPLY_PER_CLIENT_MS = 10000; // presence replies: min gap per newcomer (a quick reload counts too),
  var REPLY_GAP_MS = 2000;         //   min gap overall,
  var REPLY_HOUR_MAX = 20;         //   max per rolling hour
  var DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
  // control chars, soft hyphen, bidi marks/embeddings/isolates, zero width
  // space/no-break, line/paragraph separators, word joiner, invisible
  // operators, BOM, hangul fillers. Keeps ZWJ/ZWNJ and variation selectors
  // so emoji sequences survive.
  var STRIP_RE = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u115F\\u1160\\u180E\\u200B\\u200E\\u200F\\u2028-\\u202E\\u2060-\\u206F\\u3164\\uFEFF\\uFFA0\\uFFF9-\\uFFFB]', 'g');

  var config = {
    base: 'https://b2468246.github.io/glubschi-gewinnt/',
    ntfy: 'https://ntfy.sh',
    topicPrefix: 'glubschi-gewinnt-'
  };

  // ---------------------------------------------------------------- utils
  function isInt(x) {
    return typeof x === 'number' && isFinite(x) && Math.floor(x) === x;
  }
  function isObj(x) {
    return !!x && typeof x === 'object' && !Array.isArray(x);
  }
  function has(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }
  function clone(x) {
    return x == null ? x : JSON.parse(JSON.stringify(x));
  }
  function getCrypto() {
    if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues) return globalThis.crypto;
    if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) return window.crypto;
    return null;
  }
  function randomChars(n, alphabet) {
    var out = '';
    var c = getCrypto();
    var limit = 256 - (256 % alphabet.length);
    while (out.length < n) {
      var buf = new Uint8Array(n * 2 + 8);
      if (c) c.getRandomValues(buf);
      else for (var j = 0; j < buf.length; j++) buf[j] = Math.floor(Math.random() * 256);
      for (var i = 0; i < buf.length && out.length < n; i++) {
        if (buf[i] < limit) out += alphabet.charAt(buf[i] % alphabet.length);
      }
    }
    return out;
  }

  function cleanText(text, max) {
    if (typeof text !== 'string') return '';
    var s = text.replace(STRIP_RE, '').replace(/\s+/g, ' ').trim();
    var cps = Array.from(s);
    if (cps.length > max) s = cps.slice(0, max).join('').trim();
    return s;
  }

  // ---------------------------------------------------------- room codes
  function newRoomCode() {
    return randomChars(CODE_LEN, ALPHABET);
  }

  function normalizeRoomCode(input) {
    if (typeof input !== 'string' || input.length > 4000) return null;
    var s = input;
    var m = /raum=([^&#\s]*)/i.exec(s);
    if (m) {
      s = m[1];
      try { s = decodeURIComponent(s); } catch (e) { /* keep raw */ }
    }
    s = s.replace(/[\s\-\u2010-\u2015\u2212]/g, '').toLowerCase();
    if (s.length !== CODE_LEN) return null;
    for (var i = 0; i < s.length; i++) {
      if (ALPHABET.indexOf(s.charAt(i)) < 0) return null;
    }
    return s;
  }

  function formatRoomCode(code) {
    var c = normalizeRoomCode(String(code == null ? '' : code)) || String(code == null ? '' : code);
    c = c.toUpperCase();
    if (c.length !== CODE_LEN) return c;
    return c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8);
  }

  function roomUrl(code) {
    var b = String(config.base);
    return b + (b.indexOf('?') >= 0 ? '&' : '?') + 'raum=' + encodeURIComponent(code);
  }

  // ---------------------------------------------------------- game logic
  function blankState() {
    var board = [];
    for (var i = 0; i < CELLS; i++) board.push(0);
    return {
      v: 1, seq: 0, board: board, turn: 1, starter: 1, winner: 0, winLine: [],
      last: -1, round: 1, players: { '1': null, '2': null }, score: { '1': 0, '2': 0 }
    };
  }

  function winLines(board, p) {
    var runs = [];
    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        if (board[r * COLS + c] !== p) continue;
        for (var d = 0; d < DIRS.length; d++) {
          var dr = DIRS[d][0], dc = DIRS[d][1];
          var pr = r - dr, pc = c - dc;
          if (pr >= 0 && pr < ROWS && pc >= 0 && pc < COLS && board[pr * COLS + pc] === p) continue; // not a run start
          var cells = [];
          var rr = r, cc = c;
          while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && board[rr * COLS + cc] === p) {
            cells.push(rr * COLS + cc);
            rr += dr; cc += dc;
          }
          if (cells.length >= 4) runs.push(cells);
        }
      }
    }
    return runs;
  }

  function unionCells(runs) {
    var set = {};
    var out = [];
    for (var i = 0; i < runs.length; i++) {
      for (var j = 0; j < runs[i].length; j++) {
        var x = runs[i][j];
        if (!set[x]) { set[x] = true; out.push(x); }
      }
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  var BAD = {};
  function sanitizePlayer(raw) {
    if (raw === null || raw === undefined) return null;
    if (!isObj(raw)) return BAD;
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return BAD;
    if (typeof raw.name !== 'string' || raw.name.length > NAME_RAW_MAX) return BAD;
    return { id: raw.id, name: cleanText(raw.name, NAME_MAX) };
  }

  function sanitizeState(raw) {
    try {
      if (!isObj(raw)) return null;
      if (raw.v !== 1) return null;
      if (!isInt(raw.seq) || raw.seq < 0 || raw.seq > MAX_INT) return null;
      if (!Array.isArray(raw.board) || raw.board.length !== CELLS) return null;
      var board = [];
      var count = { 1: 0, 2: 0 };
      for (var i = 0; i < CELLS; i++) {
        var v = raw.board[i];
        if (v !== 0 && v !== 1 && v !== 2) return null;
        board.push(v);
        if (v) count[v]++;
      }
      // gravity: no chip above an empty cell (row 0 = top)
      for (var c = 0; c < COLS; c++) {
        for (var r = 0; r < ROWS - 1; r++) {
          if (board[r * COLS + c] !== 0 && board[(r + 1) * COLS + c] === 0) return null;
        }
      }
      if (raw.turn !== 1 && raw.turn !== 2) return null;
      if (raw.starter !== 1 && raw.starter !== 2) return null;
      var starter = raw.starter, other = 3 - starter;
      var diff = count[starter] - count[other];
      if (diff !== 0 && diff !== 1) return null;
      var expectedTurn = diff === 0 ? starter : other;
      if (raw.turn !== expectedTurn) return null;
      var total = count[1] + count[2];
      if (!isInt(raw.last) || raw.last < -1 || raw.last >= CELLS) return null;
      var last = raw.last;
      if (total === 0) {
        if (last !== -1) return null;
      } else {
        if (last < 0) return null;
        if (board[last] !== 3 - raw.turn) return null; // last chip belongs to the last mover
        if (last >= COLS && board[last - COLS] !== 0) return null; // and is the top of its column
      }
      if (!isInt(raw.winner) || raw.winner < 0 || raw.winner > 3) return null;
      if (!Array.isArray(raw.winLine) || raw.winLine.length > CELLS) return null;
      var runs1 = winLines(board, 1), runs2 = winLines(board, 2);
      if (runs1.length && runs2.length) return null;
      var winLine = [];
      var winner = raw.winner;
      if (winner === 0) {
        if (runs1.length || runs2.length) return null;
        if (total === CELLS) return null; // full board must be a draw
      } else if (winner === 3) {
        if (total !== CELLS || runs1.length || runs2.length) return null;
      } else {
        var runs = winner === 1 ? runs1 : runs2;
        if (!runs.length) return null;
        if (board[last] !== winner) return null;
        for (var k = 0; k < runs.length; k++) {
          if (runs[k].indexOf(last) < 0) return null; // a line that existed before the last move
        }
        winLine = unionCells(runs);
      }
      if (!isInt(raw.round) || raw.round < 1 || raw.round > MAX_INT) return null;
      if (!isObj(raw.players)) return null;
      var p1 = sanitizePlayer(raw.players['1']);
      var p2 = sanitizePlayer(raw.players['2']);
      if (p1 === BAD || p2 === BAD) return null;
      if (!isObj(raw.score)) return null;
      var s1 = raw.score['1'], s2 = raw.score['2'];
      if (!isInt(s1) || s1 < 0 || s1 > MAX_SCORE || !isInt(s2) || s2 < 0 || s2 > MAX_SCORE) return null;
      return {
        v: 1, seq: raw.seq, board: board, turn: raw.turn, starter: starter, winner: winner,
        winLine: winLine, last: last, round: raw.round, players: { '1': p1, '2': p2 },
        score: { '1': s1, '2': s2 }
      };
    } catch (e) {
      return null;
    }
  }

  function applyMove(state, col) {
    var s = sanitizeState(state);
    if (!s || s.winner !== 0 || s.seq >= MAX_INT) return null;
    if (!isInt(col) || col < 0 || col >= COLS) return null;
    var row = -1;
    for (var r = ROWS - 1; r >= 0; r--) {
      if (s.board[r * COLS + col] === 0) { row = r; break; }
    }
    if (row < 0) return null;
    var p = s.turn;
    var idx = row * COLS + col;
    s.board[idx] = p;
    s.last = idx;
    var runs = winLines(s.board, p);
    if (runs.length) {
      s.winner = p;
      s.winLine = unionCells(runs);
      s.score[String(p)] = Math.min(MAX_SCORE, s.score[String(p)] + 1);
    } else {
      var filled = 0;
      for (var i = 0; i < CELLS; i++) if (s.board[i]) filled++;
      if (filled === CELLS) s.winner = 3;
    }
    s.turn = 3 - p;
    s.seq += 1;
    return s;
  }

  function rematch(state) {
    var s = sanitizeState(state);
    if (!s || s.seq >= MAX_INT) return null;
    s.board = blankState().board;
    s.round = Math.min(MAX_INT, s.round + 1);
    s.starter = 3 - s.starter;
    s.turn = s.starter;
    s.winner = 0;
    s.winLine = [];
    s.last = -1;
    s.seq += 1;
    return s;
  }

  function seatKey(seat) {
    var n = Number(seat);
    return n === 1 || n === 2 ? String(n) : null;
  }

  function withSeat(state, seat, player) {
    var s = sanitizeState(state);
    var key = seatKey(seat);
    if (!s || !key || s.seq >= MAX_INT) return null;
    var p = sanitizePlayer(player);
    if (p === BAD || p === null) return null;
    s.players[key] = p;
    s.seq += 1;
    return s;
  }

  function withoutSeat(state, seat) {
    var s = sanitizeState(state);
    var key = seatKey(seat);
    if (!s || !key || s.seq >= MAX_INT) return null;
    s.players[key] = null;
    s.seq += 1;
    return s;
  }

  function resetAll(state) {
    var s = sanitizeState(state);
    if (!s || s.seq >= MAX_INT) return null;
    var b = blankState();
    b.seq = s.seq + 1;
    return b;
  }

  // ------------------------------------------------------- state compare
  function sameArr(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function samePlayers(a, b) {
    for (var k = 1; k <= 2; k++) {
      var x = a[String(k)], y = b[String(k)];
      if (x === null || y === null) { if (x !== y) return false; }
      else if (x.id !== y.id || x.name !== y.name) return false;
    }
    return true;
  }
  // a, b: sanitized states
  function sameState(a, b, ignorePlayers) {
    if (!a || !b) return false;
    return a.seq === b.seq && a.turn === b.turn && a.starter === b.starter &&
      a.winner === b.winner && a.last === b.last && a.round === b.round &&
      a.score['1'] === b.score['1'] && a.score['2'] === b.score['2'] &&
      sameArr(a.board, b.board) && sameArr(a.winLine, b.winLine) &&
      (ignorePlayers || samePlayers(a.players, b.players));
  }
  // true iff s (sanitized) is what one of the helpers makes from prev
  // (sanitized): applyMove, rematch, resetAll, or a seat change that leaves
  // everything but the players untouched.
  function isSuccessor(prev, s) {
    if (!prev || !s || s.seq !== prev.seq + 1) return false;
    var seat = clone(prev);
    seat.seq += 1;
    if (sameState(seat, s, true)) return true;
    for (var c = 0; c < COLS; c++) {
      var n = applyMove(prev, c);
      if (n && sameState(n, s)) return true;
    }
    return sameState(rematch(prev), s) || sameState(resetAll(prev), s);
  }

  // ------------------------------------------------------------ envelope
  function parseEnvelope(text) {
    if (typeof text !== 'string' || text.length > 4096 || text.charAt(0) !== '{') return null;
    var e;
    try { e = JSON.parse(text); } catch (err) { return null; }
    if (!isObj(e) || e.v !== 1) return null;
    if (e.k !== 's' && e.k !== 't' && e.k !== 'p') return null;
    if (typeof e.f !== 'string' || !ID_RE.test(e.f)) return null;
    if (typeof e.n !== 'string' || !NONCE_RE.test(e.n)) return null;
    return e;
  }

  function safeLocalStorage() {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    } catch (e) { /* blocked */ }
    return null;
  }

  // ----------------------------------------------------------------- room
  function joinRoom(params) {
    params = params || {};
    var code = normalizeRoomCode(typeof params.code === 'string' ? params.code : '');
    if (!code) throw new Error('GlubschiNet.joinRoom: invalid room code');
    var clientId = (typeof params.clientId === 'string' && ID_RE.test(params.clientId))
      ? params.clientId : 'c' + randomChars(15, ALPHABET);
    var onState = params.onState, onTaunt = params.onTaunt;
    var onPresence = params.onPresence, onStatus = params.onStatus;
    var o = params.options || {};

    var base = String(o.base || config.ntfy).replace(/\/+$/, '');
    var topic = config.topicPrefix + code;
    var topicUrl = base + '/' + topic;
    var storageKey = 'glubschi-room-' + code;
    var pingMs = (typeof o.pingMs === 'number' && o.pingMs >= 1000) ? o.pingMs : 300000;
    var staleMs = (typeof o.staleMs === 'number' && o.staleMs >= 1000) ? o.staleMs : 100000;
    var echoMs = (typeof o.echoMs === 'number' && o.echoMs >= 100) ? o.echoMs : 8000;
    var catchUpMs = 4000;
    var fetchFn = o.fetch || (typeof fetch === 'function' ? function (u, i) { return fetch(u, i); } : null);
    var ES = o.EventSource || (typeof EventSource !== 'undefined' ? EventSource : null);
    var storage = o.storage !== undefined ? o.storage : safeLocalStorage();
    var now = o.now || function () { return Date.now(); };
    var doc = o.document !== undefined ? o.document : (typeof document !== 'undefined' ? document : null);
    var win = o.window !== undefined ? o.window : (typeof window !== 'undefined' ? window : null);
    var timers = o.timers || {};
    var setT = timers.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var clrT = timers.clearTimeout || function (h) { clearTimeout(h); };
    var rnd = o.random || Math.random;

    var closed = false;
    var loaded = false;
    var loadInFlight = false;
    var loadAttempts = 0;
    var loadTimer = 0;
    var status = null;
    var offline = false;
    var rlHits = 0;
    var rlUntil = 0;
    var quotaUntil = 0;

    var confirmed = blankState();
    var pendings = []; // [{state, nonce, resolve, item, restore}]
    var lastId = null;
    var seen = {};
    var seenOrder = [];
    var presence = {};
    var restoredOnce = false;
    var republished = false;
    var savedAtJoin = readSaved(); // read before the history load overwrites it
    var historyFromMe = false;

    var es = null;
    var esState = 'closed';
    var esStartedAt = 0;
    var esOpenedAt = 0;
    var lastActivity = 0;
    var reconnectTimer = 0;
    var reconnectAttempts = 0;
    var pollMode = false;
    var everOpen = false;
    var skew = 0;          // server clock (ms) minus local clock (ms)
    var skewKnown = false;
    var hiddenAt = 0;

    var queue = [];
    var busy = false;
    var blocked = null;    // state item waiting for its parent's echo
    var flightSeq = 0;
    var pingQueued = false;
    var joinPingDue = false;
    var lastPingAt = -1e15;
    var lastReplyAt = -1e15;
    var repliedTo = Object.create(null); // clientId -> time of our last presence reply to it
    var replyTimes = [];   // times of our presence replies in the last hour
    var lastTauntAt = -1e15;
    var queuedTaunts = 0;
    var resyncP = null;
    var lastResyncAt = -1e15;
    var rebaseP = null;
    var rebaseTimer = 0;
    var lastRebaseAt = -1e15;
    var batch = null;      // pending 'catchup' emission
    var batchTimer = 0;

    var handles = {};
    var hseq = 0;
    var controllers = [];
    var listeners = [];

    function guard(fn) {
      try { fn(); } catch (e) { try { if (typeof console !== 'undefined') console.error('[GlubschiNet]', e); } catch (e2) { /* ignore */ } }
    }
    function call(cb, a, b) {
      if (closed || typeof cb !== 'function') return;
      try { cb(a, b); } catch (e) { /* never let UI errors break the relay */ }
    }
    function later(ms, fn) {
      if (closed) return 0;
      var key = ++hseq;
      handles[key] = setT(function () {
        delete handles[key];
        if (!closed) guard(fn);
      }, Math.max(0, Math.round(ms || 0)));
      return key;
    }
    function cancel(key) {
      if (key && has(handles, key)) {
        clrT(handles[key]);
        delete handles[key];
      }
    }
    function backoff(n, cap) {
      var d = Math.min(cap || 30000, 1000 * Math.pow(2, Math.max(0, n)));
      return d * (0.8 + 0.4 * rnd());
    }
    function gateDelay() {
      return Math.max(0, rlUntil - now());
    }
    function readSaved() {
      if (!storage) return null;
      try {
        var raw = storage.getItem(storageKey);
        return raw ? sanitizeState(JSON.parse(raw)) : null;
      } catch (e) { return null; }
    }

    // ------------------------------------------------------------ status
    function computeStatus() {
      if (offline) return 'offline';
      if (quotaUntil > now()) return 'quota';
      if (rlUntil > now()) return 'ratelimited';
      if (!loaded) return 'loading';
      if (pollMode || esState === 'open') return 'live';
      if (!everOpen && reconnectAttempts === 0) return 'loading'; // first stream still connecting
      return 'reconnecting';
    }
    function updateStatus() {
      if (closed) return;
      var s = computeStatus();
      if (s !== status) {
        status = s;
        call(onStatus, s);
      }
    }
    function onRateLimited() {
      rlHits++;
      var w = Math.min(60000, 5000 * Math.pow(2, rlHits - 1));
      rlUntil = Math.max(rlUntil, now() + w);
      updateStatus();
      later(w + 20, updateStatus);
      return w;
    }
    function onQuota() {
      quotaUntil = now() + QUOTA_MS;
      updateStatus();
      later(QUOTA_MS + 20, updateStatus);
    }
    function onRequestOk() {
      rlHits = 0;
      rlUntil = 0;
      offline = false; // a request just went through
      updateStatus();
    }

    // -------------------------------------------------------------- http
    function timedFetch(url, init, ms) {
      if (!fetchFn) return Promise.reject(new Error('no fetch'));
      var ctrl = null;
      try { ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null; } catch (e) { ctrl = null; }
      if (ctrl) { init.signal = ctrl.signal; controllers.push(ctrl); }
      function forget() {
        var i = controllers.indexOf(ctrl);
        if (i >= 0) controllers.splice(i, 1);
      }
      return new Promise(function (resolve, reject) {
        var done = false;
        var t = later(ms || 20000, function () {
          if (done) return;
          done = true;
          forget();
          try { if (ctrl) ctrl.abort(); } catch (e) { /* ignore */ }
          reject(new Error('timeout'));
        });
        var p;
        try { p = Promise.resolve(fetchFn(url, init)); } catch (e) { p = Promise.reject(e); }
        p.then(function (r) {
          if (done) return;
          done = true; cancel(t); forget();
          resolve(r);
        }, function (e) {
          if (done) return;
          done = true; cancel(t); forget();
          reject(e);
        });
      });
    }

    function httpGet(url) {
      return timedFetch(url, { method: 'GET' }, 20000).then(function (res) {
        if (!res) return { kind: 'error' };
        if (res.status === 429) return { kind: '429' };
        if (!res.ok) return { kind: 'error', status: res.status };
        return Promise.resolve(res.text()).then(function (t) {
          return { kind: 'ok', text: String(t == null ? '' : t) };
        });
      }).catch(function () { return { kind: 'error' }; });
    }

    // ntfy error bodies look like {"code":42908,"http":429,"error":"..."}
    function readErrorCode(res) {
      return Promise.resolve().then(function () {
        return res && typeof res.text === 'function' ? res.text() : '';
      }).then(function (t) {
        var j = JSON.parse(String(t == null ? '' : t).slice(0, 2000));
        return isObj(j) && isInt(j.code) ? j.code : 0;
      }).catch(function () { return 0; });
    }

    // ------------------------------------------------------ message flow
    function markSeen(id) {
      seen[id] = true;
      seenOrder.push(id);
      if (seenOrder.length > SEEN_MAX) delete seen[seenOrder.shift()];
    }

    function displayState() {
      return pendings.length ? pendings[pendings.length - 1].state : confirmed;
    }

    function emitState(s, source, fromMe) {
      call(onState, clone(s), { source: source, fromMe: !!fromMe });
    }

    // 'live' changes are emitted at once; 'catchup'/'rebase' changes are
    // collected and emitted once, with the final state, as 'catchup' (or
    // 'revert' if an own optimistic state was lost on the way).
    function report(mode, kind, fromMe) {
      if (mode === 'live') {
        flushBatch();
        emitState(kind === 'revert' ? displayState() : confirmed, kind, fromMe);
        return;
      }
      if (!batch) batch = { reverted: false, fromMe: false };
      if (kind === 'revert') batch.reverted = true;
      batch.fromMe = !!fromMe;
      if (!batchTimer) batchTimer = later(50, function () { batchTimer = 0; flushBatch(); });
    }
    function flushBatch() {
      cancel(batchTimer);
      batchTimer = 0;
      if (!batch) return;
      var b = batch;
      batch = null;
      if (b.reverted) emitState(displayState(), 'revert', b.fromMe);
      else if (!pendings.length) emitState(confirmed, 'catchup', b.fromMe);
      // else: an own echo was confirmed under further pending states, the
      // displayed state did not change
    }

    function saveConfirmed() {
      if (!storage) return;
      try { storage.setItem(storageKey, JSON.stringify(confirmed)); } catch (e) { /* quota, private mode */ }
    }

    function dropPendingsFrom(index) {
      var dropped = pendings.splice(index);
      var i;
      // mark all first: releasing one pumps the queue, which must already
      // see the others as cancelled
      for (i = 0; i < dropped.length; i++) if (dropped[i].item) dropped[i].item.cancelled = true;
      for (i = 0; i < dropped.length; i++) if (dropped[i].item) release(dropped[i].item);
      return dropped;
    }

    function resolveAll(list, value) {
      for (var i = 0; i < list.length; i++) {
        (function (p) { guard(function () { p.resolve(value); }); })(list[i]);
      }
    }

    function noteServerTime(ev) {
      try {
        var d = ev && typeof ev.data === 'string' ? JSON.parse(ev.data) : null;
        if (isObj(d) && typeof d.time === 'number' && isFinite(d.time) && d.time > 0) {
          skew = d.time * 1000 + 500 - now(); // time is whole seconds
          skewKnown = true;
        }
      } catch (e) { /* ignore */ }
    }
    // local-clock ms of a message (never in the future)
    function msgLocalTime(msg) {
      if (typeof msg.time !== 'number' || !isFinite(msg.time)) return now();
      return Math.min(now(), msg.time * 1000 - skew);
    }

    function touchPresence(f, t) {
      if (!has(presence, f)) {
        var keys = Object.keys(presence);
        if (keys.length >= PRESENCE_MAX) {
          keys.sort(function (a, b) { return presence[a] - presence[b]; });
          delete presence[keys[0]];
        }
      } else if (presence[f] >= t) {
        return;
      }
      presence[f] = t;
      call(onPresence, clone(presence));
    }

    // Acceptance rule (see PROTOCOL). cur, s: sanitized states.
    function acceptable(cur, s, env, anchor) {
      if (!s) return false;
      if (env.r === 1) return s.seq >= cur.seq && s.seq - cur.seq <= MAX_JUMP && !sameState(s, cur);
      if (s.seq <= cur.seq) return false;
      if (isSuccessor(cur, s)) return true;
      return !!anchor && cur.seq === 0 && s.seq <= MAX_JUMP;
    }

    function handleState(env, mode, fromMe) {
      var s = sanitizeState(env.s);
      if (!s) return;
      var head = pendings.length ? pendings[0] : null;
      var isEcho = !!head && fromMe && env.n === head.nonce;
      if (!acceptable(confirmed, s, env, mode === 'history')) {
        if (mode === 'history') return;
        if (isEcho) {
          // own head state was not accepted (should not happen): give it up
          var lost = dropPendingsFrom(0);
          report(mode, 'revert', true);
          resolveAll(lost, false);
        }
        if (mode === 'rebase') return;
        if (env.r === 1) {
          if (s.seq < confirmed.seq && !fromMe) republishConfirmed();
        } else if (s.seq > confirmed.seq) {
          scheduleRebase(); // we probably missed a state
        }
        return;
      }
      confirmed = s;
      if (mode === 'history') {
        historyFromMe = fromMe;
        return; // saved in finishLoad (after the restore decision)
      }
      saveConfirmed();
      if (head) {
        if (isEcho) {
          pendings.shift();
          if (head.item) {
            head.item.cancelled = true; // never retry a confirmed state
            release(head.item);
          }
          if (!pendings.length) report(mode, 'live', true);
          guard(function () { head.resolve(true); });
          kickQueue();
        } else {
          var dropped = dropPendingsFrom(0);
          report(mode, 'revert', fromMe);
          resolveAll(dropped, false);
        }
        return;
      }
      report(mode, 'live', fromMe);
    }

    function handleTaunt(env, msg, fromMe) {
      if (!isObj(env.t)) return;
      var seat = env.t.seat;
      if (seat !== 1 && seat !== 2) return;
      if (typeof env.t.text !== 'string' || env.t.text.length > 1000) return;
      var text = cleanText(env.t.text, TAUNT_MAX);
      if (!text) return;
      if (msgLocalTime(msg) < now() - 600000) return; // stale replay
      call(onTaunt, { seat: seat, text: text, from: env.f, fromMe: fromMe });
    }

    // mode: 'history' (initial load), 'live' (stream), 'catchup' (poll or
    // stream replay), 'rebase' (full re-read: states only, dupes allowed)
    function handleMessage(msg, mode) {
      if (!isObj(msg) || msg.event !== 'message') return;
      var id = msg.id;
      if (typeof id !== 'string' || !ID_RE.test(id)) return;
      if (msg.topic !== undefined && msg.topic !== topic) return;
      var dup = has(seen, id);
      if (dup && mode !== 'rebase') return;
      if (!dup) markSeen(id);
      // only cached messages are usable as since= markers, and only cached
      // states are in everyone's history. ntfy omits "expires" for uncached
      // messages.
      var cached = typeof msg.expires === 'number';
      if (cached) lastId = id;
      var env = parseEnvelope(msg.message);
      if (!env) return;
      var fromMe = env.f === clientId;
      if (mode === 'rebase') {
        if (env.k === 's' && cached) handleState(env, mode, fromMe);
        return;
      }
      if (mode === 'live' && skewKnown) {
        var t = msg.time * 1000 - skew;
        if (t < esOpenedAt - 2000 || t < now() - CATCHUP_AGE) mode = 'catchup'; // stream replay
      }
      if (mode !== 'history' && !fromMe) touchPresence(env.f, msgLocalTime(msg));
      if (env.k === 's') {
        if (cached) handleState(env, mode, fromMe);
      } else if (env.k === 't') {
        if (mode !== 'history') handleTaunt(env, msg, fromMe);
      } else if (mode === 'live' && !fromMe && env.re !== 1) {
        replyPing(env.f); // a newcomer: let them know we are here
      }
    }

    function parseLines(text) {
      var out = [];
      var lines = String(text).split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch (e) { /* skip */ }
      }
      return out;
    }

    function processLines(text, mode) {
      var list = parseLines(text);
      for (var i = 0; i < list.length; i++) {
        (function (obj) { guard(function () { handleMessage(obj, mode); }); })(list[i]);
      }
    }

    // -------------------------------------------------------------- load
    function load() {
      if (closed || loaded || loadInFlight) return;
      loadTimer = 0;
      updateStatus();
      var gd = gateDelay();
      if (gd > 0) {
        loadTimer = later(gd, load);
        return;
      }
      loadInFlight = true;
      httpGet(topicUrl + '/json?poll=1&since=all').then(function (res) {
        loadInFlight = false;
        if (closed || loaded) return;
        if (res.kind === 'ok') {
          onRequestOk();
          processLines(res.text, 'history');
          finishLoad();
          return;
        }
        var wait = res.kind === '429' ? onRateLimited() : backoff(loadAttempts++);
        loadTimer = later(wait, load);
      });
    }

    function finishLoad() {
      loaded = true;
      emitState(confirmed, 'history', historyFromMe);
      if (!maybeRestore() && confirmed.seq > 0) saveConfirmed();
      connectSSE();
      // The join ping goes out once the stream is open: replies to it are
      // uncached, so a reply that beats our own subscription would be lost
      // and an opponent who is right here would look gone.
      joinPingDue = true;
      if (pollMode) sendJoinPing(); else later(5000, sendJoinPing);
      later(30000, watchdog);
      updateStatus();
    }

    // Republish the saved state when it is newer than what the server still
    // has (12 h cache expired, or someone restored an older state first).
    function maybeRestore() {
      var saved = savedAtJoin;
      savedAtJoin = null;
      if (restoredOnce) return false;
      restoredOnce = true;
      if (!saved || saved.seq <= confirmed.seq || saved.seq - confirmed.seq > MAX_JUMP) return false;
      publishState(saved, 'restore', function () { /* nobody waits */ });
      return true;
    }

    // Someone restored a state older than ours: answer once per session with
    // our confirmed state as a restore, so everybody ends on the newest one.
    function republishConfirmed() {
      if (republished || !loaded || pendings.length || confirmed.seq <= 0) return;
      republished = true;
      var e = envelope('s');
      e.r = 1;
      e.s = clone(confirmed);
      var body = JSON.stringify(e);
      if (body.length > MAX_BODY) return;
      enqueue({ body: body, cache: true, done: function () { /* fire and forget */ } });
    }

    function publishState(s, source, resolve) {
      var e = envelope('s');
      if (source === 'restore') e.r = 1;
      e.s = s;
      var body = JSON.stringify(e);
      if (body.length > MAX_BODY) { resolve(false); return; }
      var settled = false;
      var p = {
        state: s, nonce: e.n, restore: source === 'restore',
        resolve: function (v) { if (!settled) { settled = true; resolve(v); } }
      };
      pendings.push(p);
      emitState(s, source, true);
      p.item = {
        body: body, cache: true, pending: p,
        done: function (ok) {
          if (ok) {
            echoCheck(p, 0);
            return;
          }
          var i = pendings.indexOf(p);
          if (i < 0) return;
          var dropped = dropPendingsFrom(i);
          flushBatch();
          emitState(displayState(), 'revert', false);
          resolveAll(dropped, false);
        }
      };
      enqueue(p.item);
    }

    // The POST went through but the echo is missing: the stream is probably
    // dead without an error. Reconnect (replays since lastId), again with
    // backoff while the echo stays missing.
    function echoCheck(p, n) {
      later(Math.min(60000, echoMs * Math.pow(2, n)), function () {
        if (pendings.indexOf(p) < 0) return;
        if (ES && !pollMode) forceReconnect();
        else resync();
        echoCheck(p, n + 1);
      });
    }

    // --------------------------------------------------------------- SSE
    function connectSSE() {
      if (closed || !loaded || es) return;
      cancel(reconnectTimer);
      reconnectTimer = 0;
      if (!ES) {
        if (!pollMode) {
          pollMode = true;
          updateStatus();
          pollLoop();
        }
        return;
      }
      var gd = gateDelay();
      if (gd > 0) {
        reconnectTimer = later(gd + 50, function () { reconnectTimer = 0; connectSSE(); });
        return;
      }
      var url = topicUrl + '/sse?since=' + encodeURIComponent(lastId || 'all');
      var src;
      try { src = new ES(url); } catch (e) { scheduleReconnect(); return; }
      var opened = false;
      es = src;
      esState = 'connecting';
      esStartedAt = now();
      lastActivity = now();
      function markOpen() {
        esState = 'open';
        everOpen = true;
        esOpenedAt = now();
        lastActivity = now();
        updateStatus();
        sendJoinPing();
      }
      src.onopen = function (ev) {
        if (es !== src || closed) return;
        // ntfy also sends a named "open" event whose data carries the server
        // time; it lands here too
        noteServerTime(ev);
        lastActivity = now();
        if (opened) return;
        opened = true;
        if (esState !== 'open') markOpen();
        // ntfy.sh writes its message cache in batches, so a message published
        // up to ~1 s before this (re)connect may be missing from the since=
        // replay. One catch-up poll a little later closes that gap.
        later(catchUpMs, function () { if (es === src) resync(); });
      };
      src.onmessage = function (ev) {
        if (es !== src || closed) return;
        lastActivity = now();
        if (esState !== 'open') markOpen();
        var d;
        try { d = JSON.parse(ev && ev.data); } catch (e) { return; }
        guard(function () { handleMessage(d, 'live'); });
      };
      try {
        if (typeof src.addEventListener === 'function') {
          src.addEventListener('keepalive', function (ev) {
            if (es !== src) return;
            lastActivity = now();
            noteServerTime(ev);
          });
        }
      } catch (e) { /* ignore */ }
      src.onerror = function () {
        if (es !== src || closed) return;
        if (esState === 'open' && now() - esOpenedAt >= 20000) reconnectAttempts = 0;
        dropSSE();
        scheduleReconnect();
      };
    }

    function dropSSE() {
      if (es) {
        var s = es;
        es = null;
        esState = 'closed';
        try { s.onopen = null; s.onmessage = null; s.onerror = null; s.close(); } catch (e) { /* ignore */ }
      }
      updateStatus();
    }

    function scheduleReconnect() {
      if (closed || reconnectTimer || es || !ES) return;
      var d = Math.max(backoff(reconnectAttempts), gateDelay() + 50);
      reconnectAttempts = Math.min(reconnectAttempts + 1, 10);
      updateStatus();
      reconnectTimer = later(d, function () { reconnectTimer = 0; connectSSE(); });
    }

    // drop the stream (even if it looks fine) and open a new one now
    function forceReconnect() {
      if (closed || !loaded || !ES || pollMode) return;
      if (es) dropSSE();
      cancel(reconnectTimer);
      reconnectTimer = 0;
      connectSSE();
    }

    function ensureSSE() {
      if (closed || !loaded || !ES) return;
      if (es && esState === 'open' && now() - lastActivity < staleMs) return;
      if (es && esState === 'connecting' && now() - esStartedAt < 15000) return;
      if (es) dropSSE();
      cancel(reconnectTimer);
      reconnectTimer = 0;
      connectSSE();
    }

    function watchdog() {
      later(30000, watchdog);
      if (!es) return;
      if ((esState === 'open' && now() - lastActivity > staleMs) ||
          (esState === 'connecting' && now() - esStartedAt > 30000)) {
        dropSSE();
        scheduleReconnect();
      }
    }

    function pollLoop() {
      later(10000, function () {
        if (isVisible()) resync();
        pollLoop();
      });
    }

    function resync() {
      if (closed) return Promise.resolve();
      if (!loaded) {
        if (!loadInFlight) {
          cancel(loadTimer);
          loadTimer = 0;
          load();
        }
        return Promise.resolve();
      }
      if (resyncP) return resyncP;
      if (now() - lastResyncAt < 3000 || gateDelay() > 0) return Promise.resolve();
      lastResyncAt = now();
      resyncP = httpGet(topicUrl + '/json?poll=1&since=' + encodeURIComponent(lastId || 'all')).then(function (res) {
        resyncP = null;
        if (closed) return;
        if (res.kind === 'ok') {
          onRequestOk();
          // without EventSource the 10 s poll is the live channel
          processLines(res.text, pollMode ? 'live' : 'catchup');
          flushBatch();
        } else if (res.kind === '429') {
          onRateLimited();
        }
        ensureSSE();
      });
      return resyncP;
    }

    // ------------------------------------------------- history re-read
    // A newer state arrived that is not a successor of ours: re-read the
    // whole history once (max 1 per 30 s). If our state is on the chain a
    // newly joining client computes from it, replay from there; otherwise
    // (expired, or we sit on the losing side of a race) adopt that chain's
    // result.
    function scheduleRebase() {
      if (closed || !loaded || rebaseP || rebaseTimer) return;
      var wait = Math.max(0, lastRebaseAt + REBASE_GAP - now(), gateDelay());
      rebaseTimer = later(wait, function () { rebaseTimer = 0; rebase(); });
    }

    function rebase() {
      if (closed || rebaseP) return;
      if (gateDelay() > 0) { scheduleRebase(); return; }
      lastRebaseAt = now();
      rebaseP = httpGet(topicUrl + '/json?poll=1&since=all').then(function (res) {
        rebaseP = null;
        if (closed) return;
        if (res.kind === '429') { onRateLimited(); return; }
        if (res.kind !== 'ok') return;
        onRequestOk();
        guard(function () { applyRebase(parseLines(res.text)); });
        flushBatch();
      });
    }

    function logState(m) {
      if (!isObj(m) || m.event !== 'message' || typeof m.expires !== 'number') return null;
      if (typeof m.id !== 'string' || !ID_RE.test(m.id)) return null;
      if (m.topic !== undefined && m.topic !== topic) return null;
      var env = parseEnvelope(m.message);
      if (!env || env.k !== 's') return null;
      var s = sanitizeState(env.s);
      return s ? { env: env, s: s } : null;
    }

    function applyRebase(list) {
      // what a newly joining client computes from this history
      var cur = blankState();
      var onChain = confirmed.seq === 0;
      var inLog = false;
      var i, x;
      for (i = 0; i < list.length; i++) {
        x = logState(list[i]);
        if (!x) continue;
        if (!inLog && sameState(x.s, confirmed)) inLog = true;
        if (acceptable(cur, x.s, x.env, true)) {
          cur = x.s;
          if (!onChain && sameState(cur, confirmed)) onChain = true;
        }
      }
      if (onChain) {
        // our state is part of it: replay from there (resolves own echoes)
        for (i = 0; i < list.length; i++) {
          (function (m) { guard(function () { handleMessage(m, 'rebase'); }); })(list[i]);
        }
        return;
      }
      for (i = 0; i < list.length; i++) {
        var m = list[i];
        if (isObj(m) && typeof m.id === 'string' && ID_RE.test(m.id) && typeof m.expires === 'number') {
          if (!has(seen, m.id)) markSeen(m.id);
          lastId = m.id;
        }
      }
      // our state lost a race we did not see (it is in the history but not
      // on the chain), or it expired and the history went on without it:
      // take the common result. If it expired and the history is behind us,
      // keep ours.
      if (cur.seq === 0 || sameState(cur, confirmed)) return;
      if (!inLog && cur.seq < confirmed.seq) return;
      confirmed = cur;
      saveConfirmed();
      if (pendings.length) {
        var dropped = dropPendingsFrom(0);
        report('rebase', 'revert', false);
        resolveAll(dropped, false);
      } else {
        report('rebase', 'live', false);
      }
    }

    // ----------------------------------------------------- publish queue
    function enqueue(item) {
      if (closed) return;
      item.tries = 0;
      item.r429 = 0;
      queue.push(item);
      pump();
    }

    function pump() {
      if (busy || closed || !queue.length) return;
      busy = true;
      attempt();
    }

    function finish(ok) {
      var item = queue.shift();
      busy = false;
      if (item) {
        if (blocked === item) blocked = null;
        cancel(item.retryTimer);
        item.retryTimer = 0;
        item.inFlight = false;
        item.token = -1; // ignore a late response
        if (typeof item.done === 'function') guard(function () { item.done(ok); });
      }
      pump();
    }

    // Free the queue slot of a cancelled item now, even if its request is
    // still in flight or waiting for a retry (its outcome no longer matters).
    function release(item) {
      if (!item || !busy || queue[0] !== item) return;
      if (blocked === item || item.inFlight || item.retryTimer) finish(false);
    }

    // the blocked state's parent was confirmed (or dropped): go on
    function kickQueue() {
      if (blocked && queue[0] === blocked) {
        blocked = null;
        attempt();
      }
    }

    function attempt() {
      if (closed) return;
      var item = queue[0];
      if (!item) { busy = false; return; }
      item.retryTimer = 0;
      if (item.cancelled || (item.expires && now() > item.expires) ||
          (item.pending && pendings.indexOf(item.pending) < 0)) { finish(false); return; }
      // a chained state goes out only after its parent's echo was accepted;
      // if the parent loses, this item is cancelled and never sent
      if (item.pending && pendings.indexOf(item.pending) > 0) { blocked = item; return; }
      if (quotaUntil > now()) { finish(false); return; }
      var gd = gateDelay();
      if (gd > 0) { item.retryTimer = later(gd, attempt); return; }
      var token = ++flightSeq;
      item.token = token;
      item.inFlight = true;
      var url = topicUrl + (item.cache ? '' : '?cache=no');
      function current() { return !closed && queue[0] === item && item.token === token; }
      function retryIn(ms) {
        item.inFlight = false;
        item.retryTimer = later(ms, attempt);
      }
      function netRetry() {
        item.tries++;
        if (item.tries > MAX_NET_RETRIES) { finish(false); return; }
        retryIn(backoff(item.tries - 1));
      }
      timedFetch(url, { method: 'POST', body: item.body }, 15000).then(function (res) {
        if (!current()) return;
        if (res && res.status === 429) {
          readErrorCode(res).then(function (errCode) {
            if (!current()) return;
            guard(function () {
              if (errCode === QUOTA_CODE) { onQuota(); finish(false); return; }
              item.r429++;
              var w = onRateLimited();
              if (item.r429 >= MAX_429) { finish(false); return; }
              retryIn(w);
            });
          });
          return;
        }
        if (res && res.ok) { quotaUntil = 0; onRequestOk(); finish(true); return; }
        if (!res || res.status >= 500 || res.status === 408) { netRetry(); return; }
        finish(false); // other 4xx: will never work
      }, function () {
        if (!current()) return;
        netRetry();
      });
    }

    function envelope(k) {
      return { v: 1, k: k, f: clientId, n: randomChars(10, ALPHABET) };
    }

    // ---------------------------------------------------------- presence
    // ntfy.sh allows 250 messages per IP and day (uncached ones included),
    // so presence pings are rare: on join, on becoming visible (max 1 per
    // pingMs) and one reply to each newcomer's ping (see replyPing).
    // Otherwise presence comes from states and taunts.
    function isVisible() {
      try { return !doc || doc.visibilityState !== 'hidden'; } catch (e) { return true; }
    }
    function sendJoinPing() {
      if (!joinPingDue || closed) return;
      joinPingDue = false;
      sendPing(false);
    }
    function sendPing(reply) {
      if (closed || !loaded || pingQueued) return;
      if (!reply && now() - lastPingAt < pingMs) return;
      pingQueued = true;
      lastPingAt = now();
      var e = envelope('p');
      if (reply) e.re = 1;
      enqueue({
        body: JSON.stringify(e), cache: false, expires: now() + 20000,
        done: function () { pingQueued = false; }
      });
    }
    // Every joining client (a reload, the home-screen app next to Safari, a
    // second device) starts without presence data and pings once. Answer
    // each of them, or a player who is right here looks gone to them and
    // they get offered to take over the seat. Bounded, as every message
    // counts against the daily quota of this IP.
    function replyPing(from) {
      var t = now();
      if (t - lastPingAt < 5000 || t - lastReplyAt < REPLY_GAP_MS) return;
      if (has(repliedTo, from) && t - repliedTo[from] < REPLY_PER_CLIENT_MS) return;
      while (replyTimes.length && t - replyTimes[0] > 3600000) replyTimes.shift();
      if (replyTimes.length >= REPLY_HOUR_MAX) return;
      var ids = Object.keys(repliedTo);
      if (ids.length >= PRESENCE_MAX) delete repliedTo[ids[0]];
      repliedTo[from] = t;
      replyTimes.push(t);
      lastReplyAt = t;
      sendPing(true);
    }

    // ------------------------------------------------------ page events
    function listen(target, type, fn) {
      if (!target || typeof target.addEventListener !== 'function') return;
      var h = function () { if (!closed) guard(fn); };
      try { target.addEventListener(type, h); listeners.push([target, type, h]); } catch (e) { /* ignore */ }
    }
    if (!isVisible()) hiddenAt = now();
    listen(doc, 'visibilitychange', function () {
      if (!isVisible()) {
        if (!hiddenAt) hiddenAt = now();
        return;
      }
      var away = hiddenAt ? now() - hiddenAt : 0;
      hiddenAt = 0;
      // after a while in the background the OS has often killed the socket
      // without an error: reconnect (replays since lastId, then a catch-up
      // poll) instead of trusting it
      if (loaded && away > HIDDEN_RECONNECT_MS && ES && !pollMode) forceReconnect();
      else resync();
      sendPing(false);
    });
    listen(win, 'online', function () {
      offline = false;
      updateStatus();
      resync();
    });
    listen(win, 'offline', function () {
      offline = true;
      updateStatus();
    });

    // ------------------------------------------------------------ public
    function propose(next) {
      if (closed || !loaded) return Promise.resolve(false);
      var s = sanitizeState(next);
      if (!s || !isSuccessor(displayState(), s)) return Promise.resolve(false);
      return new Promise(function (resolve) {
        publishState(s, 'optimistic', resolve);
      });
    }

    function taunt(seat, text) {
      if (closed || !loaded) return false;
      var n = Number(seat);
      if (n !== 1 && n !== 2) return false;
      var t = cleanText(text, TAUNT_MAX);
      if (!t) return false;
      if (now() - lastTauntAt < 1500 || queuedTaunts >= 2) return false;
      lastTauntAt = now();
      queuedTaunts++;
      var e = envelope('t');
      e.t = { seat: n, text: t };
      enqueue({
        body: JSON.stringify(e), cache: false, expires: now() + 20000,
        done: function () { queuedTaunts--; }
      });
      return true;
    }

    function close() {
      if (closed) return;
      var dropped = pendings.splice(0);
      if (es) {
        try { es.onopen = null; es.onmessage = null; es.onerror = null; es.close(); } catch (e) { /* ignore */ }
        es = null;
        esState = 'closed';
      }
      closed = true;
      Object.keys(handles).forEach(function (k) { try { clrT(handles[k]); } catch (e) { /* ignore */ } });
      handles = {};
      controllers.splice(0).forEach(function (c) { try { c.abort(); } catch (e) { /* ignore */ } });
      listeners.splice(0).forEach(function (l) { try { l[0].removeEventListener(l[1], l[2]); } catch (e) { /* ignore */ } });
      queue = [];
      blocked = null;
      batch = null;
      for (var i = 0; i < dropped.length; i++) {
        (function (p) { try { p.resolve(false); } catch (e) { /* ignore */ } })(dropped[i]);
      }
    }

    var room = {
      code: code,
      clientId: clientId,
      topic: topic,
      get state() { return clone(displayState()); },
      get confirmed() { return clone(confirmed); },
      get status() { return status; },
      get loaded() { return loaded; },
      get presence() { return clone(presence); },
      get lastId() { return lastId; },
      propose: propose,
      taunt: taunt,
      resync: resync,
      close: close
    };

    Promise.resolve().then(function () {
      if (closed) return;
      if (win && win.navigator && win.navigator.onLine === false) offline = true;
      updateStatus();
      load();
    });

    return room;
  }

  return {
    config: config,
    ROWS: ROWS,
    COLS: COLS,
    newRoomCode: newRoomCode,
    normalizeRoomCode: normalizeRoomCode,
    formatRoomCode: formatRoomCode,
    roomUrl: roomUrl,
    blankState: blankState,
    sanitizeState: sanitizeState,
    applyMove: applyMove,
    rematch: rematch,
    withSeat: withSeat,
    withoutSeat: withoutSeat,
    resetAll: resetAll,
    winLines: winLines,
    cleanText: cleanText,
    joinRoom: joinRoom
  };
});
