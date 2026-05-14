const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 4000;
const MAX_USERS = 5;

// rooms: { [code]: { code, users: [{id, label}], history: [] } }
const rooms = {};

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function generateCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms[code]);
  return code;
}

function assignLabel(room) {
  const used = new Set(room.users.map(u => u.label));
  for (let i = 1; i <= MAX_USERS; i++) {
    const label = `User ${i}`;
    if (!used.has(label)) return label;
  }
  return null;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/join/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('/api/qr/:code', async (req, res) => {
  const { code } = req.params;
  const base = process.env.PUBLIC_URL || `http://${getLocalIP()}:${PORT}`;
  const url = `${base}/join/${code}`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 200, margin: 1 });
    res.json({ qr: dataUrl, url });
  } catch (e) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

io.on('connection', (socket) => {

  // Create a new room
  socket.on('room:create', (cb) => {
    const code = generateCode();
    rooms[code] = { code, users: [], history: [] };
    cb({ code });
  });

  // Join an existing room
  socket.on('room:join', ({ code }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ error: 'Room not found. Check the code and try again.' });
    if (room.users.length >= MAX_USERS) return cb({ error: `This room is full (${MAX_USERS}/${MAX_USERS}). Ask someone to leave first.` });

    const label = assignLabel(room);
    const existingPeers = room.users.map(u => ({ id: u.id, label: u.label }));

    room.users.push({ id: socket.id, label });
    socket.join(code);
    socket.data.code = code;
    socket.data.label = label;

    // Send history, user list, and existing peer socket IDs to the new joiner
    cb({ label, history: room.history, users: room.users.map(u => u.label), peers: existingPeers });

    // Notify existing peers of new joiner's socket ID (so they can initiate WebRTC offer)
    socket.to(code).emit('rtc:peer-joined', { id: socket.id, label });

    // System message
    const sysMsg = { type: 'system', text: `${label} joined the room`, ts: Date.now() };
    room.history.push(sysMsg);
    socket.to(code).emit('chat:message', sysMsg);
    io.to(code).emit('room:users', room.users.map(u => u.label));
  });

  // WebRTC signaling relay — server is a dumb pipe, never inspects payload
  socket.on('rtc:signal', ({ to, payload }) => {
    io.to(to).emit('rtc:signal', { from: socket.id, payload });
  });

  // Chat message
  socket.on('chat:message', ({ text }) => {
    const { code, label } = socket.data;
    if (!code || !rooms[code]) return;
    const msg = { type: 'chat', sender: label, text, ts: Date.now() };
    rooms[code].history.push(msg);
    io.to(code).emit('chat:message', msg);
  });

  // Typing indicator
  socket.on('chat:typing', () => {
    const { code, label } = socket.data;
    if (!code) return;
    socket.to(code).emit('chat:typing', { label });
  });

  // File announce — metadata only, no bytes touch the server
  socket.on('file:announce', ({ fileId, name, size, type }) => {
    const { code, label } = socket.data;
    if (!code || !rooms[code]) return;
    const entry = { type: 'file', sender: label, name, size, fileType: type, fileId, ts: Date.now(), status: 'sending' };
    rooms[code].history.push(entry);
    io.to(code).emit('file:announce', entry);
  });

  // File complete — mark history entry as done
  socket.on('file:complete', ({ fileId }) => {
    const { code } = socket.data;
    if (!code || !rooms[code]) return;
    const entry = rooms[code].history.find(h => h.fileId === fileId);
    if (entry) entry.status = 'done';
  });

  // Disconnect
  socket.on('disconnect', () => {
    const { code, label } = socket.data;
    if (!code || !rooms[code]) return;

    const room = rooms[code];
    room.users = room.users.filter(u => u.id !== socket.id);

    // Notify peers to clean up WebRTC connection
    io.to(code).emit('rtc:peer-left', { id: socket.id, label });
    io.to(code).emit('room:users', room.users.map(u => u.label));

    if (room.users.length === 0) {
      delete rooms[code];
    } else {
      const sysMsg = { type: 'system', text: `${label} left the room`, ts: Date.now() };
      room.history.push(sysMsg);
      io.to(code).emit('chat:message', sysMsg);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n  HalwaShare is running!`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${ip}:${PORT}`);
  console.log(`\n  Share the Network URL with others on your Wi-Fi.\n`);
});
