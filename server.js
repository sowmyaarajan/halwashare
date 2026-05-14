const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10 * 1024 * 1024 });

const PORT = process.env.PORT || 4000;
const MAX_USERS = 5;

// rooms: { [code]: { code, users: [{id, label}], history: [], fileBuffers: {} } }
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
    rooms[code] = { code, users: [], history: [], fileBuffers: {} };
    cb({ code });
  });

  // Join an existing room
  socket.on('room:join', ({ code }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ error: 'Room not found. Check the code and try again.' });
    if (room.users.length >= MAX_USERS) return cb({ error: `This room is full (${MAX_USERS}/${MAX_USERS}). Ask someone to leave first.` });

    const label = assignLabel(room);
    room.users.push({ id: socket.id, label });
    socket.join(code);
    socket.data.code = code;
    socket.data.label = label;

    // Send history and current user list to the new joiner
    cb({ label, history: room.history, users: room.users.map(u => u.label) });

    // Notify others
    const sysMsg = { type: 'system', text: `${label} joined the room`, ts: Date.now() };
    room.history.push(sysMsg);
    socket.to(code).emit('chat:message', sysMsg);
    io.to(code).emit('room:users', room.users.map(u => u.label));
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

  // File transfer — start
  socket.on('file:start', ({ name, size, type, totalChunks, fileId }) => {
    const { code, label } = socket.data;
    if (!code || !rooms[code]) return;
    const meta = { type: 'file', sender: label, name, size, fileType: type, totalChunks, fileId, ts: Date.now(), status: 'receiving' };
    rooms[code].fileBuffers[fileId] = { meta, chunks: [], received: 0 };
    io.to(code).emit('file:start', { ...meta, fromSelf: false });
  });

  // File transfer — chunk
  socket.on('file:chunk', ({ fileId, chunkIndex, data }) => {
    const { code } = socket.data;
    if (!code || !rooms[code]) return;
    const buf = rooms[code].fileBuffers[fileId];
    if (!buf) return;
    buf.chunks[chunkIndex] = data;
    buf.received++;
    socket.to(code).emit('file:chunk', { fileId, chunkIndex, data, received: buf.received, total: buf.meta.totalChunks });
  });

  // File transfer — end
  socket.on('file:end', ({ fileId }) => {
    const { code, label } = socket.data;
    if (!code || !rooms[code]) return;
    const buf = rooms[code].fileBuffers[fileId];
    if (buf) {
      const histEntry = { ...buf.meta, status: 'done' };
      rooms[code].history.push(histEntry);
      delete rooms[code].fileBuffers[fileId];
    }
    io.to(code).emit('file:end', { fileId, sender: label });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const { code, label } = socket.data;
    if (!code || !rooms[code]) return;

    // Mark any in-progress file buffers from this sender as failed
    const room = rooms[code];
    for (const [fileId, buf] of Object.entries(room.fileBuffers)) {
      if (buf.meta.sender === label) {
        io.to(code).emit('file:failed', { fileId, sender: label });
        delete room.fileBuffers[fileId];
      }
    }

    room.users = room.users.filter(u => u.id !== socket.id);
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
