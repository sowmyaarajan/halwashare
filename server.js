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
const webpush = require('web-push');
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
// A person whose connection drops — screen locked, app in the background,
// Wi-Fi handing over to mobile data — is kept as "away" this long, with the
// same name and files, before the room is told they left.
const USER_GRACE_MS = Number(process.env.USER_GRACE_MS || 180000);

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

/* rooms: code -> { code, users: [member], history: [], expiry }
   member: { pid, clientId, label, sid, awayTimer }
     pid      public id other people address this person by; stable while
              they are in the room, across reconnects
     clientId secret id their browser tab holds; proves it is them
     sid      current socket id, or null while they are away */
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

function assignLabel(room, wanted) {
  const used = new Set(room.users.map(u => u.label));
  // The device's own name when it gave one, made unique within the room.
  if (wanted) {
    if (!used.has(wanted)) return wanted;
    for (let i = 2; i <= MAX_USERS + 1; i++) {
      if (!used.has(wanted + ' ' + i)) return wanted + ' ' + i;
    }
  }
  for (let i = 1; i <= MAX_USERS; i++) {
    if (!used.has('User ' + i)) return 'User ' + i;
  }
  return null;
}

/* A display name a device chose for itself: printable, short, single line. */
const NAME_MAX = 32;
function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  return name || null;
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
  return room.users.map(u => ({ id: u.pid, label: u.label, away: !u.sid }));
}

function newPid() {
  return crypto.randomBytes(9).toString('base64url');
}

/* The socket currently behind a person, or null if they are away. */
function sidOf(room, pid) {
  const m = room && typeof pid === 'string' && room.users.find(u => u.pid === pid);
  return (m && m.sid) || null;
}

/* Client ids that have joined this room, so they can return without the
   guessing gates. Capped: at most five people are in a room at once, and a
   few more for those who left. */
function rememberMember(room, clientId) {
  room.members.delete(clientId);
  room.members.add(clientId);
  while (room.members.size > 20) room.members.delete(room.members.values().next().value);
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

/* A socket may only address people inside its own room. Returns the
   target's socket id, or null when they are not here or are away. */
function inSameRoom(socket, targetPid) {
  const code = socket.data.code;
  return sidOf(code && rooms[code], targetPid);
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
  typing:  [4, 10],
  signal:  [50, 400],            // ICE candidates arrive in bursts
  ctrl:    [100, 400],
  relay:   [RELAY_BYTES_PER_SEC, RELAY_BYTES_PER_SEC * 2], // bytes per socket
  offer:   [2, 20],
  qr:      [1, 20],
  misc:    [20, 60],
  presence: [1, 10],
  invite:  [1 / 3, 6],
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

/* ── Presence ──────────────────────────────────────────────────
   Two ways to find a device without a room code:
     nearby  — other HalwaShare pages behind the same public address,
               which almost always means the same Wi-Fi
     paired  — devices that chose to remember each other. Each pair shares
               a random token; the server only matches tokens, it never
               learns which devices or names are behind them. */
const nets = new Map();        // ip key -> Set(socket)
const pairTokens = new Map();  // token -> Set(socket)
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const KINDS = new Set(['phone', 'tablet', 'laptop', 'desktop']);
const MAX_NEARBY = 20;
const CROWDED_NET = 200;       // an office or campus: too many to list

function addTo(map, key, socket) {
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  set.add(socket);
}
function removeFrom(map, key, socket) {
  const set = map.get(key);
  if (!set) return;
  set.delete(socket);
  if (!set.size) map.delete(key);
}

function nearbyFor(socket) {
  const set = nets.get(socket.data.ip);
  if (!set || set.size > CROWDED_NET) return [];
  const me = socket.data.presence;
  const list = [];
  for (const s of set) {
    const p = s.data.presence;
    if (s === socket || !p || (me && p.device === me.device)) continue;
    list.push({ id: p.nid, name: p.name, kind: p.kind, at: p.at });
  }
  return list.sort((a, b) => b.at - a.at).slice(0, MAX_NEARBY)
    .map(({ at, ...rest }) => rest);
}

function announceNearby(ip) {
  const set = nets.get(ip);
  if (!set || set.size > CROWDED_NET) return;
  for (const s of set) s.emit('presence:nearby', nearbyFor(s));
}

/* Is a paired device — some socket with this token on another device — online? */
function pairedOnline(token, socket) {
  const set = pairTokens.get(token);
  const me = socket.data.presence;
  if (!set || !me) return false;
  for (const s of set) if (s !== socket && s.data.presence && s.data.presence.device !== me.device) return true;
  return false;
}

function announcePaired(token) {
  const set = pairTokens.get(token);
  if (!set) return;
  for (const s of set) s.emit('presence:paired', { token, online: pairedOnline(token, s) });
}

function leavePresence(socket) {
  const p = socket.data.presence;
  if (!p) return;
  socket.data.presence = null;
  removeFrom(nets, socket.data.ip, socket);
  for (const t of p.tokens) { removeFrom(pairTokens, t, socket); announcePaired(t); }
  announceNearby(socket.data.ip);
}

/* ── Push: knocking on a remembered device that is closed ─────
   The server keeps no list of devices to notify. A device hands its push
   address only to the devices it remembers, over their direct link; to
   knock, one of them gives that address back to the server along with
   the pairing token. The message itself is encrypted for that one device,
   so the push service relaying it cannot read it either.

   The keys must stay the same across restarts, or every saved address
   stops working: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY. Without them
   a fresh pair is made at start-up, which is fine for trying it out. */
const PUSH_HOSTS = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com)$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const vapid = (() => {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  if (process.env.NODE_ENV !== 'test') {
    console.warn('[halwa] VAPID keys not set: knocks on closed devices stop working after a restart');
  }
  return webpush.generateVAPIDKeys();
})();
const pushSubject = process.env.VAPID_SUBJECT ||
  (/^https:\/\//.test(process.env.PUBLIC_URL || '') ? process.env.PUBLIC_URL : 'mailto:halwashare@example.com');
webpush.setVapidDetails(pushSubject, vapid.publicKey, vapid.privateKey);

/* A push address, checked: only real push services, so the server can
   never be made to send requests anywhere else. */
function cleanSubscription(sub) {
  if (!sub || typeof sub !== 'object' || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1024) return null;
  let url;
  try { url = new URL(sub.endpoint); } catch (_) { return null; }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password) return null;
  if (!PUSH_HOSTS.test(url.hostname)) return null;
  const keys = sub.keys || {};
  if (typeof keys.p256dh !== 'string' || !B64URL_RE.test(keys.p256dh) || keys.p256dh.length < 80 || keys.p256dh.length > 100) return null;
  if (typeof keys.auth !== 'string' || !B64URL_RE.test(keys.auth) || keys.auth.length < 16 || keys.auth.length > 32) return null;
  return { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

let sendPush = (sub, payload, options) => webpush.sendNotification(sub, payload, options);
/* Limits per pairing token and per push address. The token alone is not
   enough: the server cannot tell a real pairing from a made-up one, so a
   device holding someone's address could invent a new token every time. */
const lastKnock = new Map();   // token -> time
const ringLimits = new Map();  // sha256(endpoint) -> { at, bucket }
const KNOCK_GAP_MS = 15 * 1000;
const RINGS_PER_HOUR = 12;

function ringAllowed(token, endpoint, now) {
  if (now - (lastKnock.get(token) || 0) < KNOCK_GAP_MS) return false;
  const key = crypto.createHash('sha256').update(endpoint).digest('base64url');
  let lim = ringLimits.get(key);
  if (lim && now - lim.at < KNOCK_GAP_MS) return false;
  if (!lim) {
    if (ringLimits.size >= 10000) ringLimits.delete(ringLimits.keys().next().value);
    lim = { at: 0, bucket: new Bucket(RINGS_PER_HOUR / 3600, RINGS_PER_HOUR / 2) };
    ringLimits.set(key, lim);
  }
  if (!lim.bucket.take(1)) return false;
  lim.at = now;
  lastKnock.set(token, now);
  if (lastKnock.size > 10000) lastKnock.delete(lastKnock.keys().next().value);
  return true;
}

/* Signed with the pairing token, so the ringed device can check the ring
   comes from a pairing it still holds. Made-up tokens and forgotten
   pairings fail there, whatever the server let through. */
function ringMac(token, code) {
  return crypto.createHmac('sha256', token).update('halwa-ring-v1|' + code).digest('base64url');
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
      "media-src 'self' blob:",
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
    // The microphone is for voice notes, and only ever this page's own.
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
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

app.get('/api/push-key', (_req, res) => res.json({ key: vapid.publicKey }));

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
  function lookup(code, clientId) {
    if (typeof code !== 'string' || !CODE_RE.test(code)) return { error: 'Room codes are ' + CODE_LENGTH + ' digits.' };
    // Someone who has already been in this room — a phone reconnecting after
    // its screen locked, a refresh — is let straight back in, even while the
    // site-wide guessing cap is spent. Their id is a random secret never sent
    // to anyone else, so knowing it proves they belong; a guesser has neither
    // the code nor the id.
    const known = rooms[code];
    if (known && typeof clientId === 'string' && known.members.has(clientId)) return { room: known };
    const bucket = ipBucket(ip, 'lookup');
    bucket.take(0); // refill
    globalMisses.take(0);
    if (bucket.tokens < 1) return { error: SLOW_DOWN };
    if (globalMisses.tokens < 1) return { error: 'HalwaShare is busy. Try again in a minute.' };
    const room = rooms[code];
    if (!room) { bucket.take(1); globalMisses.take(1); }
    return { room };
  }

  on('room:create', (arg, cb) => {
    if (typeof arg === 'function') { cb = arg; arg = null; }
    if (typeof cb !== 'function') return;
    if (!ipBucket(ip, 'create').take(1)) return cb({ error: SLOW_DOWN });
    const res = createRoom(ip, arg && arg.clientId);
    cb(res.error ? { error: res.error } : { code: res.code });
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
    const { code, clientId, fresh } = arg || {};
    if (socket.data.code) return reply({ error: 'Already in a room.' });
    if (clientId !== undefined && (typeof clientId !== 'string' || !ID_RE.test(clientId))) {
      return reply({ error: 'Bad request.' });
    }

    const { room, error } = lookup(code, clientId);
    if (error) return reply({ error });
    if (!room) return reply({ error: 'No room with that code. It may have closed when everyone left.' });

    // Coming back — a reconnect, a refresh, a phone waking up — keeps the
    // same person: same id, same name, same files.
    let member = clientId && room.users.find(u => u.clientId === clientId);
    const returning = !!member;

    if (member) {
      // A refresh can arrive before the old socket has gone. Retire it
      // quietly so its eventual disconnect does not count as leaving.
      if (member.sid && member.sid !== socket.id) {
        const old = io.sockets.sockets.get(member.sid);
        if (old) {
          old.data.code = null;
          old.leave(code);
          old.disconnect(true);
        }
      }
      clearTimeout(member.awayTimer);
      member.awayTimer = null;
      member.sid = socket.id;
    } else {
      if (room.users.length >= MAX_USERS) {
        return reply({ error: 'This room is full (' + MAX_USERS + '/' + MAX_USERS + '). Ask someone to leave first.' });
      }
      member = {
        pid: newPid(), clientId: clientId || newPid(),
        label: assignLabel(room, cleanName((arg || {}).name)), sid: socket.id, awayTimer: null,
      };
      room.users.push(member);
    }
    clearTimeout(room.expiry);
    if (clientId) rememberMember(room, clientId);

    socket.join(code);
    socket.data.code = code;
    socket.data.label = member.label;
    socket.data.pid = member.pid;

    // Files this person offered survive only if their page still holds them.
    // A refreshed page has lost its file handles; a reconnect has not.
    if (returning) {
      const holding = new Set(Array.isArray(arg.files)
        ? arg.files.filter(f => typeof f === 'string').slice(0, 1000) : []);
      for (const h of room.history) {
        if (h.type === 'file' && h.ownerId === member.pid && !h.gone && !holding.has(h.fileId)) {
          h.gone = true;
          socket.to(code).emit('file:unavailable', { fileId: h.fileId });
        }
      }
    }

    const present = new Set(room.users.map(u => u.pid));
    reply({
      selfId: member.pid,
      label: member.label,
      peers: room.users.filter(u => u !== member && u.sid).map(u => ({ id: u.pid, label: u.label })),
      users: userList(room),
      maxUsers: MAX_USERS,
      // A file can still be fetched while the person who offered it is in the
      // room — even if they are briefly away — and still holds it.
      history: room.history.map(({ bytes, gone, ...h }) =>
        h.type === 'file' ? Object.assign(h, { available: !gone && present.has(h.ownerId) }) : h
      ),
    });

    if (!returning) {
      const sys = { type: 'system', text: member.label + ' joined', ts: Date.now() };
      pushHistory(room, sys);
      socket.to(code).emit('chat:message', sys);
    }

    // Others open a WebRTC link towards them. On a return, `fresh` says the
    // page was reloaded, so any old link is certainly dead.
    socket.to(code).emit('rtc:peer-joined', {
      id: member.pid, label: member.label, rejoin: returning, fresh: fresh === true,
    });
    io.to(code).emit('room:users', userList(room));
  });

  /* Change the name others see. Unique within the room; old messages keep
     the name they were sent under, and the room is told who is who. */
  on('room:rename', (arg, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const { code, pid } = socket.data;
    const room = code && rooms[code];
    const member = room && room.users.find(u => u.pid === pid && u.sid === socket.id);
    if (!member) return reply({ error: 'You are not in a room.' });
    if (!allow('presence')) return reply({ error: SLOW_DOWN });
    const wanted = cleanName(arg && arg.name);
    if (!wanted) return reply({ error: 'Pick a name with at least one letter or number.' });
    const label = assignLabel({ users: room.users.filter(u => u !== member) }, wanted);
    if (!label) return reply({ error: 'That name is taken.' });
    if (label === member.label) return reply({ label });
    const old = member.label;
    member.label = label;
    socket.data.label = label;
    const sys = { type: 'system', text: old + ' is now ' + label, ts: Date.now() };
    pushHistory(room, sys);
    io.to(code).emit('chat:message', sys);
    io.to(code).emit('room:users', userList(room));
    reply({ label });
  });

  /* Leaving on purpose: no grace period. */
  on('room:leave', () => {
    const { code, pid } = socket.data;
    const room = code && rooms[code];
    const member = room && room.users.find(u => u.pid === pid && u.sid === socket.id);
    if (member) removeMember(room, member);
    socket.data.code = null;
    if (code) socket.leave(code);
  });

  /* ── Presence: nearby and paired devices ────────────────── */
  on('presence:hello', (arg) => {
    if (!arg || typeof arg !== 'object' || !allow('presence')) return;
    const name = cleanName(arg.name);
    const device = typeof arg.device === 'string' && ID_RE.test(arg.device) ? arg.device : null;
    if (!name || !device) return;
    const tokens = Array.isArray(arg.tokens)
      ? [...new Set(arg.tokens.filter(t => typeof t === 'string' && TOKEN_RE.test(t)))].slice(0, 50) : [];
    const prev = socket.data.presence;
    if (prev) leavePresence(socket);
    socket.data.presence = {
      nid: (prev && prev.nid) || newPid(),
      name,
      kind: KINDS.has(arg.kind) ? arg.kind : 'desktop',
      device,
      clientId: typeof arg.clientId === 'string' && ID_RE.test(arg.clientId) ? arg.clientId : null,
      tokens: new Set(tokens),
      at: Date.now(),
    };
    // A device that chose to hide is neither listed nor shown the list;
    // its remembered devices still find it.
    if (arg.visible === false) socket.emit('presence:nearby', []);
    else addTo(nets, ip, socket);
    for (const t of tokens) addTo(pairTokens, t, socket);
    if (arg.visible !== false) announceNearby(ip);
    for (const t of tokens) announcePaired(t);
  });

  /* Invite a nearby or paired device into a room: this one, or a new one. */
  on('presence:invite', (arg, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const me = socket.data.presence;
    if (!me || !arg || typeof arg !== 'object') return reply({ error: 'Bad request.' });
    if (!allow('invite')) return reply({ error: SLOW_DOWN });

    let targets = [];
    let token = null;
    if (typeof arg.token === 'string' && me.tokens.has(arg.token)) {
      token = arg.token;
      targets = [...(pairTokens.get(token) || [])]
        .filter(s => s !== socket && s.data.presence && s.data.presence.device !== me.device);
    } else if (typeof arg.to === 'string') {
      targets = [...(nets.get(ip) || [])]
        .filter(s => s !== socket && s.data.presence && s.data.presence.nid === arg.to);
    }
    if (!targets.length) return reply({ error: 'That device is not online any more.' });

    const inviterId = typeof arg.clientId === 'string' && ID_RE.test(arg.clientId) ? arg.clientId : me.clientId;
    let room;
    let code;

    // Not in a room, and the other device already is: go to them rather
    // than pull them out into a new room. Someone who left and comes back
    // lands in the same room.
    const theirs = arg.code === undefined && !socket.data.code
      ? targets.map(s => s.data.code && rooms[s.data.code]).find(r => r && r.users.length < MAX_USERS)
      : null;
    if (theirs) {
      // A remembered device goes straight in, but only where it would meet
      // just that device: anyone else in the room never agreed to it.
      const alone = token && theirs.users.length === 1 &&
        targets.some(s => s.data.code === theirs.code && s.data.pid === theirs.users[0].pid);
      if (alone) {
        if (inviterId) rememberMember(theirs, inviterId);
        return reply({ code: theirs.code });
      }
      // Otherwise knock, and someone in the room lets them in.
      const kid = newPid();
      for (const s of targets) {
        if (!s.data.code || rooms[s.data.code] !== theirs) continue;
        const knocks = s.data.knocks || (s.data.knocks = new Map());
        if (knocks.size >= 20) knocks.delete(knocks.keys().next().value);
        knocks.set(kid, { code: theirs.code, from: socket, clientId: inviterId, at: Date.now() });
        s.emit('presence:knock', { kid, from: me.name, kind: me.kind, token });
      }
      return reply({ waiting: true, kid });
    }

    if (arg.code !== undefined) {
      // Only into the room the inviter is actually in.
      if (arg.code !== socket.data.code || !rooms[arg.code]) return reply({ error: 'Bad request.' });
      code = arg.code;
      room = rooms[code];
      if (room.users.length >= MAX_USERS) return reply({ error: 'This room is full.' });
    } else {
      if (!ipBucket(ip, 'create').take(1)) return reply({ error: SLOW_DOWN });
      const res = createRoom(ip, inviterId);
      if (res.error) return reply({ error: res.error });
      ({ code, room } = res);
    }
    for (const s of targets) {
      // Invited, so let their tab in like a member.
      const cid = s.data.presence.clientId;
      if (cid) rememberMember(room, cid);
      s.emit('presence:invited', { code, from: me.name, kind: me.kind, token, nid: me.nid });
    }
    reply({ code });
  });

  /* Ring a remembered device that does not have HalwaShare open: make a
     room and send it a notification that opens it. */
  on('presence:ring', async (arg, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const me = socket.data.presence;
    if (!me || !arg || typeof arg !== 'object') return reply({ error: 'Bad request.' });
    const token = arg.token;
    if (typeof token !== 'string' || !me.tokens.has(token)) return reply({ error: 'Bad request.' });
    const sub = cleanSubscription(arg.sub);
    if (!sub) return reply({ error: 'That device cannot be notified.', gone: true });
    if (!allow('invite')) return reply({ error: SLOW_DOWN });
    if (!ringAllowed(token, sub.endpoint, Date.now())) return reply({ error: 'Already notified — give them a moment.' });
    if (!ipBucket(ip, 'create').take(1)) return reply({ error: SLOW_DOWN });

    const inviterId = typeof arg.clientId === 'string' && ID_RE.test(arg.clientId) ? arg.clientId : me.clientId;
    const res = createRoom(ip, inviterId);
    if (res.error) return reply({ error: res.error });
    // No name: the ringed device shows its own name for the pairing.
    const payload = JSON.stringify({ t: 'ring', code: res.code, mac: ringMac(token, res.code) });
    try {
      await sendPush(sub, payload, { TTL: 120, urgency: 'high', topic: 'halwa-ring', timeout: 8000 });
      reply({ code: res.code });
    } catch (err) {
      const status = err && err.statusCode;
      // 404 / 410: that address is dead; the device was reset or uninstalled.
      if (status === 404 || status === 410) return reply({ error: 'That device can no longer be notified.', gone: true });
      reply({ error: 'Could not send the notification. Try again.' });
    }
  });

  /* Answer a knock on the room this device is in. */
  const KNOCK_TTL_MS = 2 * 60 * 1000;
  on('presence:answer', (arg) => {
    const me = socket.data.presence;
    const knocks = socket.data.knocks;
    const k = arg && typeof arg.kid === 'string' && knocks && knocks.get(arg.kid);
    if (!me || !k || !allow('misc')) return;
    knocks.delete(arg.kid);
    const from = k.from;
    if (!from.connected || Date.now() - k.at > KNOCK_TTL_MS) return;
    const room = rooms[k.code];
    if (!arg.ok) return from.emit('presence:declined', { kid: arg.kid, from: me.name });
    // Only into the room this device is still in, and only if there is space.
    if (!room || socket.data.code !== k.code || room.users.length >= MAX_USERS) {
      return from.emit('presence:declined', { kid: arg.kid, from: me.name });
    }
    if (k.clientId) rememberMember(room, k.clientId);
    from.emit('presence:invited', { code: k.code, from: me.name, kind: me.kind, token: null, nid: me.nid, kid: arg.kid });
  });

  /* Forgetting a pairing tells the other device to forget it too. */
  on('presence:forget', (arg) => {
    const me = socket.data.presence;
    const token = arg && arg.token;
    if (!me || typeof token !== 'string' || !me.tokens.has(token) || !allow('misc')) return;
    for (const s of pairTokens.get(token) || []) {
      if (s !== socket) s.emit('presence:forgotten', { token });
    }
    me.tokens.delete(token);
    removeFrom(pairTokens, token, socket);
    announcePaired(token);
  });

  on('disconnect', () => leavePresence(socket));

  /* Lets a page that just woke up check its connection is really alive. */
  on('room:ping', (cb) => { if (typeof cb === 'function' && allow('misc')) cb(true); });

  /* ── WebRTC signalling — an opaque pipe ─────────────────── */
  on('rtc:signal', (arg) => {
    const { to, payload } = arg || {};
    const sid = inSameRoom(socket, to);
    if (!sid || !payload || typeof payload !== 'object') return;
    if (!allow('signal') || byteSize(payload) > MAX_SIGNAL_BYTES) return;
    io.to(sid).emit('rtc:signal', { from: socket.data.pid, payload });
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
      // Resolved now, not when queued: the receiver may have reconnected on
      // a new socket meanwhile. Away or gone, the item is dropped, and the
      // receiver asks for the rest when it is back.
      const code = socket.data.code;
      const sid = sidOf(code && rooms[code], item.to);
      // A receiver that is not reading — slow, or deliberately stalled — must
      // not make the server buffer for it. Wait until it drains.
      if (sid && item.buf && (targetBacklog(sid) > MAX_TARGET_BACKLOG || !bucket.take(item.buf.length))) {
        relayTimer = setTimeout(pumpRelay, 25);
        return;
      }
      relayQueue.shift();
      relayQueued -= item.cost;
      if (!sid) continue;
      if (item.buf) {
        io.to(sid).emit('relay:chunk', { from: socket.data.pid, tag: item.tag, buf: item.buf });
      } else {
        io.to(sid).emit('relay:ctrl', { from: socket.data.pid, msg: item.msg });
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

  /* ── Chat ───────────────────────────────────────────────────
     Messages, replies, reactions and read receipts travel peer to peer
     over the same links as files; the server never sees them. All it
     carries is "someone is typing". */
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
      ownerId: socket.data.pid,
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
    const owned = room.history.some(h => h.type === 'file' && h.fileId === fileId && h.ownerId === socket.data.pid);
    if (!owned) return;
    room.history = room.history.filter(h => !(h.type === 'file' && h.fileId === fileId));
    room.historyBytes = room.history.reduce((n, h) => n + (h.bytes || 0), 0);
    io.to(code).emit('file:unavailable', { fileId });
  });

  /* A dropped connection is not leaving. Mark them away, keep their name
     and files, and only tell the room they left if they stay gone. */
  on('disconnect', () => {
    const { code } = socket.data;
    const room = code && rooms[code];
    if (!room) return;
    const member = room.users.find(u => u.sid === socket.id);
    if (!member) return;
    member.sid = null;
    io.to(code).emit('room:users', userList(room));
    clearTimeout(member.awayTimer);
    member.awayTimer = setTimeout(() => removeMember(room, member), USER_GRACE_MS);
    if (member.awayTimer.unref) member.awayTimer.unref();
  });
});

/* Shared by "Create a room" and by inviting a device into a new one. */
function createRoom(ip, clientId) {
  const codes = Object.keys(rooms);
  if (codes.filter(c => rooms[c].ownerIp === ip).length >= MAX_ROOMS_PER_IP) {
    return { error: 'You have too many rooms open. Close one first.' };
  }
  if (codes.length >= MAX_ROOMS) {
    return { error: 'HalwaShare is busy right now. Please try again in a few minutes.' };
  }
  const code = generateCode();
  if (!code) return { error: 'HalwaShare is busy right now. Please try again in a few minutes.' };
  const room = { code, users: [], history: [], historyBytes: 0, expiry: null, ownerIp: ip, members: new Set() };
  rooms[code] = room;
  // The creator's tab goes straight on to join; let it in whatever the
  // guessing budget says.
  if (typeof clientId === 'string' && ID_RE.test(clientId)) rememberMember(room, clientId);
  scheduleExpiry(room);
  return { code, room };
}

function removeMember(room, member) {
  clearTimeout(member.awayTimer);
  if (!room.users.includes(member)) return;
  room.users = room.users.filter(u => u !== member);
  room.members.delete(member.clientId);
  const code = room.code;

  // Their offers go with them — tell everyone so the cards grey out.
  for (const h of room.history) {
    if (h.type === 'file' && h.ownerId === member.pid && !h.gone) {
      h.gone = true;
      io.to(code).emit('file:unavailable', { fileId: h.fileId });
    }
  }

  io.to(code).emit('rtc:peer-left', { id: member.pid, label: member.label });
  io.to(code).emit('room:users', userList(room));

  const sys = { type: 'system', text: member.label + ' left', ts: Date.now() };
  pushHistory(room, sys);
  io.to(code).emit('chat:message', sys);
  if (room.users.length === 0) scheduleExpiry(room);
}

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

module.exports = {
  start, server, io, rooms, CODE_LENGTH, targetBacklog, pushHistory, cleanSubscription,
  setPushSender: (fn) => { sendPush = fn; },
};
