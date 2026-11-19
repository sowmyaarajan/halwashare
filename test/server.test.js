/* Server integration tests: `npm test`.
   Each test connects from its own fake client IP (via X-Forwarded-For,
   trusted because TRUST_PROXY is set) so rate limits do not leak
   between tests. */

process.env.TRUST_PROXY = '1';
process.env.NODE_ENV = 'test';
process.env.ROOM_GRACE_MS = '300';
process.env.USER_GRACE_MS = '400';
process.env.MAX_ROOMS = '40';
process.env.GLOBAL_MISSES_PER_MIN = '120';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const WebSocket = require('ws');
const { start, server, io, rooms, CODE_LENGTH, targetBacklog, pushHistory, cleanSubscription, setPushSender } = require('../server');

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

test('the server does not carry or keep chat', async () => {
  const { a, b, code } = await pair();
  const quiet = silent(b, 'chat:message', 300);
  a.emit('chat:message', { text: 'hello' });
  await quiet;
  assert.equal(rooms[code].history.filter(h => h.type === 'chat').length, 0);
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

test('room history is capped by bytes', () => {
  const room = { history: [], historyBytes: 0 };
  for (let i = 0; i < 60; i++) pushHistory(room, { type: 'system', text: 'x'.repeat(4000), ts: i });
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

test('the app is installable: manifest, icons, share target', async () => {
  const res = await fetch(base + '/manifest.webmanifest');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /manifest\+json/);
  const m = await res.json();
  assert.equal(m.display, 'standalone');
  assert.equal(m.share_target.action, '/share-target');
  for (const icon of m.icons) {
    const r = await fetch(base + icon.src);
    assert.equal(r.status, 200, icon.src);
    assert.equal(r.headers.get('content-type'), 'image/png');
  }
  assert.ok(m.icons.some(i => i.purpose === 'maskable'));
  assert.equal((await fetch(base + '/icons/apple-touch-icon.png')).status, 200);
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /rel="manifest"/);
  assert.match(html, /rel="apple-touch-icon"/);
  const share = await fetch(base + '/share-target', { method: 'POST', redirect: 'manual' });
  assert.equal(share.status, 303);
});

test('one IPv6 /64 shares a single guessing budget', async () => {
  const a = await connected(client({ ip: '2001:db8:5:6::1' }));
  for (let i = 0; i < 16; i++) await call(a, 'room:check', { code: String(200000 + i) });
  // Another address in the same /64 — the same household — is already limited...
  const b = await connected(client({ ip: '2001:db8:5:6:ffff:1:2:3' }));
  assert.match((await call(b, 'room:check', { code: '299999' })).error, /Too many/);
  // ...but the next /64 over is someone else.
  const c = await connected(client({ ip: '2001:db8:5:7::1' }));
  assert.deepEqual(await call(c, 'room:check', { code: '299998' }), { error: 'No room with that code. Check the digits and try again.' });
});

test('a dropped connection is "away", not gone, and coming back keeps everything', async () => {
  const ip = '10.71.0.1';
  const a = await connected(client({ ip }));
  const { code } = await call(a, 'room:create', { clientId: 'phone-a-secret-001' });
  const ja = await call(a, 'room:join', { code, clientId: 'phone-a-secret-001' });
  const b = await connected(client({ ip }));
  const jb = await call(b, 'room:join', { code, clientId: 'phone-b-secret-001' });
  a.emit('file:offer', { fileId: 'doc1', name: 'report.pdf', size: 10, type: 'application/pdf' });
  await next(b, 'file:offer');

  // B's connection drops: A sees B away, but no "left" and no lost files.
  const away = next(a, 'room:users');
  const noLeft = silent(a, 'rtc:peer-left', 250);
  b.close();
  const users = await away;
  assert.deepEqual(users.find(u => u.id === jb.selfId), { id: jb.selfId, label: jb.label, away: true });
  await noLeft;

  // B comes back on a new connection: same id, same name, told apart as a return.
  const b2 = await connected(client({ ip }));
  const back = next(a, 'rtc:peer-joined');
  const jb2 = await call(b2, 'room:join', { code, clientId: 'phone-b-secret-001', files: [] });
  assert.equal(jb2.selfId, jb.selfId);
  assert.equal(jb2.label, jb.label);
  assert.deepEqual(await back, { id: jb.selfId, label: jb.label, rejoin: true, fresh: false });
  assert.equal(jb2.history.find(h => h.fileId === 'doc1').available, true);

  // A drops and returns while still holding its file: the file stays offered.
  a.close();
  await sleep(50);
  const a2 = await connected(client({ ip }));
  const ja2 = await call(a2, 'room:join', { code, clientId: 'phone-a-secret-001', files: ['doc1'] });
  assert.equal(ja2.selfId, ja.selfId);
  assert.ok(!jb2.history.some(h => h.type === 'system' && /left/.test(h.text)));

  // Messages reach the person on their new connection.
  const got = next(b2, 'relay:ctrl');
  a2.emit('relay:ctrl', { to: jb.selfId, msg: { t: 'chat-ack', id: 'm1aaaaaaa' } });
  assert.equal((await got).from, ja.selfId);
});

test('someone who stays away is eventually reported as left', async () => {
  const { a, b, ja, jb } = await pair();
  a.emit('file:offer', { fileId: 'pic9', name: 'a.png', size: 5, type: 'image/png' });
  await next(b, 'file:offer');
  const gone = next(b, 'file:unavailable', 2000);
  const left = next(b, 'rtc:peer-left', 2000);
  a.close();
  assert.deepEqual(await left, { id: ja.selfId, label: ja.label });
  assert.deepEqual(await gone, { fileId: 'pic9' });
  void jb;
});

test('a reloaded page loses the files it offered; leaving on purpose is immediate', async () => {
  const ip = '10.72.0.1';
  const a = await connected(client({ ip }));
  const { code } = await call(a, 'room:create');
  await call(a, 'room:join', { code, clientId: 'reload-secret-0001' });
  const b = await connected(client({ ip }));
  await call(b, 'room:join', { code, clientId: 'watcher-secret-001' });
  a.emit('file:offer', { fileId: 'vid1', name: 'v.mp4', size: 9, type: 'video/mp4' });
  await next(b, 'file:offer');

  // Reload: the new page holds no files, so its old offer goes grey.
  const gone = next(b, 'file:unavailable');
  const a2 = await connected(client({ ip }));
  await call(a2, 'room:join', { code, clientId: 'reload-secret-0001', fresh: true, files: [] });
  assert.deepEqual(await gone, { fileId: 'vid1' });

  // The old socket was retired: it is out of the room and its close is not a leave.
  await sleep(100);
  const noLeft = silent(b, 'rtc:peer-left', 600);
  await noLeft;

  // The Leave button: no waiting period.
  const left = next(b, 'rtc:peer-left', 300);
  a2.emit('room:leave');
  await left;
});

test('relayed data follows a receiver that reconnected', async () => {
  const ip = '10.73.0.1';
  const a = await connected(client({ ip }));
  const { code } = await call(a, 'room:create');
  const ja = await call(a, 'room:join', { code, clientId: 'relay-sender-0001' });
  const b = await connected(client({ ip }));
  const jb = await call(b, 'room:join', { code, clientId: 'relay-recver-0001' });
  b.close();
  await sleep(50);
  const b2 = await connected(client({ ip }));
  await call(b2, 'room:join', { code, clientId: 'relay-recver-0001', files: [] });
  const got = next(b2, 'relay:chunk');
  a.emit('relay:chunk', { to: jb.selfId, tag: 3, buf: Buffer.from('hello') });
  const m = await got;
  assert.equal(m.from, ja.selfId);
  assert.equal(Buffer.from(m.buf).toString(), 'hello');
});

// Keep this last: it spends the site-wide budget.
const TOK = (c) => c.repeat(43);
const hello = (s, name, device, tokens, clientId) =>
  s.emit('presence:hello', { name, kind: 'laptop', device, tokens: tokens || [], clientId });

test('devices on the same network see each other; others do not', async () => {
  const ip = '10.7.1.1';
  const a = await connected(client({ ip }));
  const b = await connected(client({ ip }));
  const far = await connected(client({ ip: '10.7.1.2' }));
  const seenA = next(a, 'presence:nearby');
  hello(a, 'Laptop', 'devAaaaaaaaaaaaaaaa');
  await seenA;
  const both = next(a, 'presence:nearby');
  hello(b, '  Phone\u0000‮ ', 'devBbbbbbbbbbbbbbbb');
  const list = await both;
  assert.deepEqual(list.map(d => d.name), ['Phone']);   // cleaned, and not ourselves
  assert.ok(list[0].id && !('device' in list[0]));     // no device id leaks
  const farList = next(far, 'presence:nearby');
  hello(far, 'Elsewhere', 'devCcccccccccccccccc');
  assert.deepEqual(await farList, []);

  // Invite b into a new room; b is told the code, the inviter gets it too.
  const invited = next(b, 'presence:invited');
  const res = await call(a, 'presence:invite', { to: list[0].id, clientId: 'inviterA1' });
  const inv = await invited;
  assert.match(res.code, /^\d{6}$/);
  assert.equal(inv.code, res.code);
  assert.equal(inv.from, 'Laptop');
  assert.equal(inv.token, null);
  // Nobody on another network can be invited by id.
  const r2 = await call(far, 'presence:invite', { to: list[0].id });
  assert.ok(r2.error);
});

test('a hidden device is not listed nearby and cannot be invited by id', async () => {
  const ip = '10.7.5.1';
  const a = await connected(client({ ip }));
  const h = await connected(client({ ip }));
  hello(a, 'Visible', 'devJjjjjjjjjjjjjjjj');
  await sleep(50);
  const own = next(h, 'presence:nearby');
  h.emit('presence:hello', { name: 'Hidden', kind: 'phone', device: 'devKkkkkkkkkkkkkkkk', visible: false });
  assert.deepEqual(await own, []);              // sees nobody
  await silent(a, 'presence:nearby', 200);     // and nobody is told about it
  const again = next(a, 'presence:nearby');
  hello(a, 'Visible', 'devJjjjjjjjjjjjjjjj');
  assert.deepEqual(await again, []);
});

test('paired devices find each other by token, and only the token holder can invite', async () => {
  const a = await connected(client({ ip: '10.7.2.1' }));
  const b = await connected(client({ ip: '10.7.3.1' }));   // different networks
  const x = await connected(client({ ip: '10.7.4.1' }));
  hello(a, 'Laptop', 'devDddddddddddddddd', [TOK('a')]);
  await sleep(50);
  const online = next(a, 'presence:paired');
  hello(b, 'Phone', 'devEeeeeeeeeeeeeeee', [TOK('a')], 'phoneTab1');
  assert.deepEqual(await online, { token: TOK('a'), online: true });

  // Someone without the token cannot use it.
  hello(x, 'Stranger', 'devFfffffffffffffff');
  await sleep(50);
  const bad = await call(x, 'presence:invite', { token: TOK('a') });
  assert.ok(bad.error);

  const invited = next(b, 'presence:invited');
  const res = await call(a, 'presence:invite', { token: TOK('a'), clientId: 'laptopTab1' });
  const inv = await invited;
  assert.equal(inv.token, TOK('a'));
  assert.equal(inv.code, res.code);
  // The invited tab can join and gets its device name as its label.
  const j = await call(b, 'room:join', { code: res.code, clientId: 'phoneTab1', name: 'Phone' });
  assert.equal(j.label, 'Phone');

  // Forgetting tells the other side, and it then shows offline.
  const forgotten = next(b, 'presence:forgotten');
  a.emit('presence:forget', { token: TOK('a') });
  assert.deepEqual(await forgotten, { token: TOK('a') });
});

test('an invite into an existing room only works from inside that room', async () => {
  const { a, code } = await pair();
  const c = await connected(client());
  hello(a, 'Laptop', 'devGgggggggggggggggg', [TOK('g')]);
  hello(c, 'Tablet', 'devHhhhhhhhhhhhhhhh', [TOK('g')]);
  await sleep(80);
  const outsider = await connected(client());
  hello(outsider, 'Out', 'devIiiiiiiiiiiiiiii', [TOK('g')]);
  await sleep(50);
  // Not in that room: refused.
  assert.ok((await call(outsider, 'presence:invite', { token: TOK('g'), code })).error);
  const invited = next(c, 'presence:invited');
  const res = await call(a, 'presence:invite', { token: TOK('g'), code });
  assert.equal(res.code, code);
  assert.equal((await invited).code, code);
});

test('people can rename themselves; names stay unique and the room is told', async () => {
  const { a, b, code } = await pair();
  const told = next(b, 'chat:message');
  const users = next(b, 'room:users');
  const r = await call(a, 'room:rename', { name: '  Sowmya ' });
  assert.equal(r.label, 'Sowmya');
  assert.match((await told).text, / is now Sowmya$/);
  assert.ok((await users).some(u => u.label === 'Sowmya'));
  // b asks for the same name and gets it made unique.
  assert.equal((await call(b, 'room:rename', { name: 'Sowmya' })).label, 'Sowmya 2');
  assert.ok((await call(b, 'room:rename', { name: '   ' })).error);
  // Not in a room: refused.
  const c = await connected(client());
  assert.ok((await call(c, 'room:rename', { name: 'X' })).error);
  assert.ok(rooms[code]);
});

test('device names become room labels, kept unique', async () => {
  const a = await connected(client());
  const b = await connected(client());
  const { code } = await call(a, 'room:create');
  const ja = await call(a, 'room:join', { code, clientId: 'nameA' + ipSeq, name: 'iPhone' });
  const jb = await call(b, 'room:join', { code, clientId: 'nameB' + ipSeq, name: 'iPhone' });
  assert.equal(ja.label, 'iPhone');
  assert.equal(jb.label, 'iPhone 2');
  const c = await connected(client());
  const jc = await call(c, 'room:join', { code, clientId: 'nameC' + ipSeq, name: '   ' });
  assert.equal(jc.label, 'User 1');
});

test('a remembered device that left goes back into the room the other is still in', async () => {
  const a = await connected(client({ ip: '10.7.6.1' }));
  const b = await connected(client({ ip: '10.7.7.1' }));   // different networks
  hello(a, 'Laptop', 'devLlllllllllllllll', [TOK('l')], 'lapTab1');
  hello(b, 'Phone', 'devMmmmmmmmmmmmmmmm', [TOK('l')], 'phnTab1');
  await sleep(80);
  const { code } = await call(a, 'room:create', { clientId: 'lapTab1' });
  await call(a, 'room:join', { code, clientId: 'lapTab1' });
  // b, on its start page, connects: it is sent to a's room, no new room.
  const res = await call(b, 'presence:invite', { token: TOK('l'), clientId: 'phnTab1' });
  assert.equal(res.code, code);
  const j = await call(b, 'room:join', { code, clientId: 'phnTab1', name: 'Phone' });
  assert.equal(j.label, 'Phone');

  // With someone else in the room as well, a remembered device knocks.
  const c = await connected(client({ ip: '10.7.6.9' }));
  hello(c, 'Tablet', 'devQqqqqqqqqqqqqqqq', [TOK('l')], 'tabTab1');
  await sleep(80);
  const knock = next(a, 'presence:knock');
  const r2 = await call(c, 'presence:invite', { token: TOK('l'), clientId: 'tabTab1' });
  assert.equal(r2.waiting, true);
  assert.equal(r2.code, undefined);
  assert.equal((await knock).token, TOK('l'));
  assert.ok(!rooms[code].members.has('tabTab1'));
});

test('a nearby device knocks on a room, and comes in only when let in', async () => {
  const ip = '10.7.8.1';
  const a = await connected(client({ ip }));
  const b = await connected(client({ ip }));
  hello(a, 'Laptop', 'devNnnnnnnnnnnnnnnn', [], 'lapTab2');
  await sleep(50);
  const seen = next(b, 'presence:nearby');
  hello(b, 'Phone', 'devOoooooooooooooooo', [], 'phnTab2');
  const list = await seen;
  const { code } = await call(a, 'room:create', { clientId: 'lapTab2' });
  await call(a, 'room:join', { code, clientId: 'lapTab2' });

  // First knock: declined.
  let knock = next(a, 'presence:knock');
  let res = await call(b, 'presence:invite', { to: list[0].id, clientId: 'phnTab2' });
  assert.equal(res.waiting, true);
  assert.equal(res.code, undefined);         // no code until let in
  let k = await knock;
  assert.equal(k.from, 'Phone');
  const declined = next(b, 'presence:declined');
  a.emit('presence:answer', { kid: k.kid, ok: false });
  assert.equal((await declined).kid, res.kid);
  // An answer cannot be replayed, nor given by someone else.
  const c = await connected(client({ ip }));
  hello(c, 'Other', 'devPpppppppppppppppp');
  await sleep(50);
  c.emit('presence:answer', { kid: k.kid, ok: true });
  await silent(b, 'presence:invited', 200);

  // Second knock: let in, with the room's code.
  knock = next(a, 'presence:knock');
  res = await call(b, 'presence:invite', { to: list[0].id, clientId: 'phnTab2' });
  k = await knock;
  const invited = next(b, 'presence:invited');
  a.emit('presence:answer', { kid: k.kid, ok: true });
  const inv = await invited;
  assert.equal(inv.code, code);
  assert.equal(inv.kid, res.kid);
  assert.ok((await call(b, 'room:join', { code, clientId: 'phnTab2' })).selfId);
});

test('push addresses must belong to a real push service', () => {
  const keys = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };
  const ok = (endpoint) => !!cleanSubscription({ endpoint, keys });
  assert.ok(ok('https://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(ok('https://updates.push.services.mozilla.com/wpush/v2/abc'));
  assert.ok(ok('https://web.push.apple.com/QAbc'));
  assert.ok(ok('https://wns2-par02p.notify.windows.com/w/?token=abc'));
  assert.ok(!ok('http://fcm.googleapis.com/fcm/send/abc'));          // not https
  assert.ok(!ok('https://fcm.googleapis.com.evil.com/x'));
  assert.ok(!ok('https://127.0.0.1/x'));
  assert.ok(!ok('https://fcm.googleapis.com:8443/x'));
  assert.ok(!ok('https://user:pw@fcm.googleapis.com/x'));
  assert.ok(!cleanSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'x', auth: 'y' } }));
});

test('ringing a closed remembered device sends one push with a fresh room', async () => {
  const sent = [];
  let fail = null;
  setPushSender(async (sub, payload, opts) => {
    if (fail) { const e = new Error('push failed'); e.statusCode = fail; throw e; }
    sent.push({ sub, payload: JSON.parse(payload), opts });
  });
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/xyz', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };
  const a = await connected(client({ ip: '10.7.9.1' }));
  hello(a, 'Laptop', 'devRrrrrrrrrrrrrrrr', [TOK('r')], 'lapTab3');
  await sleep(50);
  // Without holding the token: refused, nothing sent.
  assert.ok((await call(a, 'presence:ring', { token: TOK('s'), sub })).error);
  // A made-up address: refused as unusable.
  assert.equal((await call(a, 'presence:ring', { token: TOK('r'), sub: { endpoint: 'https://evil.example/x', keys: sub.keys } })).gone, true);
  assert.equal(sent.length, 0);

  const res = await call(a, 'presence:ring', { token: TOK('r'), sub, clientId: 'lapTab3' });
  assert.match(res.code, /^\d{6}$/);
  assert.ok(rooms[res.code]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].payload, { t: 'ring', code: res.code, from: 'Laptop', kind: 'laptop' });
  assert.equal(sent[0].sub.endpoint, sub.endpoint);
  // The ringer can go straight into the room.
  assert.ok((await call(a, 'room:join', { code: res.code, clientId: 'lapTab3' })).selfId);

  // Ringing again at once: refused.
  const b = await connected(client({ ip: '10.7.9.2' }));
  hello(b, 'Laptop2', 'devSsssssssssssssss', [TOK('r')], 'lapTab4');
  await sleep(50);
  assert.match((await call(b, 'presence:ring', { token: TOK('r'), sub })).error, /moment/);
  assert.equal(sent.length, 1);

  // A dead address is reported so the device can drop it.
  const c = await connected(client({ ip: '10.7.9.3' }));
  hello(c, 'Laptop3', 'devTtttttttttttttttt', [TOK('t')], 'lapTab5');
  await sleep(50);
  fail = 410;
  assert.equal((await call(c, 'presence:ring', { token: TOK('t'), sub })).gone, true);
  setPushSender(async () => {});
});

test('wrong guesses spread over many addresses hit a site-wide cap', async () => {
  // A room someone was already in before the attack starts.
  const host = await connected(client({ ip: '10.67.0.1' }));
  const { code } = await call(host, 'room:create', { clientId: 'creator-secret-0001' });
  const member = await connected(client({ ip: '10.67.0.2' }));
  assert.ok((await call(member, 'room:join', { code, clientId: 'member-secret-00001' })).selfId);
  member.close();

  let busy = 0;
  for (let n = 0; n < 12; n++) {
    const s = await connected(client({ ip: '10.66.' + n + '.1' }));
    for (let i = 0; i < 14; i++) {
      const r = await call(s, 'room:check', { code: String(300000 + n * 100 + i) });
      if (/busy/.test(r.error || '')) busy++;
    }
    s.close();
  }
  assert.ok(busy >= 30, 'only ' + busy + ' of 168 spread-out guesses were refused');

  // The cap is spent, yet the people who belong still get in...
  const back = await connected(client({ ip: '10.67.0.3' }));
  assert.ok((await call(back, 'room:join', { code, clientId: 'member-secret-00001' })).selfId, 'returning member refused');
  const creator = await connected(client({ ip: '10.67.0.4' }));
  assert.ok((await call(creator, 'room:join', { code, clientId: 'creator-secret-0001' })).selfId, 'creator refused');
  // ...while a stranger who has the right code but not a member's id does not.
  const stranger = await connected(client({ ip: '10.67.0.5' }));
  assert.match((await call(stranger, 'room:join', { code, clientId: 'stranger-guess-0001' })).error, /busy/);
});
