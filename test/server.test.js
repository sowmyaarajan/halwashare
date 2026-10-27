/* Server integration tests: `npm test`.
   Each test connects from its own fake client IP (via X-Forwarded-For,
   trusted because TRUST_PROXY is set) so rate limits do not leak
   between tests. */

process.env.TRUST_PROXY = '1';
process.env.ROOM_GRACE_MS = '300';
process.env.MAX_ROOMS = '40';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const WebSocket = require('ws');
const { start, server, io, rooms, CODE_LENGTH, targetBacklog } = require('../server');

let base;
let ipSeq = 0;
const open = [];

test.before(async () => {
  await start(0);
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(() => {
  open.forEach(s => s.close());
  io.close();
  server.close();
});

function client(opts) {
  const o = opts || {};
  const headers = { 'x-forwarded-for': o.ip || ('10.9.' + (++ipSeq >> 8) + '.' + (ipSeq & 255)) };
  if (o.origin) headers.origin = o.origin;
  const s = connect(base, { forceNew: true, transports: ['websocket'], extraHeaders: headers, reconnection: false });
  open.push(s);
  return s;
}

const connected = (s) => new Promise((resolve, reject) => {
  if (s.connected) return resolve(s);
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
});

const call = (s, event, arg) => new Promise((resolve) => {
  if (arg === undefined) s.emit(event, resolve);
  else s.emit(event, arg, resolve);
});

const next = (s, event, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timed out waiting for ' + event)), ms || 1500);
  s.once(event, (v) => { clearTimeout(t); resolve(v); });
});

const silent = (s, event, ms) => new Promise((resolve, reject) => {
  const fail = () => reject(new Error('unexpected ' + event));
  s.once(event, fail);
  setTimeout(() => { s.off(event, fail); resolve(); }, ms || 300);
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* Two people in a fresh room. */
async function pair() {
  const ip = '10.8.0.' + (++ipSeq & 255);
  const a = await connected(client({ ip }));
  const b = await connected(client({ ip }));
  const { code } = await call(a, 'room:create');
  const ja = await call(a, 'room:join', { code, clientId: 'alice' + ipSeq });
  const jb = await call(b, 'room:join', { code, clientId: 'bob' + ipSeq });
  return { a, b, code, ja, jb };
}

test('creates ' + CODE_LENGTH + '-digit codes and lets a second device join', async () => {
  const a = await connected(client());
  const b = await connected(client());
  const { code } = await call(a, 'room:create');
  assert.match(code, /^\d{6}$/);
  assert.deepEqual(await call(b, 'room:check', { code }), { ok: true });
  const j = await call(b, 'room:join', { code, clientId: 'phone1' });
  assert.equal(j.label, 'User 1');
});

test('chat reaches the other person', async () => {
  const { a, b } = await pair();
  const got = next(b, 'chat:message');
  a.emit('chat:message', { text: 'hello' });
  assert.equal((await got).text, 'hello');
});

test('rejects malformed codes and ids', async () => {
  const a = await connected(client());
  for (const code of ['1234', 'abcdef', '__proto__', 123456, null, { $gt: '' }]) {
    const r = await call(a, 'room:check', { code });
    assert.ok(r.error, 'expected error for ' + JSON.stringify(code));
  }
  const { code } = await call(a, 'room:create');
  const r = await call(a, 'room:join', { code, clientId: '<script>' });
  assert.ok(r.error);
});

test('guessing codes is rate limited per IP', async () => {
  const ip = '10.7.7.7';
  const a = await connected(client({ ip }));
  let limited = 0;
  for (let i = 0; i < 30; i++) {
    const r = await call(a, 'room:check', { code: String(100000 + i) });
    if (/Too many/.test(r.error)) limited++;
  }
  assert.ok(limited >= 10, 'only ' + limited + ' of 30 guesses were limited');

  // A fresh socket from the same IP is still limited — reconnecting does not reset it.
  const b = await connected(client({ ip }));
  assert.match((await call(b, 'room:check', { code: '999999' })).error, /Too many/);

  // Nor does prepending a made-up address: only the proxy-added entry counts.
  const spoof = connect(base, {
    forceNew: true, transports: ['websocket'], reconnection: false,
    // A platform header this deployment does not use must be ignored too.
    extraHeaders: { 'x-forwarded-for': '6.6.6.6, ' + ip, 'cf-connecting-ip': '7.7.7.7', 'fly-client-ip': '8.8.8.8' },
  });
  open.push(spoof);
  await connected(spoof);
  assert.match((await call(spoof, 'room:check', { code: '999998' })).error, /Too many/);
});

test('room creation is rate limited per IP', async () => {
  const a = await connected(client({ ip: '10.6.6.6' }));
  const results = [];
  for (let i = 0; i < 15; i++) results.push(await call(a, 'room:create'));
  assert.ok(results.slice(0, 10).every(r => r.code));
  assert.ok(results.slice(10).some(r => /Too many/.test(r.error)));
});

test('total rooms are capped and abandoned rooms expire', async () => {
  for (const k of Object.keys(rooms)) delete rooms[k];
  let made = 0, refused = null;
  for (let n = 0; n < 6 && !refused; n++) {
    const s = await connected(client());
    for (let i = 0; i < 10; i++) {
      const r = await call(s, 'room:create');
      if (r.code) made++; else { refused = r.error; break; }
    }
  }
  assert.equal(made, 40);
  assert.match(refused, /busy/);
  await sleep(600); // ROOM_GRACE_MS = 300 — nobody joined, so they all go
  assert.equal(Object.keys(rooms).length, 0);
});

test('a room survives its only member refreshing', async () => {
  const a = await connected(client());
  const { code } = await call(a, 'room:create');
  await call(a, 'room:join', { code, clientId: 'solo' });
  a.close();
  await sleep(100);
  const again = await connected(client());
  const j = await call(again, 'room:join', { code, clientId: 'solo' });
  assert.ok(!j.error, j.error);
});

test('only the owner can revoke a file', async () => {
  const { a, b } = await pair();
  const offered = next(b, 'file:offer');
  a.emit('file:offer', { fileId: 'f1', name: 'a.txt', size: 3, type: 'text/plain' });
  await offered;

  const quiet = silent(a, 'file:unavailable');
  b.emit('file:revoke', { fileId: 'f1' });
  await quiet;

  const gone = next(b, 'file:unavailable');
  a.emit('file:revoke', { fileId: 'f1' });
  assert.equal((await gone).fileId, 'f1');
});

test('a file offer cannot be hijacked by reusing its id', async () => {
  const { a, b, code } = await pair();
  const first = next(b, 'file:offer');
  a.emit('file:offer', { fileId: 'same', name: 'real.pdf', size: 10, type: 'application/pdf' });
  await first;
  const quiet = silent(a, 'file:offer');
  b.emit('file:offer', { fileId: 'same', name: 'evil.exe', size: 10, type: '' });
  await quiet;
  assert.equal(rooms[code].history.filter(h => h.fileId === 'same').length, 1);
});

test('signals cannot be sent to sockets outside the room', async () => {
  const { a } = await pair();
  const outsider = await connected(client());
  const quiet = silent(outsider, 'rtc:signal');
  a.emit('rtc:signal', { to: outsider.id, payload: { type: 'offer', sdp: 'x' } });
  await quiet;
});

test('relay keeps chunks and the end marker in order', async () => {
  const { a, b, jb } = await pair();
  const seen = [];
  b.on('relay:chunk', ({ tag }) => seen.push('chunk' + tag));
  b.on('relay:ctrl', ({ msg }) => { if (msg.t === 'end') seen.push('end'); });
  const chunk = Buffer.alloc(128 * 1024);
  for (let i = 0; i < 20; i++) a.emit('relay:chunk', { to: jb.selfId, tag: 1, buf: chunk });
  a.emit('relay:ctrl', { to: jb.selfId, msg: { t: 'end', tag: 1 } });
  for (let i = 0; i < 50 && seen.length < 21; i++) await sleep(50);
  assert.equal(seen.length, 21);
  assert.equal(seen[20], 'end');
});

test('oversized relay frames are dropped', async () => {
  const { a, b, jb } = await pair();
  const quiet = silent(b, 'relay:chunk');
  a.emit('relay:chunk', { to: jb.selfId, tag: 1, buf: Buffer.alloc(300 * 1024) });
  await quiet;
});

test('cross-site connections are refused', async () => {
  const evil = client({ origin: 'https://evil.example' });
  await assert.rejects(connected(evil));
  const good = client({ origin: base });
  await connected(good);
});

test('connections per IP are capped', async () => {
  const ip = '10.5.5.5';
  const socks = [];
  for (let i = 0; i < 30; i++) socks.push(await connected(client({ ip })));
  await assert.rejects(connected(client({ ip })), /Too many connections/);
  socks.forEach(s => s.close());
});

test('pages carry security headers', async () => {
  const res = await fetch(base + '/');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal((await fetch(base + '/api/qr/abc')).status, 400);
  assert.equal((await fetch(base + '/join/1234', { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(base + '/join/123456')).status, 200);
});

/* Speaks the raw Engine.IO/Socket.IO wire protocol, so a test can send
   payloads the official client would refuse to encode. */
function rawClient(ip) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/socket.io/?EIO=4&transport=websocket',
    { headers: { 'x-forwarded-for': ip } });
  const acks = new Map();
  let ackSeq = 0;
  const ready = new Promise((resolve) => {
    ws.on('message', (d) => {
      const m = d.toString();
      if (m.startsWith('0{')) ws.send('40');
      else if (m.startsWith('40')) resolve();
      else if (m === '2') ws.send('3');
      else if (m.startsWith('43')) {
        const id = Number(m.slice(2, m.indexOf('[')));
        const cb = acks.get(id);
        if (cb) { acks.delete(id); cb(JSON.parse(m.slice(m.indexOf('[')))[0]); }
      }
    });
  });
  return {
    ws, ready,
    call: (event, argJson) => new Promise((resolve) => {
      const id = ackSeq++;
      acks.set(id, resolve);
      ws.send('42' + id + '["' + event + '"' + (argJson ? ',' + argJson : '') + ']');
    }),
    send: (event, rawArg) => ws.send('42["' + event + '",' + rawArg + ']'),
  };
}

test('a deeply nested payload cannot crash the server', async () => {
  const r = rawClient('10.4.4.4');
  await r.ready;
  const { code } = await r.call('room:create');
  await r.call('room:join', JSON.stringify({ code, clientId: 'deep1' }));
  const deep = '['.repeat(100000) + ']'.repeat(100000);
  r.send('file:offer', '{"fileId":"abc","name":' + deep + ',"type":' + deep + ',"size":1}');
  r.send('chat:message', '{"text":' + deep + '}');
  r.send('rtc:signal', '{"to":"x","payload":' + deep + '}');
  await sleep(300);
  // Still serving.
  const a = await connected(client());
  assert.match((await call(a, 'room:create')).code, /^\d{6}$/);
  assert.equal(rooms[code].history.some(h => h.fileId === 'abc'), false);
  r.ws.close();
});

test('file offers need real types', async () => {
  const { a, b, code } = await pair();
  const quiet = silent(b, 'file:offer');
  a.emit('file:offer', { fileId: 'n1', name: ['x'], size: 5, type: 'image/png' });
  a.emit('file:offer', { fileId: 'n2', name: 'x.png', size: '5', type: 'image/png' });
  a.emit('file:offer', { fileId: 'n3', name: 'x.png', size: -1, type: 'image/png' });
  a.emit('file:offer', { fileId: 'n4', name: 'x.png', size: 5 });
  await quiet;
  assert.equal(rooms[code].history.filter(h => h.type === 'file').length, 0);
});

test('chat history is capped by bytes', async () => {
  const { a, code } = await pair();
  for (let i = 0; i < 60; i++) {
    a.emit('chat:message', { text: 'x'.repeat(4000) });
    if (i % 15 === 14) await sleep(1000); // stay under the chat rate limit
  }
  await sleep(200);
  const room = rooms[code];
  assert.ok(room.historyBytes <= 128 * 1024 + 5000, 'history holds ' + room.historyBytes + ' bytes');
  assert.ok(room.history.length < 60);
});

test('one address can hold only so many rooms', async () => {
  const ip = '10.3.3.3';
  let last;
  for (let n = 0; n < 2; n++) {
    const s = await connected(client({ ip }));
    for (let i = 0; i < 6; i++) last = await call(s, 'room:create');
  }
  assert.match(last.error, /too many rooms|Too many/);
});

test('the relay stops feeding a receiver that is not reading', async () => {
  const { a, b, jb } = await pair();
  // Stall B at the TCP level: it stays connected but reads nothing.
  b.io.engine.transport.ws._socket.pause();
  const chunk = Buffer.alloc(128 * 1024);
  for (let i = 0; i < 160; i++) a.emit('relay:chunk', { to: jb.selfId, tag: 1, buf: chunk }); // 20 MB
  await sleep(2500);
  const queued = targetBacklog(jb.selfId);
  assert.ok(queued < 12 * 1024 * 1024, 'server buffered ' + (queued / 1048576).toFixed(1) + ' MB for a stalled reader');
  b.io.engine.transport.ws._socket.resume();
});
