'use strict';
// Fake ntfy.sh for local end-to-end tests. Implements exactly the subset that
// relay.js uses, so tests never touch the real (quota-limited) ntfy.sh:
//   POST /<topic>[?cache=no]                 raw body = message; cached ones get "expires"
//   GET  /<topic>/json?poll=1&since=all|<id>|<unix>|<n>s|m|h
//   GET  /<topic>/sse?since=...              named "open" event, unnamed message
//                                            events, named "keepalive" events
//   OPTIONS *                                CORS preflight
// Test knobs (not part of ntfy):
//   POST /__ctl/fail?status=429&code=42901&count=1&method=POST
//        the next <count> matching requests get that status + ntfy-style JSON error
//   POST /__ctl/drop                         close every open SSE stream
//   POST /__ctl/reset                        forget all topics, knobs and the log
//   GET  /__ctl/log                          JSON list of handled requests
//   GET  /__ctl/topics                       JSON { topic: [messages] }
// Usage: node test/fake-ntfy.js [port]   or   require('./fake-ntfy').start(port)

const http = require('node:http');

function start(port = 0, opts = {}) {
  const keepaliveMs = opts.keepaliveMs || 25000;
  const topics = new Map();          // topic -> [msg]  (cached only)
  const streams = new Set();         // { topic, res, timer }
  let failures = [];                 // { status, code, count, method }
  let log = [];
  let counter = 0;

  const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const nowSec = () => Math.floor(Date.now() / 1000);
  // server-ordered ids: lexical order == publish order
  const nextId = () => 'f' + (++counter).toString(36).padStart(11, '0');

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');
  }
  function json(res, status, body) {
    cors(res);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body) + '\n');
  }
  function since(list, param) {
    if (param == null || param === '' || param === 'all') return list.slice();
    if (/^\d+$/.test(param)) {                       // unix timestamp
      const t = Number(param);
      return list.filter((m) => m.time >= t);
    }
    const d = /^(\d+)([smhd])$/.exec(param);       // duration
    if (d) {
      const mult = { s: 1, m: 60, h: 3600, d: 86400 }[d[2]];
      const t = nowSec() - Number(d[1]) * mult;
      return list.filter((m) => m.time >= t);
    }
    const i = list.findIndex((m) => m.id === param); // message id
    return i >= 0 ? list.slice(i + 1) : list.slice();
  }
  function sse(res, event, data) {
    let s = '';
    if (event) s += 'event: ' + event + '\n';
    if (data && data.id && !event) s += 'id: ' + data.id + '\n';
    s += 'data: ' + JSON.stringify(data) + '\n\n';
    res.write(s);
  }
  function takeFailure(method) {
    const f = failures.find((x) => x.count > 0 && (!x.method || x.method === method));
    if (!f) return null;
    f.count--;
    failures = failures.filter((x) => x.count > 0);
    return f;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    const entry = { t: Date.now(), method: req.method, path: url.pathname + url.search };

    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

    // ---- test knobs
    if (parts[0] === '__ctl') {
      if (parts[1] === 'fail') {
        failures.push({
          status: Number(url.searchParams.get('status') || 429),
          code: Number(url.searchParams.get('code') || 42901),
          count: Number(url.searchParams.get('count') || 1),
          method: url.searchParams.get('method') || null
        });
        return json(res, 200, { ok: true, failures });
      }
      if (parts[1] === 'drop') {
        const n = streams.size;
        for (const s of [...streams]) { clearInterval(s.timer); streams.delete(s); s.res.destroy(); }
        return json(res, 200, { dropped: n });
      }
      if (parts[1] === 'reset') {
        topics.clear(); failures = []; log = [];
        for (const s of [...streams]) { clearInterval(s.timer); streams.delete(s); s.res.destroy(); }
        return json(res, 200, { ok: true });
      }
      if (parts[1] === 'log') return json(res, 200, log);
      if (parts[1] === 'topics') return json(res, 200, Object.fromEntries(topics));
      return json(res, 404, { error: 'unknown ctl' });
    }

    log.push(entry);
    const topic = parts[0];
    if (!topic || !TOPIC_RE.test(topic) || parts.length > 2) return json(res, 404, { code: 40401, http: 404, error: 'page not found' });

    const f = takeFailure(req.method);
    if (f) {
      entry.injected = f.status;
      return json(res, f.status, { code: f.code, http: f.status, error: 'injected by fake-ntfy' });
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      if (parts.length !== 1) return json(res, 404, { code: 40401, http: 404, error: 'page not found' });
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const noCache = /^(no|0|false)$/i.test(url.searchParams.get('cache') || req.headers['cache'] || '');
        const msg = { id: nextId(), time: nowSec(), event: 'message', topic, message: body };
        if (!noCache) {
          msg.expires = msg.time + 12 * 3600;
          if (!topics.has(topic)) topics.set(topic, []);
          topics.get(topic).push(msg);
        }
        entry.cached = !noCache;
        for (const s of streams) if (s.topic === topic) sse(s.res, null, msg);
        json(res, 200, msg);
      });
      return;
    }

    if (req.method === 'GET' && parts[1] === 'json') {
      const list = topics.get(topic) || [];
      if (url.searchParams.get('poll') !== '1') return json(res, 400, { error: 'fake-ntfy supports poll=1 only' });
      cors(res);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      res.end(since(list, url.searchParams.get('since')).map((m) => JSON.stringify(m) + '\n').join(''));
      return;
    }

    if (req.method === 'GET' && parts[1] === 'sse') {
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      sse(res, 'open', { id: nextId(), time: nowSec(), event: 'open', topic });
      for (const m of since(topics.get(topic) || [], url.searchParams.get('since'))) sse(res, null, m);
      const s = { topic, res, timer: null };
      s.timer = setInterval(() => sse(res, 'keepalive', { id: nextId(), time: nowSec(), event: 'keepalive', topic }), keepaliveMs);
      streams.add(s);
      req.on('close', () => { clearInterval(s.timer); streams.delete(s); });
      return;
    }

    json(res, 404, { code: 40401, http: 404, error: 'page not found' });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({
        port: p,
        url: 'http://127.0.0.1:' + p,
        log: () => log,
        streams: () => streams.size,
        close: () => new Promise((r) => {
          for (const s of [...streams]) { clearInterval(s.timer); s.res.destroy(); }
          streams.clear();
          server.closeAllConnections && server.closeAllConnections();
          server.close(() => r());
        })
      });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start(Number(process.argv[2]) || 8090).then((s) => console.log('fake ntfy on ' + s.url));
}
