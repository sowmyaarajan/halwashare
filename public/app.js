/* ── HalwaShare frontend ──────────────────────────────── */

// ── WebRTC config ──────────────────────────────────────────
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443'],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};

const CHUNK_SIZE  = 64 * 1024;       // 64 KB per DataChannel send
const BUFFER_HIGH = 1 * 1024 * 1024; // 1 MB  — pause above this
const BUFFER_LOW  = 256 * 1024;      // 256 KB — resume below this

const isRoomPage = document.body.classList.contains('room-page');

// ── Theme ─────────────────────────────────────────────────
(function initTheme() {
  if (localStorage.getItem('halwa-dark') === '1') document.body.classList.add('dark');
})();

function toggleTheme() {
  const isDark = document.body.classList.toggle('dark');
  localStorage.setItem('halwa-dark', isDark ? '1' : '0');
  const btn = document.getElementById('btn-theme') || document.getElementById('theme-toggle-landing');
  if (btn) btn.textContent = isDark ? '☀️' : '🌙';
}

// ── Sound ──────────────────────────────────────────────────
let soundEnabled = localStorage.getItem('halwa-sound') !== '0';

function playPing() {
  if (!soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch (_) {}
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem('halwa-sound', soundEnabled ? '1' : '0');
  const btn = document.getElementById('btn-sound');
  if (btn) btn.textContent = soundEnabled ? '🔔' : '🔕';
}

// ── Utility ────────────────────────────────────────────────
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function fileIcon(type) {
  if (!type) return '📄';
  if (type.startsWith('image/')) return '🖼';
  if (type === 'application/pdf') return '📕';
  if (type.includes('word') || type.includes('document')) return '📝';
  if (type.includes('sheet') || type.includes('excel') || type.includes('csv')) return '📊';
  if (type.includes('zip') || type.includes('rar') || type.includes('tar') || type.includes('7z')) return '🗜';
  if (type.startsWith('video/')) return '🎬';
  if (type.startsWith('audio/')) return '🎵';
  return '📄';
}
function isImage(type) { return type && type.startsWith('image/'); }
function copyText(text) {
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}
function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Landing Page ───────────────────────────────────────────
if (!isRoomPage) {
  const socket = io();
  const btnCreate = document.getElementById('btn-create');
  const btnJoin   = document.getElementById('btn-join');
  const inputCode = document.getElementById('input-code');
  const errorEl   = document.getElementById('landing-error');
  const themeBtn  = document.getElementById('theme-toggle-landing');

  themeBtn.textContent = document.body.classList.contains('dark') ? '☀️' : '🌙';
  themeBtn.addEventListener('click', toggleTheme);

  inputCode.addEventListener('input', () => {
    inputCode.value = inputCode.value.replace(/\D/g, '').slice(0, 4);
    errorEl.classList.add('hidden');
  });
  inputCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  btnCreate.addEventListener('click', () => {
    btnCreate.disabled = true;
    btnCreate.textContent = 'Creating...';
    socket.emit('room:create', ({ code }) => { window.location.href = `/join/${code}`; });
  });
  btnJoin.addEventListener('click', doJoin);

  function doJoin() {
    const code = inputCode.value.trim();
    if (code.length !== 4) { showError('Please enter a 4-digit room code.'); return; }
    btnJoin.disabled = true;
    btnJoin.textContent = 'Joining...';
    socket.emit('room:join', { code }, ({ error, label }) => {
      if (error) {
        showError(error);
        btnJoin.disabled = false;
        btnJoin.textContent = 'Join Room';
        return;
      }
      sessionStorage.setItem('halwa-label', label);
      sessionStorage.setItem('halwa-code', code);
      window.location.href = `/join/${code}`;
    });
  }
  function showError(msg) { errorEl.textContent = msg; errorEl.classList.remove('hidden'); }
}

// ── Room Page ──────────────────────────────────────────────
if (isRoomPage) {
  const socket = io();
  const urlCode = window.location.pathname.split('/').pop();

  let myLabel = null;

  // ── WebRTC state ─────────────────────────────────────────
  // peers: socketId → { pc, dc, label, pendingCandidates, currentFileId }
  const peers = new Map();
  // incomingXfers: fileId → { name, size, mimeType, chunks[], received, total }
  const incomingXfers = new Map();
  const objectUrls = [];

  // ── DOM refs ──────────────────────────────────────────────
  const messagesEl  = document.getElementById('messages');
  const typingEl    = document.getElementById('typing-indicator');
  const msgInput    = document.getElementById('msg-input');
  const btnSend     = document.getElementById('btn-send');
  const btnTheme    = document.getElementById('btn-theme');
  const btnSound    = document.getElementById('btn-sound');
  const btnExit     = document.getElementById('btn-exit');
  const fileInput   = document.getElementById('file-input');
  const dropOverlay = document.getElementById('drop-overlay');
  const userListEl  = document.getElementById('user-list');
  const headerCode  = document.getElementById('header-code');
  const qrImg       = document.getElementById('qr-img');
  const qrUrl       = document.getElementById('qr-url');

  btnTheme.textContent = document.body.classList.contains('dark') ? '☀️' : '🌙';
  btnSound.textContent = soundEnabled ? '🔔' : '🔕';
  headerCode.textContent = urlCode;

  btnTheme.addEventListener('click', toggleTheme);
  btnSound.addEventListener('click', toggleSound);
  btnExit.addEventListener('click', () => { window.location.href = '/'; });
  headerCode.addEventListener('click', () => { if (window.innerWidth <= 680) openQrModal(); });

  // ── Join room ─────────────────────────────────────────────
  sessionStorage.removeItem('halwa-label');
  sessionStorage.removeItem('halwa-code');

  socket.emit('room:join', { code: urlCode }, ({ error, label, history, users, peers: existingPeers }) => {
    if (error) {
      document.body.innerHTML = `
        <div class="landing">
          <div class="landing-card" style="text-align:center">
            <div class="logo-icon" style="font-size:48px;margin-bottom:12px">⚠️</div>
            <h2 style="margin-bottom:12px">${error}</h2>
            <a href="/" class="btn btn-primary" style="display:inline-flex">Back to Home</a>
          </div>
        </div>`;
      return;
    }
    myLabel = label;
    renderUserList(users);
    loadHistory(history);
    loadQR(urlCode);

    // Pre-register existing peers; they will send us offers
    existingPeers.forEach(p => {
      peers.set(p.id, { pc: null, dc: null, label: p.label, pendingCandidates: [], currentFileId: null });
    });
  });

  // ── QR Code ───────────────────────────────────────────────
  async function loadQR(code) {
    try {
      const res = await fetch(`/api/qr/${code}`);
      const data = await res.json();
      if (data.qr) {
        qrImg.src = data.qr;
        qrImg.classList.remove('hidden');
        qrUrl.textContent = data.url;
        document.getElementById('qr-modal-img').src = data.qr;
        document.getElementById('qr-modal-url').textContent = data.url;
      }
    } catch (_) {}
  }

  // ── QR Modal ──────────────────────────────────────────────
  const qrModal = document.getElementById('qr-modal');
  document.getElementById('qr-modal-close').addEventListener('click', closeQrModal);
  document.getElementById('qr-modal-backdrop').addEventListener('click', closeQrModal);
  function openQrModal() { qrModal.classList.remove('hidden'); }
  function closeQrModal() { qrModal.classList.add('hidden'); }

  // ── Participants ──────────────────────────────────────────
  socket.on('room:users', renderUserList);
  function renderUserList(users) {
    userListEl.innerHTML = users.map(u => `
      <li class="user-item ${u === myLabel ? 'is-self' : ''}">
        <span class="user-dot"></span>
        <span>${u}${u === myLabel ? ' (you)' : ''}</span>
      </li>`).join('');
  }

  // ── WebRTC: Peer lifecycle ─────────────────────────────────

  function initPeer(peerId, peerLabel, isInitiator) {
    if (peers.has(peerId) && peers.get(peerId).pc) return; // already connected

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peerState = peers.get(peerId) || { pendingCandidates: [], currentFileId: null };
    peerState.pc = pc;
    peerState.dc = null;
    peerState.label = peerLabel;
    peers.set(peerId, peerState);

    function wireDataChannel(dc) {
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = BUFFER_LOW;
      peerState.dc = dc;

      dc.onopen = () => console.log(`DataChannel open with ${peerLabel}`);
      dc.onclose = () => handleDCClose(peerId);
      dc.onerror = (e) => console.error(`DataChannel error with ${peerLabel}:`, e);
      dc.onmessage = (e) => handleDCMessage(e, peerId);
    }

    if (isInitiator) {
      const dc = pc.createDataChannel('files', { ordered: true });
      wireDataChannel(dc);
    } else {
      pc.ondatachannel = (e) => wireDataChannel(e.channel);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('rtc:signal', { to: peerId, payload: { type: 'ice', candidate: e.candidate } });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        cleanupPeer(peerId);
      }
    };

    if (isInitiator) {
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => {
          socket.emit('rtc:signal', { to: peerId, payload: { type: 'offer', sdp: pc.localDescription.sdp } });
        })
        .catch(err => console.error('createOffer failed:', err));
    }
  }

  function cleanupPeer(peerId) {
    const p = peers.get(peerId);
    if (!p) return;
    if (p.dc) { try { p.dc.close(); } catch(_) {} }
    if (p.pc) { try { p.pc.close(); } catch(_) {} }
    // Mark any in-progress transfers from this peer as failed
    if (p.currentFileId) {
      const statusEl = document.getElementById(`status-${p.currentFileId}`);
      const progressEl = document.getElementById(`progress-${p.currentFileId}`);
      if (statusEl) { statusEl.textContent = 'Transfer incomplete — sender disconnected'; statusEl.classList.add('error'); }
      if (progressEl) progressEl.remove();
      incomingXfers.delete(p.currentFileId);
    }
    peers.delete(peerId);
  }

  // ── WebRTC: Signaling ─────────────────────────────────────

  // Existing peers notify us when a new peer joins
  socket.on('rtc:peer-joined', ({ id, label }) => {
    initPeer(id, label, true); // we are initiator → create offer
  });

  // Server tells us a peer disconnected
  socket.on('rtc:peer-left', ({ id }) => {
    cleanupPeer(id);
  });

  // Signaling relay: offer / answer / ICE
  socket.on('rtc:signal', async ({ from, payload }) => {
    if (payload.type === 'offer') {
      let p = peers.get(from);
      if (!p) {
        p = { pc: null, dc: null, label: '?', pendingCandidates: [], currentFileId: null };
        peers.set(from, p);
      }
      if (!p.pc) initPeer(from, p.label, false);
      const pc = peers.get(from).pc;
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('rtc:signal', { to: from, payload: { type: 'answer', sdp: pc.localDescription.sdp } });
        // Flush queued ICE candidates
        flushCandidates(from);
      } catch (err) { console.error('handle offer failed:', err); }

    } else if (payload.type === 'answer') {
      const p = peers.get(from);
      if (!p || !p.pc) return;
      try {
        await p.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        flushCandidates(from);
      } catch (err) { console.error('handle answer failed:', err); }

    } else if (payload.type === 'ice') {
      const p = peers.get(from);
      if (!p) return;
      if (p.pc && p.pc.remoteDescription) {
        try { await p.pc.addIceCandidate(payload.candidate); } catch(_) {}
      } else {
        if (!p.pendingCandidates) p.pendingCandidates = [];
        p.pendingCandidates.push(payload.candidate);
      }
    }
  });

  async function flushCandidates(peerId) {
    const p = peers.get(peerId);
    if (!p || !p.pc || !p.pendingCandidates) return;
    for (const c of p.pendingCandidates) {
      try { await p.pc.addIceCandidate(c); } catch(_) {}
    }
    p.pendingCandidates = [];
  }

  // ── WebRTC: DataChannel message handler ───────────────────

  function handleDCMessage(event, peerId) {
    const p = peers.get(peerId);
    if (!p) return;

    if (typeof event.data === 'string') {
      // Control message
      const msg = JSON.parse(event.data);

      if (msg.type === 'file:start') {
        p.currentFileId = msg.fileId;
        incomingXfers.set(msg.fileId, {
          name: msg.name,
          size: msg.size,
          mimeType: msg.mimeType,
          chunks: [],
          received: 0,
          total: msg.totalChunks
        });

      } else if (msg.type === 'file:end') {
        const xfer = incomingXfers.get(msg.fileId);
        if (!xfer) return;
        const blob = new Blob(xfer.chunks, { type: xfer.mimeType });
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        markFileCardDone(msg.fileId, xfer.name, xfer.size, xfer.mimeType, url);
        incomingXfers.delete(msg.fileId);
        p.currentFileId = null;
      }

    } else if (event.data instanceof ArrayBuffer) {
      // File chunk
      const p2 = peers.get(peerId);
      if (!p2 || !p2.currentFileId) return;
      const xfer = incomingXfers.get(p2.currentFileId);
      if (!xfer) return;
      xfer.chunks.push(event.data);
      xfer.received++;
      updateProgress(p2.currentFileId, xfer.received, xfer.total);
    }
  }

  function handleDCClose(peerId) {
    const p = peers.get(peerId);
    if (!p) return;
    if (p.currentFileId) {
      const statusEl = document.getElementById(`status-${p.currentFileId}`);
      const progressEl = document.getElementById(`progress-${p.currentFileId}`);
      if (statusEl) { statusEl.textContent = 'Transfer incomplete — sender disconnected'; statusEl.classList.add('error'); }
      if (progressEl) progressEl.remove();
      incomingXfers.delete(p.currentFileId);
      p.currentFileId = null;
    }
  }

  // ── Chat ──────────────────────────────────────────────────
  btnSend.addEventListener('click', sendMessage);
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  let typingTimer = null;
  msgInput.addEventListener('input', () => {
    socket.emit('chat:typing');
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {}, 2000);
  });

  function sendMessage() {
    const text = msgInput.value.trim();
    if (!text) return;
    socket.emit('chat:message', { text });
    msgInput.value = '';
  }

  socket.on('chat:message', (msg) => {
    renderMessage(msg);
    if (msg.type === 'chat' && msg.sender !== myLabel) playPing();
    scrollToBottom();
  });

  const typingUsers = new Set();
  const typingClearTimers = {};

  socket.on('chat:typing', ({ label }) => {
    typingUsers.add(label);
    updateTypingIndicator();
    clearTimeout(typingClearTimers[label]);
    typingClearTimers[label] = setTimeout(() => {
      typingUsers.delete(label);
      updateTypingIndicator();
    }, 2500);
  });

  function updateTypingIndicator() {
    const arr = [...typingUsers];
    if (arr.length === 0) {
      typingEl.classList.add('hidden');
      typingEl.textContent = '';
    } else {
      typingEl.textContent = `${arr.join(' and ')} ${arr.length === 1 ? 'is' : 'are'} typing...`;
      typingEl.classList.remove('hidden');
    }
  }

  // ── File send (announce + DataChannel) ───────────────────

  fileInput.addEventListener('change', () => {
    [...fileInput.files].forEach(sendFile);
    fileInput.value = '';
  });

  // Drag & drop
  const chatArea = document.querySelector('.chat-area');
  let dragCounter = 0;
  chatArea.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; dropOverlay.classList.remove('hidden'); });
  chatArea.addEventListener('dragleave', () => { dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.add('hidden'); } });
  chatArea.addEventListener('dragover', (e) => e.preventDefault());
  chatArea.addEventListener('drop', (e) => {
    e.preventDefault(); dragCounter = 0; dropOverlay.classList.add('hidden');
    [...e.dataTransfer.files].forEach(sendFile);
  });

  async function sendFile(file) {
    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Show own file card immediately
    const row = document.createElement('div');
    row.className = 'msg-row self';
    row.innerHTML = `<span class="msg-meta">${myLabel} · ${formatTime(Date.now())}</span>`;
    row.appendChild(buildFileCardProgress(fileId, file.name, file.size, file.type, totalChunks));
    messagesEl.appendChild(row);
    scrollToBottom();

    // Announce metadata to server (for history + others to show file card)
    socket.emit('file:announce', { fileId, name: file.name, size: file.size, type: file.type });

    // Collect open DataChannels
    const openDCs = [];
    for (const [, p] of peers) {
      if (p.dc && p.dc.readyState === 'open') openDCs.push(p.dc);
    }

    if (openDCs.length === 0) {
      // No peers connected yet — mark done immediately for self
      markFileCardDone(fileId, file.name, file.size, file.type, null);
      socket.emit('file:complete', { fileId });
      return;
    }

    // Send to all peers in parallel
    await Promise.all(openDCs.map(dc => sendFileToDC(file, fileId, totalChunks, dc)));

    markFileCardDone(fileId, file.name, file.size, file.type, null);
    socket.emit('file:complete', { fileId });
  }

  async function sendFileToDC(file, fileId, totalChunks, dc) {
    // Send file:start control message
    dc.send(JSON.stringify({ type: 'file:start', fileId, name: file.name, size: file.size, mimeType: file.type, totalChunks }));

    // Send chunks as ArrayBuffer
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const slice = file.slice(start, start + CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();

      // Backpressure: wait if buffer is too full
      if (dc.bufferedAmount > BUFFER_HIGH) {
        await new Promise(resolve => {
          dc.onbufferedamountlow = () => {
            dc.onbufferedamountlow = null;
            resolve();
          };
        });
      }

      if (dc.readyState !== 'open') break; // peer disconnected mid-send
      try {
        dc.send(buffer);
      } catch (_) { break; }
    }

    // Send file:end control message
    if (dc.readyState === 'open') {
      dc.send(JSON.stringify({ type: 'file:end', fileId }));
    }
  }

  // ── File announce from server (others see file card) ─────
  socket.on('file:announce', (meta) => {
    if (meta.sender === myLabel) return;
    const row = document.createElement('div');
    row.className = 'msg-row other';
    row.innerHTML = `<span class="msg-meta">${meta.sender} · ${formatTime(meta.ts)}</span>`;
    row.appendChild(buildFileCardProgress(meta.fileId, meta.name, meta.size, meta.fileType, null));
    messagesEl.appendChild(row);
    scrollToBottom();
    playPing();
  });

  // ── Render messages ───────────────────────────────────────
  function renderMessage(msg) {
    const el = document.createElement('div');

    if (msg.type === 'system') {
      el.className = 'msg-system';
      el.textContent = msg.text;
      messagesEl.appendChild(el);
      return;
    }

    if (msg.type === 'file') {
      const isSelf = msg.sender === myLabel;
      el.className = `msg-row ${isSelf ? 'self' : 'other'}`;
      el.innerHTML = `<span class="msg-meta">${msg.sender} · ${formatTime(msg.ts)}</span>`;
      el.appendChild(buildFileCardHistory(msg));
      messagesEl.appendChild(el);
      return;
    }

    const isSelf = msg.sender === myLabel;
    el.className = `msg-row ${isSelf ? 'self' : 'other'}`;
    el.innerHTML = `
      <span class="msg-meta">${msg.sender} · ${formatTime(msg.ts)}</span>
      <div class="msg-bubble">${escapeHtml(msg.text)}</div>
      <button class="msg-copy-btn">Copy</button>`;
    el.querySelector('.msg-copy-btn').addEventListener('click', () => {
      copyText(msg.text);
      const btn = el.querySelector('.msg-copy-btn');
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    });
    messagesEl.appendChild(el);
  }

  function loadHistory(history) {
    history.forEach(renderMessage);
    scrollToBottom();
  }

  // ── File card builders ────────────────────────────────────

  function buildFileCardProgress(fileId, name, size, type, totalChunks) {
    const card = document.createElement('div');
    card.className = 'file-card';
    card.id = `card-${fileId}`;
    card.innerHTML = `
      <div class="file-card-header">
        <span class="file-icon">${fileIcon(type)}</span>
        <div class="file-info">
          <div class="file-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
          <div class="file-size">${formatSize(size)}</div>
        </div>
      </div>
      <div class="file-progress" id="progress-${fileId}">
        <div class="file-progress-bar" id="bar-${fileId}" style="width:0%"></div>
      </div>
      <div class="file-status" id="status-${fileId}">Transferring…</div>`;
    return card;
  }

  // For history entries (late joiners, or completed files shown on re-join)
  function buildFileCardHistory(msg) {
    const card = document.createElement('div');
    card.className = 'file-card';
    card.innerHTML = `
      <div class="file-card-header">
        <span class="file-icon">${fileIcon(msg.fileType)}</span>
        <div class="file-info">
          <div class="file-name" title="${escapeHtml(msg.name)}">${escapeHtml(msg.name)}</div>
          <div class="file-size">${formatSize(msg.size)}</div>
        </div>
      </div>
      <div class="file-status">${msg.status === 'done' ? 'Sent while you were away' : 'Transferring…'}</div>`;
    return card;
  }

  function updateProgress(fileId, received, total) {
    const bar = document.getElementById(`bar-${fileId}`);
    const statusEl = document.getElementById(`status-${fileId}`);
    if (!bar) return;
    const pct = total ? Math.round((received / total) * 100) : 0;
    bar.style.width = `${pct}%`;
    if (statusEl) statusEl.textContent = `${pct}%`;
  }

  function markFileCardDone(fileId, name, size, type, url) {
    const card = document.getElementById(`card-${fileId}`);
    if (!card) return;
    document.getElementById(`progress-${fileId}`)?.remove();
    document.getElementById(`status-${fileId}`)?.remove();

    if (isImage(type) && url) {
      const imgWrap = document.createElement('div');
      imgWrap.className = 'img-preview-wrap';
      const img = document.createElement('img');
      img.className = 'img-preview';
      img.src = url;
      img.alt = name;
      img.addEventListener('click', () => openLightbox(url));
      imgWrap.appendChild(img);
      card.appendChild(imgWrap);
    }

    if (url) {
      const actions = document.createElement('div');
      actions.className = 'file-actions';
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.className = 'btn btn-primary btn-download';
      a.textContent = 'Download';
      a.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(url), 60000));
      actions.appendChild(a);
      card.appendChild(actions);
    } else {
      const done = document.createElement('div');
      done.className = 'file-status';
      done.textContent = url === null && type ? 'Sent ✓' : 'Sent ✓';
      card.appendChild(done);
    }
  }

  // ── Lightbox ──────────────────────────────────────────────
  function openLightbox(src) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `<button class="lightbox-close">✕</button><img src="${src}" />`;
    lb.addEventListener('click', (e) => { if (e.target === lb || e.target.classList.contains('lightbox-close')) lb.remove(); });
    document.body.appendChild(lb);
  }

  // ── Server disconnect ─────────────────────────────────────
  socket.on('disconnect', () => {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#dc2626;color:#fff;text-align:center;padding:12px;font-weight:600;z-index:999';
    banner.textContent = 'Disconnected. Reconnecting...';
    document.body.appendChild(banner);
  });
  socket.on('connect', () => {
    document.querySelector('[style*="background:#dc2626"]')?.remove();
  });

  // ── Scroll ────────────────────────────────────────────────
  function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  window.addEventListener('beforeunload', () => {
    objectUrls.forEach(u => URL.revokeObjectURL(u));
    for (const [, p] of peers) {
      try { p.dc?.close(); p.pc?.close(); } catch(_) {}
    }
  });
}
