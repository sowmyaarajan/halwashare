/* ── HalwaShare server ─────────────────────────────────────
   The server does three things and nothing more:
     1. serves the static app
     2. relays WebRTC signalling + chat text
     3. relays file bytes ONLY when a direct P2P link fails
   File bytes are never written to disk or buffered per-room. */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  // Relay frames are 256 KB + framing; give plenty of headroom.
  maxHttpBufferSize: 4 * 1024 * 1024,
  pingInterval: 20000,
  pingTimeout: 30000,
});

const PORT = process.env.PORT || 4000;
const MAX_USERS = Number(process.env.MAX_USERS || 5);
const HISTORY_MAX = 300;

/* rooms: code -> { code, users: [{ id, clientId, label }], history: [] } */
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

function generateCode() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms[code]);
  return code;
}

function assignLabel(room) {
  const used = new Set(room.users.map(u => u.label));
  for (let i = 1; i <= MAX_USERS; i++) {
    if (!used.has('User ' + i)) return 'User ' + i;
  }
  return null;
}

function pushHistory(room, entry) {
  room.history.push(entry);
  if (room.history.length > HISTORY_MAX) {
    room.history.splice(0, room.history.length - HISTORY_MAX);
  }
}

function userList(room) {
  return room.users.map(u => ({ id: u.id, label: u.label }));
}

/* A socket may only address peers inside its own room. */
function inSameRoom(socket, targetId) {
  const code = socket.data.code;
  const room = code && rooms[code];
  return !!room && room.users.some(u => u.id === targetId);
}

app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

app.get('/favicon.ico', (_req, res) => {
  res.type('image/svg+xml').send(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="82">\u{1F36E}</text></svg>'
  );
});

app.get('/join/:code', (req, res) => {
  if (!/^\d{4}$/.test(req.params.code)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('/api/qr/:code', async (req, res) => {
  const { code } = req.params;
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

app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: Object.keys(rooms).length }));

io.on('connection', (socket) => {

  socket.on('room:create', (cb) => {
    const code = generateCode();
    rooms[code] = { code, users: [], history: [] };
    if (typeof cb === 'function') cb({ code });
  });

  socket.on('room:check', (arg, cb) => {
    if (typeof cb !== 'function') return;
    const code = arg && arg.code;
    const room = rooms[code];
    if (!room) return cb({ error: 'No room with that code. Check the digits and try again.' });
    if (room.users.length >= MAX_USERS) return cb({ error: 'That room is full (' + MAX_USERS + '/' + MAX_USERS + ').' });
    cb({ ok: true });
  });

  socket.on('room:join', (arg, cb) => {
    const { code, clientId } = arg || {};
    const room = rooms[code];
    const reply = typeof cb === 'function' ? cb : () => {};
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
      history: room.history.map(h =>
        h.type === 'file' ? Object.assign({}, h, { available: live.has(h.ownerId) }) : h
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
  socket.on('rtc:signal', (arg) => {
    const { to, payload } = arg || {};
    if (!inSameRoom(socket, to)) return;
    io.to(to).emit('rtc:signal', { from: socket.id, payload });
  });

  /* ── Fallback relay: used only when the P2P link fails ─── */
  socket.on('relay:ctrl', (arg) => {
    const { to, msg } = arg || {};
    if (!inSameRoom(socket, to)) return;
    io.to(to).emit('relay:ctrl', { from: socket.id, msg });
  });

  socket.on('relay:chunk', (arg) => {
    const { to, tag, buf } = arg || {};
    if (!inSameRoom(socket, to)) return;
    io.to(to).emit('relay:chunk', { from: socket.id, tag, buf });
  });

  /* ── Chat ───────────────────────────────────────────────── */
  socket.on('chat:message', (arg) => {
    const { code, label } = socket.data;
    if (!code || !rooms[code]) return;
    const text = arg && arg.text;
    if (typeof text !== 'string') return;
    const clean = text.slice(0, 4000);
    if (!clean.trim()) return;
    const msg = { type: 'chat', sender: label, text: clean, ts: Date.now() };
    pushHistory(rooms[code], msg);
    io.to(code).emit('chat:message', msg);
  });

  socket.on('chat:typing', (isTyping) => {
    const { code, label } = socket.data;
    if (!code) return;
    socket.to(code).emit('chat:typing', { label, typing: isTyping !== false });
  });

  /* ── File offers ────────────────────────────────────────────
     Only metadata is broadcast. Receivers then pull the bytes
     straight from the owner, so nothing moves until wanted. */
  socket.on('file:offer', (arg) => {
    const { fileId, name, size, type } = arg || {};
    const { code, label } = socket.data;
    if (!code || !rooms[code] || !fileId) return;
    const entry = {
      type: 'file',
      fileId,
      sender: label,
      ownerId: socket.id,
      name: String(name || 'file').slice(0, 300),
      size: Number(size) || 0,
      fileType: String(type || ''),
      ts: Date.now(),
    };
    pushHistory(rooms[code], entry);
    io.to(code).emit('file:offer', Object.assign({}, entry, { available: true }));
  });

  socket.on('file:revoke', (arg) => {
    const fileId = arg && arg.fileId;
    const { code } = socket.data;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    room.history = room.history.filter(
      h => !(h.type === 'file' && h.fileId === fileId && h.ownerId === socket.id)
    );
    io.to(code).emit('file:unavailable', { fileId });
  });

  socket.on('disconnect', () => {
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

    if (room.users.length === 0) {
      delete rooms[code];
    } else {
      const sys = { type: 'system', text: label + ' left', ts: Date.now() };
      pushHistory(room, sys);
      io.to(code).emit('chat:message', sys);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n  HalwaShare\n');
  console.log('  Local:   http://localhost:' + PORT);
  console.log('  Network: http://' + ip + ':' + PORT);
  console.log('\n  Share the Network URL with anyone on your Wi-Fi.\n');
});
