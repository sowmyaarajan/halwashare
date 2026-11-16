/* ── HalwaShare server ─────────────────────────────────────
   The server does three things and nothing more:
     1. serves the static app
     2. relays WebRTC signalling + chat text
     3. relays file bytes ONLY when a direct P2P link fails
   File bytes are never written to disk or buffered per-room.

   It is meant to sit on the public internet, so every socket event is
   validated and rate limited, room codes are long enough not to guess,
   and the total number of rooms is capped. */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 4000;
const MAX_USERS = Number(process.env.MAX_USERS || 5);
// Rooms are held in memory, so the ceilings bound the worst case:
// 500 rooms x 128 KB of history is 64 MB, well inside a 512 MB instance.
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 500);
const MAX_ROOMS_PER_IP = Number(process.env.MAX_ROOMS_PER_IP || 10);
const HISTORY_MAX = 300;
const HISTORY_BYTES = 128 * 1024;
const CODE_LENGTH = 6;
const CODE_RE = new RegExp('^\\d{' + CODE_LENGTH + '}$');
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// An empty room lingers this long so a refresh, a locked phone or a dropped
// connection does not destroy it; a room nobody ever enters goes the same way.
const ROOM_GRACE_MS = Number(process.env.ROOM_GRACE_MS || 120000);

const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP || 30);
const MAX_SIGNAL_BYTES = 64 * 1024;
const MAX_CTRL_BYTES = 4 * 1024;
const MAX_RELAY_CHUNK = 256 * 1024;
// Per sender: up to four receivers x a 4 MB credit window, plus headroom.
const MAX_RELAY_BACKLOG = 32 * 1024 * 1024;
// Per receiver: bytes waiting in its socket before we stop feeding it.
const MAX_TARGET_BACKLOG = 8 * 1024 * 1024;
// Relayed bytes cost the host bandwidth; direct P2P transfers are unaffected.
const RELAY_BYTES_PER_SEC = Number(process.env.RELAY_BYTES_PER_SEC || 16 * 1024 * 1024);

/* Behind Render / Fly / a reverse proxy, the socket address is the proxy's.
   Only then is the forwarded header the real client; trusting it anywhere
   else would let a client pick its own IP and dodge the limits. */
const TRUST_PROXY = !!(process.env.TRUST_PROXY || process.env.RENDER || process.env.FLY_APP_NAME);

/* rooms: code -> { code, users: [{ id, clientId, label }], history: [], expiry } */
const rooms = Object.create(null);

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

/* Null when every code is taken; the caller reports the server as full. */
function generateCode() {
  const min = 10 ** (CODE_LENGTH - 1);
  for (let i = 0; i < 50; i++) {
    const code = String(crypto.randomInt(min, 10 * min));
    if (!rooms[code]) return code;
  }
  return null;
}

function assignLabel(room) {
  const used = new Set(room.users.map(u => u.label));
  for (let i = 1; i <= MAX_USERS; i++) {
    if (!used.has('User ' + i)) return 'User ' + i;
  }
  return null;
}

/* Bounded by count and by bytes, so a chatty room cannot hoard memory. */
function pushHistory(room, entry) {
  entry.bytes = byteSize(entry);
  room.history.push(entry);
  room.historyBytes = (room.historyBytes || 0) + entry.bytes;
  while (room.history.length > HISTORY_MAX ||
         (room.historyBytes > HISTORY_BYTES && room.history.length > 1)) {
    room.historyBytes -= room.history.shift().bytes;
  }
}

function userList(room) {
  return room.users.map(u => ({ id: u.id, label: u.label }));
}

function scheduleExpiry(room) {
  clearTimeout(room.expiry);
  room.expiry = setTimeout(() => {
    if (rooms[room.code] === room && room.users.length === 0) delete rooms[room.code];
  }, ROOM_GRACE_MS);
  if (room.expiry.unref) room.expiry.unref();
}

/* Bytes queued towards a socket but not yet written to the network. */
function targetBacklog(id) {
  const target = io.sockets.sockets.get(id);
  if (!target) return 0;
  const conn = target.conn;
  const ws = conn.transport && conn.transport.socket;
  let n = ws && typeof ws.bufferedAmount === 'number' ? ws.bufferedAmount : 0;
  n += (conn.writeBuffer ? conn.writeBuffer.length : 0) * 128 * 1024; // polling
  return n;
}

/* A socket may only address peers inside its own room. */
function inSameRoom(socket, targetId) {
  const code = socket.data.code;
  const room = code && rooms[code];
  return typeof targetId === 'string' && !!room && room.users.some(u => u.id === targetId);
}

function byteSize(value) {
  try { return Buffer.byteLength(JSON.stringify(value) || ''); } catch { return Infinity; }
}

/* ── Rate limiting ─────────────────────────────────────────────
   Token buckets: `rate` tokens refill per second up to `burst`.
   Keyed per IP for room lookups (the brute-force target) and per
   socket for everything else. */
class Bucket {
  constructor(rate, burst) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.at = Date.now();
  }
  take(cost) {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/* Wrong guesses from everyone together. Per-address limits alone fall to an
   attacker spread over many addresses; this caps the whole site at about
   300 misses a minute, so even a botnet needs days to find one room. While it
   is spent, lookups are refused for everyone — a brief nuisance, where a
   found room would expose people's files. */
const globalMisses = new Bucket(
  Number(process.env.GLOBAL_MISSES_PER_MIN || 300) / 60,
  Number(process.env.GLOBAL_MISSES_PER_MIN || 300));

const LIMITS = {
  create:  [1 / 6, 10],          // ~10 rooms a minute per IP
  lookup:  [1 / 3, 15],          // failed code lookups per IP — the guessing guard
  chat:    [3, 20],
  typing:  [4, 10],
  signal:  [50, 400],            // ICE candidates arrive in bursts
  ctrl:    [100, 400],
  relay:   [RELAY_BYTES_PER_SEC, RELAY_BYTES_PER_SEC * 2], // bytes per socket
  offer:   [2, 20],
  qr:      [1, 20],
  misc:    [20, 60],
};

const ipBuckets = new Map(); // ip -> { kind -> Bucket }, oldest first
const ipConns = new Map();   // ip -> open socket count
const MAX_TRACKED_IPS = 50000;

function ipBucket(ip, kind) {
  let entry = ipBuckets.get(ip);
  if (!entry) {
    // Evict the oldest idle addresses rather than grow without bound.
    for (const [old] of ipBuckets) {
      if (ipBuckets.size < MAX_TRACKED_IPS) break;
      if (!ipConns.get(old)) ipBuckets.delete(old);
    }
    entry = { seen: Date.now() };
    ipBuckets.set(ip, entry);
  }
  entry.seen = Date.now();
  if (!entry[kind]) entry[kind] = new Bucket(...LIMITS[kind]);
  return entry[kind];
}

function socketBucket(socket, kind) {
  const b = socket.data.buckets;
  if (!b[kind]) b[kind] = new Bucket(...LIMITS[kind]);
  return b[kind];
}

// Forget idle IPs so the map cannot grow without bound.
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [ip, entry] of ipBuckets) {
    if (entry.seen < cutoff && !ipConns.get(ip)) ipBuckets.delete(ip);
  }
}, 60 * 1000).unref();

/* Read exactly one header, the one this platform's edge overwrites: Render
   sits behind Cloudflare, Fly sets its own. A header from any other platform
   would pass through untouched from the client, so it is never consulted.
   Without one, take the LAST X-Forwarded-For entry — the one our proxy
   appended. The first entry is whatever the client typed, and trusting it
   would hand every request a fresh rate-limit budget. */
const CLIENT_IP_HEADER = (process.env.CLIENT_IP_HEADER ||
  (process.env.RENDER ? 'cf-connecting-ip' : process.env.FLY_APP_NAME ? 'fly-client-ip' : '')).toLowerCase();

function clientIP(req) {
  if (TRUST_PROXY) {
    const h = req.headers;
    if (CLIENT_IP_HEADER) {
      const v = h[CLIENT_IP_HEADER];
      if (typeof v === 'string' && v) return ipKey(v.trim());
    }
    const fwd = h['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return ipKey(fwd.split(',').pop().trim());
  }
  return ipKey((req.socket && req.socket.remoteAddress) || 'unknown');
}

/* The key every per-address limit is counted against. One home connection or
   phone is handed a whole IPv6 /64 — 18 quintillion addresses — so limiting
   single IPv6 addresses would limit nothing. Count the /64 instead. */
function ipKey(ip) {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1];
  if (!ip.includes(':')) return ip;
  const addr = ip.split('%')[0].toLowerCase();       // drop a zone id
  const [head, tail = ''] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = addr.includes('::') && tail ? tail.split(':') : [];
  const groups = addr.includes('::')
    ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
    : h;
  return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}

/* ── HTTP ──────────────────────────────────────────────────── */
const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', 1);

app.use((req, res, next) => {
  const host = req.headers.host || '';
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "connect-src 'self' ws://" + host + ' wss://' + host,
      "frame-src 'self'",
      "worker-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

app.get('/favicon.ico', (_req, res) => {
  res.type('image/svg+xml').send(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="82">\u{1F36E}</text></svg>'
  );
});

/* The installed app's Share menu posts here. The service worker normally
   answers it on the device; this only catches a share that arrives before
   the worker is running, so the person lands on the app, not an error. */
app.post('/share-target', (_req, res) => res.redirect(303, '/?shared=0'));

app.get('/join/:code', (req, res) => {
  if (!CODE_RE.test(req.params.code)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('/api/qr/:code', async (req, res) => {
  const { code } = req.params;
  if (!CODE_RE.test(code)) return res.status(400).json({ error: 'Bad room code' });
  if (!ipBucket(clientIP(req), 'qr').take(1)) return res.status(429).json({ error: 'Slow down' });
  const base = process.env.PUBLIC_URL || ('http://' + getLocalIP() + ':' + PORT);
  const url = base + '/join/' + code;
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 240, margin: 1 });
    res.json({ qr: dataUrl, url });
  } catch {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

/* ICE servers for the browser. STUN alone fails behind symmetric NAT, so a
   hosted deployment should supply TURN via env vars; peers that still cannot
   connect directly fall back to the relay below. */
app.get('/api/rtc-config', (_req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  if (process.env.TURN_URLS) {
    iceServers.push({
      urls: process.env.TURN_URLS.split(',').map(u => u.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || undefined,
      credential: process.env.TURN_CREDENTIAL || undefined,
    });
  }
  res.set('Cache-Control', 'no-store').json({ iceServers });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

const io = new Server(server, {
  // Relay frames are 128 KB; signalling is a few KB. 1 MB is ample headroom.
  maxHttpBufferSize: 1024 * 1024,
  pingInterval: 20000,
  pingTimeout: 30000,
  // Refuse sockets opened from other websites. Without this any page a
  // visitor opens could drive their browser to create rooms or guess codes.
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    if (!origin) return cb(null, true); // non-browser clients send none
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch { ok = false; }
    cb(ok ? null : 'origin not allowed', ok);
  },
});

/* Limit concurrent connections per IP. */
io.use((socket, next) => {
  const ip = clientIP(socket.request);
  const open = ipConns.get(ip) || 0;
  if (open >= MAX_CONN_PER_IP) return next(new Error('Too many connections'));
  ipConns.set(ip, open + 1);
  socket.data.ip = ip;
  socket.data.buckets = Object.create(null);
  socket.once('disconnect', () => {
    const n = (ipConns.get(ip) || 1) - 1;
    if (n <= 0) ipConns.delete(ip); else ipConns.set(ip, n);
  });
  next();
});

const SLOW_DOWN = 'Too many attempts. Wait a minute and try again.';

io.on('connection', (socket) => {
  const ip = socket.data.ip;
  const allow = (kind, cost) => socketBucket(socket, kind).take(cost || 1);

  /* Every handler runs guarded. One malformed message must cost the sender
     their connection, never take the process — and every room — down. */
  const on = (event, fn) => socket.on(event, (...args) => {
    try {
      fn(...args);
    } catch (err) {
      console.warn('[halwa] dropped bad "' + event + '" from', ip, '-', err && err.message);
      socket.disconnect(true);
    }
  });

  /* A code that misses counts against the IP; one that hits does not, so
     people who know their code are never slowed down. Lookups are refused
     outright once the budget is spent, hit or miss. */
  function lookup(code) {
    if (typeof code !== 'string' || !CODE_RE.test(code)) return { error: 'Room codes are ' + CODE_LENGTH + ' digits.' };
    const bucket = ipBucket(ip, 'lookup');
    bucket.take(0); // refill
    globalMisses.take(0);
    if (bucket.tokens < 1) return { error: SLOW_DOWN };
    if (globalMisses.tokens < 1) return { error: 'HalwaShare is busy. Try again in a minute.' };
    const room = rooms[code];
    if (!room) { bucket.take(1); globalMisses.take(1); }
    return { room };
  }

  on('room:create', (cb) => {
    if (typeof cb !== 'function') return;
    if (!ipBucket(ip, 'create').take(1)) return cb({ error: SLOW_DOWN });
    const codes = Object.keys(rooms);
    if (codes.filter(c => rooms[c].ownerIp === ip).length >= MAX_ROOMS_PER_IP) {
      return cb({ error: 'You have too many rooms open. Close one first.' });
    }
    if (codes.length >= MAX_ROOMS) {
      return cb({ error: 'HalwaShare is busy right now. Please try again in a few minutes.' });
    }
    const code = generateCode();
    if (!code) return cb({ error: 'HalwaShare is busy right now. Please try again in a few minutes.' });
    const room = { code, users: [], history: [], historyBytes: 0, expiry: null, ownerIp: ip };
    rooms[code] = room;
    scheduleExpiry(room);
    cb({ code });
  });

  on('room:check', (arg, cb) => {
    if (typeof cb !== 'function') return;
    const { room, error } = lookup(arg && arg.code);
    if (error) return cb({ error });
    if (!room) return cb({ error: 'No room with that code. Check the digits and try again.' });
    if (room.users.length >= MAX_USERS) return cb({ error: 'That room is full (' + MAX_USERS + '/' + MAX_USERS + ').' });
    cb({ ok: true });
  });

  on('room:join', (arg, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const { code, clientId } = arg || {};
    if (socket.data.code) return reply({ error: 'Already in a room.' });
    if (clientId !== undefined && (typeof clientId !== 'string' || !ID_RE.test(clientId))) {
      return reply({ error: 'Bad request.' });
    }

    const { room, error } = lookup(code);
    if (error) return reply({ error });
    if (!room) return reply({ error: 'No room with that code. It may have closed when everyone left.' });

    // Reconnect / refresh with the same clientId keeps the same label and slot.
    const returning = clientId && room.users.find(u => u.clientId === clientId);
    let label;

    if (returning) {
      returning.id = socket.id;
      label = returning.label;
    } else {
      if (room.users.length >= MAX_USERS) {
        return reply({ error: 'This room is full (' + MAX_USERS + '/' + MAX_USERS + '). Ask someone to leave first.' });
      }
      label = assignLabel(room);
      room.users.push({ id: socket.id, clientId: clientId || socket.id, label });
    }
    clearTimeout(room.expiry);

    socket.join(code);
    socket.data.code = code;
    socket.data.label = label;
    socket.data.clientId = clientId || socket.id;

    const peers = room.users.filter(u => u.id !== socket.id).map(u => ({ id: u.id, label: u.label }));
    const live = new Set(room.users.map(u => u.id));

    reply({
      selfId: socket.id,
      label,
      peers,
      users: userList(room),
      maxUsers: MAX_USERS,
      // A file is only still gettable if the person who offered it is present.
      history: room.history.map(({ bytes, ...h }) =>
        h.type === 'file' ? Object.assign(h, { available: live.has(h.ownerId) }) : h
      ),
    });

    if (!returning) {
      const sys = { type: 'system', text: label + ' joined', ts: Date.now() };
      pushHistory(room, sys);
      socket.to(code).emit('chat:message', sys);
    }

    // Existing peers open the WebRTC offer towards the newcomer.
    socket.to(code).emit('rtc:peer-joined', { id: socket.id, label });
    io.to(code).emit('room:users', userList(room));
  });

  /* ── WebRTC signalling — an opaque pipe ─────────────────── */
  on('rtc:signal', (arg) => {
    const { to, payload } = arg || {};
    if (!inSameRoom(socket, to) || !payload || typeof payload !== 'object') return;
    if (!allow('signal') || byteSize(payload) > MAX_SIGNAL_BYTES) return;
    io.to(to).emit('rtc:signal', { from: socket.id, payload });
  });

  /* ── Fallback relay: used only when the P2P link fails ─── */
  /* Relay bytes are paced, not dropped: a dropped chunk would corrupt the
     file. Control messages share the queue so an 'end' can never overtake
     the chunks before it. An honest sender keeps at most its 4 MB credit
     window unacknowledged, so a backlog far past that is a client ignoring
     flow control, and it is cut off. */
  const relayQueue = [];
  let relayQueued = 0;
  let relayTimer = null;

  function pumpRelay() {
    relayTimer = null;
    const bucket = socketBucket(socket, 'relay');
    while (relayQueue.length) {
      const item = relayQueue[0];
      // A receiver that is not reading — slow, or deliberately stalled — must
      // not make the server buffer for it. Wait until it drains.
      if (item.buf && (targetBacklog(item.to) > MAX_TARGET_BACKLOG || !bucket.take(item.buf.length))) {
        relayTimer = setTimeout(pumpRelay, 25);
        return;
      }
      relayQueue.shift();
      relayQueued -= item.cost;
      if (item.buf) {
        io.to(item.to).emit('relay:chunk', { from: socket.id, tag: item.tag, buf: item.buf });
      } else {
        io.to(item.to).emit('relay:ctrl', { from: socket.id, msg: item.msg });
      }
    }
  }

  function queueRelay(item) {
    relayQueue.push(item);
    if (!relayTimer) pumpRelay();
  }

  on('relay:ctrl', (arg) => {
    const { to, msg } = arg || {};
    if (!inSameRoom(socket, to) || !msg || typeof msg !== 'object') return;
    const size = byteSize(msg);
    if (!allow('ctrl') || size > MAX_CTRL_BYTES) return;
    // Counted like chunk bytes, so a stalled receiver cannot make the server
    // hoard an endless pile of small messages either. The floor covers the
    // per-message overhead of a tiny one.
    const cost = Math.max(size, 256);
    if (relayQueued + cost > MAX_RELAY_BACKLOG) return socket.disconnect(true);
    relayQueued += cost;
    queueRelay({ to, msg, cost });
  });

  on('relay:chunk', (arg) => {
    const { to, tag, buf } = arg || {};
    if (!inSameRoom(socket, to) || !Buffer.isBuffer(buf)) return;
    if (!Number.isInteger(tag) || tag < 0 || tag > 0xffffffff) return;
    if (buf.length > MAX_RELAY_CHUNK) return;
    if (relayQueued + buf.length > MAX_RELAY_BACKLOG) return socket.disconnect(true);
    relayQueued += buf.length;
    queueRelay({ to, tag, buf, cost: buf.length });
  });

  on('disconnect', () => clearTimeout(relayTimer));

  /* ── Chat ───────────────────────────────────────────────── */
  on('chat:message', (arg) => {
    const { code, label } = socket.data;
    if (!code || !rooms[code]) return;
    const text = arg && arg.text;
    if (typeof text !== 'string') return;
    const clean = text.slice(0, 4000);
    if (!clean.trim() || !allow('chat')) return;
    const msg = {
      type: 'chat',
      id: Math.random().toString(36).slice(2) + Date.now().toString(36),
      sender: label,
      senderId: socket.id,
      text: clean,
      ts: Date.now(),
    };
    pushHistory(rooms[code], msg);
    io.to(code).emit('chat:message', msg);
  });

  /* Delivery receipt: recipients confirm, the sender counts them. */
  on('msg:ack', (arg) => {
    const { id, to } = arg || {};
    if (typeof id !== 'string' || id.length > 64 || !inSameRoom(socket, to)) return;
    if (!allow('misc')) return;
    io.to(to).emit('msg:ack', { id, from: socket.id, label: socket.data.label });
  });

  on('chat:typing', (isTyping) => {
    const { code, label } = socket.data;
    if (!code || !allow('typing')) return;
    socket.to(code).emit('chat:typing', { label, typing: isTyping !== false });
  });

  /* ── File offers ────────────────────────────────────────────
     Only metadata is broadcast. Receivers then pull the bytes
     straight from the owner, so nothing moves until wanted. */
  on('file:offer', (arg) => {
    const { fileId, name, size, type } = arg || {};
    const { code, label } = socket.data;
    if (!code || !rooms[code] || typeof fileId !== 'string' || !ID_RE.test(fileId)) return;
    // Strict types: coercing an attacker's nested arrays to a string would
    // recurse until the stack overflows.
    if (typeof name !== 'string' || typeof type !== 'string') return;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return;
    const room = rooms[code];
    // A fileId belongs to whoever offered it first; nobody can overwrite it.
    if (room.history.some(h => h.type === 'file' && h.fileId === fileId)) return;
    if (!allow('offer')) return;
    const entry = {
      type: 'file',
      fileId,
      sender: label,
      ownerId: socket.id,
      name: (name || 'file').slice(0, 300),
      size,
      fileType: type.slice(0, 200),
      ts: Date.now(),
    };
    pushHistory(room, entry);
    io.to(code).emit('file:offer', Object.assign({}, entry, { available: true }));
  });

  /* Only the owner can withdraw a file. */
  on('file:revoke', (arg) => {
    const fileId = arg && arg.fileId;
    const { code } = socket.data;
    if (!code || !rooms[code] || typeof fileId !== 'string') return;
    const room = rooms[code];
    const owned = room.history.some(h => h.type === 'file' && h.fileId === fileId && h.ownerId === socket.id);
    if (!owned) return;
    room.history = room.history.filter(h => !(h.type === 'file' && h.fileId === fileId));
    room.historyBytes = room.history.reduce((n, h) => n + (h.bytes || 0), 0);
    io.to(code).emit('file:unavailable', { fileId });
  });

  on('disconnect', () => {
    const { code, label } = socket.data;
    const room = code && rooms[code];
    if (!room) return;

    const wasHere = room.users.some(u => u.id === socket.id);
    room.users = room.users.filter(u => u.id !== socket.id);
    if (!wasHere) return;

    // Their offers die with them — tell everyone so the cards grey out.
    for (const h of room.history) {
      if (h.type === 'file' && h.ownerId === socket.id) {
        io.to(code).emit('file:unavailable', { fileId: h.fileId });
      }
    }

    io.to(code).emit('rtc:peer-left', { id: socket.id, label });
    io.to(code).emit('room:users', userList(room));

    const sys = { type: 'system', text: label + ' left', ts: Date.now() };
    pushHistory(room, sys);
    io.to(code).emit('chat:message', sys);
    if (room.users.length === 0) scheduleExpiry(room);
  });
});

function start(port) {
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

if (require.main === module) {
  start(PORT).then(() => {
    const ip = getLocalIP();
    console.log('\n  HalwaShare\n');
    console.log('  Local:   http://localhost:' + PORT);
    console.log('  Network: http://' + ip + ':' + PORT);
    console.log('\n  Share the Network URL with anyone on your Wi-Fi.\n');
  });
}

module.exports = { start, server, io, rooms, CODE_LENGTH, targetBacklog };
