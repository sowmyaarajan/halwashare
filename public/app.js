/* ── HalwaShare frontend ──────────────────────────────── */

const CHUNK_SIZE = 64 * 1024; // 64 KB

const isRoomPage = document.body.classList.contains('room-page');

// ── Theme ─────────────────────────────────────────────────
(function initTheme() {
  if (localStorage.getItem('halwa-dark') === '1') {
    document.body.classList.add('dark');
  }
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

function isImage(type) {
  return type && type.startsWith('image/');
}

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

// ── Landing Page ───────────────────────────────────────────
if (!isRoomPage) {
  const socket = io();
  const btnCreate = document.getElementById('btn-create');
  const btnJoin = document.getElementById('btn-join');
  const inputCode = document.getElementById('input-code');
  const errorEl = document.getElementById('landing-error');
  const themeBtn = document.getElementById('theme-toggle-landing');

  themeBtn.textContent = document.body.classList.contains('dark') ? '☀️' : '🌙';
  themeBtn.addEventListener('click', toggleTheme);

  // Only allow digits
  inputCode.addEventListener('input', () => {
    inputCode.value = inputCode.value.replace(/\D/g, '').slice(0, 4);
    errorEl.classList.add('hidden');
  });

  inputCode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoin();
  });

  btnCreate.addEventListener('click', () => {
    btnCreate.disabled = true;
    btnCreate.textContent = 'Creating...';
    socket.emit('room:create', ({ code }) => {
      window.location.href = `/join/${code}`;
    });
  });

  btnJoin.addEventListener('click', doJoin);

  function doJoin() {
    const code = inputCode.value.trim();
    if (code.length !== 4) {
      showError('Please enter a 4-digit room code.');
      return;
    }
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

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  }
}

// ── Room Page ──────────────────────────────────────────────
if (isRoomPage) {
  const socket = io();

  // Extract code from URL /join/<code>
  const urlCode = window.location.pathname.split('/').pop();

  let myLabel = null;
  const fileTransfers = {}; // fileId → { meta, chunks, received }
  const objectUrls = [];    // track for cleanup

  // DOM refs
  const messagesEl = document.getElementById('messages');
  const typingEl = document.getElementById('typing-indicator');
  const msgInput = document.getElementById('msg-input');
  const btnSend = document.getElementById('btn-send');
  const btnTheme = document.getElementById('btn-theme');
  const btnSound = document.getElementById('btn-sound');
  const btnExit = document.getElementById('btn-exit');
  const fileInput = document.getElementById('file-input');
  const dropOverlay = document.getElementById('drop-overlay');
  const userListEl = document.getElementById('user-list');
  const headerCode = document.getElementById('header-code');
  const qrImg = document.getElementById('qr-img');
  const qrUrl = document.getElementById('qr-url');

  // Init UI
  btnTheme.textContent = document.body.classList.contains('dark') ? '☀️' : '🌙';
  btnSound.textContent = soundEnabled ? '🔔' : '🔕';
  headerCode.textContent = urlCode;

  btnTheme.addEventListener('click', toggleTheme);
  btnSound.addEventListener('click', toggleSound);
  btnExit.addEventListener('click', () => { window.location.href = '/'; });

  // Mobile: tap room code badge to show QR modal
  headerCode.addEventListener('click', () => {
    if (window.innerWidth <= 680) openQrModal();
  });

  // ── Join room ──────────────────────────────────────────
  const cachedLabel = sessionStorage.getItem('halwa-label');
  const cachedCode = sessionStorage.getItem('halwa-code');

  if (cachedLabel && cachedCode === urlCode) {
    // Already joined via landing page — re-join with the socket (new connection)
    sessionStorage.removeItem('halwa-label');
    sessionStorage.removeItem('halwa-code');
  }

  socket.emit('room:join', { code: urlCode }, ({ error, label, history, users }) => {
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
  });

  // ── QR Code ────────────────────────────────────────────
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

  // ── QR Modal ───────────────────────────────────────────
  const qrModal = document.getElementById('qr-modal');
  document.getElementById('qr-modal-close').addEventListener('click', closeQrModal);
  document.getElementById('qr-modal-backdrop').addEventListener('click', closeQrModal);
  function openQrModal() { qrModal.classList.remove('hidden'); }
  function closeQrModal() { qrModal.classList.add('hidden'); }

  // ── Participants ────────────────────────────────────────
  socket.on('room:users', renderUserList);

  function renderUserList(users) {
    userListEl.innerHTML = users.map(u => `
      <li class="user-item ${u === myLabel ? 'is-self' : ''}">
        <span class="user-dot"></span>
        <span>${u}${u === myLabel ? ' (you)' : ''}</span>
      </li>`).join('');
  }

  // ── Chat ───────────────────────────────────────────────
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

  // Typing indicator
  const typingUsers = new Set();
  let typingClearTimers = {};

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
      const names = arr.join(' and ');
      typingEl.textContent = `${names} ${arr.length === 1 ? 'is' : 'are'} typing...`;
      typingEl.classList.remove('hidden');
    }
  }

  // ── Render message ─────────────────────────────────────
  function renderMessage(msg) {
    const el = document.createElement('div');

    if (msg.type === 'system') {
      el.className = 'msg-system';
      el.textContent = msg.text;
      messagesEl.appendChild(el);
      return;
    }

    if (msg.type === 'file') {
      // History file entry — already completed
      const isSelf = msg.sender === myLabel;
      el.className = `msg-row ${isSelf ? 'self' : 'other'}`;
      el.innerHTML = `<span class="msg-meta">${msg.sender} · ${formatTime(msg.ts)}</span>`;
      const card = buildFileCardCompleted(msg);
      el.appendChild(card);
      messagesEl.appendChild(el);
      return;
    }

    const isSelf = msg.sender === myLabel;
    el.className = `msg-row ${isSelf ? 'self' : 'other'}`;
    el.innerHTML = `
      <span class="msg-meta">${msg.sender} · ${formatTime(msg.ts)}</span>
      <div class="msg-bubble">${escapeHtml(msg.text)}</div>
      <button class="msg-copy-btn" title="Copy text">Copy</button>`;
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

  function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── File Transfer (Send) ───────────────────────────────
  fileInput.addEventListener('change', () => {
    [...fileInput.files].forEach(sendFile);
    fileInput.value = '';
  });

  // Drag & drop
  const chatArea = document.querySelector('.chat-area');
  let dragCounter = 0;

  chatArea.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dropOverlay.classList.remove('hidden');
  });
  chatArea.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.add('hidden'); }
  });
  chatArea.addEventListener('dragover', (e) => e.preventDefault());
  chatArea.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.add('hidden');
    [...e.dataTransfer.files].forEach(sendFile);
  });

  function sendFile(file) {
    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Show sending card for self
    const isSelf = true;
    const row = document.createElement('div');
    row.className = 'msg-row self';
    row.innerHTML = `<span class="msg-meta">${myLabel} · ${formatTime(Date.now())}</span>`;
    const card = buildFileCardProgress(fileId, file.name, file.size, file.type, totalChunks);
    row.appendChild(card);
    messagesEl.appendChild(row);
    scrollToBottom();

    socket.emit('file:start', { name: file.name, size: file.size, type: file.type, totalChunks, fileId });

    const reader = new FileReader();
    let chunkIndex = 0;

    function readNextChunk() {
      const start = chunkIndex * CHUNK_SIZE;
      const slice = file.slice(start, start + CHUNK_SIZE);
      reader.readAsDataURL(slice);
    }

    reader.onload = (e) => {
      const data = e.target.result.split(',')[1]; // base64
      socket.emit('file:chunk', { fileId, chunkIndex, data });
      updateProgress(fileId, chunkIndex + 1, totalChunks);
      chunkIndex++;
      if (chunkIndex < totalChunks) {
        setTimeout(readNextChunk, 0);
      } else {
        socket.emit('file:end', { fileId });
        markFileCardDone(fileId, file.name, file.size, file.type, null);
      }
    };

    readNextChunk();
  }

  // ── File Transfer (Receive) ────────────────────────────
  socket.on('file:start', ({ fileId, name, size, fileType, totalChunks, sender, ts }) => {
    if (sender === myLabel) return; // own start echo — ignore, we already rendered
    fileTransfers[fileId] = { name, size, fileType, totalChunks, chunks: [], received: 0 };

    const row = document.createElement('div');
    row.className = 'msg-row other';
    row.innerHTML = `<span class="msg-meta">${sender} · ${formatTime(ts || Date.now())}</span>`;
    const card = buildFileCardProgress(fileId, name, size, fileType, totalChunks);
    row.appendChild(card);
    messagesEl.appendChild(row);
    scrollToBottom();
    playPing();
  });

  socket.on('file:chunk', ({ fileId, chunkIndex, data, received, total }) => {
    const t = fileTransfers[fileId];
    if (!t) return;
    t.chunks[chunkIndex] = data;
    t.received++;
    updateProgress(fileId, t.received, t.totalChunks);
  });

  socket.on('file:end', ({ fileId, sender }) => {
    const t = fileTransfers[fileId];
    if (!t) return;

    // Reassemble
    const byteArrays = t.chunks.map(b64 => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    });
    const blob = new Blob(byteArrays, { type: t.fileType });
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);

    markFileCardDone(fileId, t.name, t.size, t.fileType, url);
    delete fileTransfers[fileId];
  });

  socket.on('file:failed', ({ fileId }) => {
    const statusEl = document.getElementById(`status-${fileId}`);
    const progressWrap = document.getElementById(`progress-${fileId}`);
    if (statusEl) { statusEl.textContent = 'Transfer incomplete — sender disconnected'; statusEl.classList.add('error'); }
    if (progressWrap) progressWrap.remove();
  });

  // ── File Card builders ─────────────────────────────────
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

  function buildFileCardCompleted(msg) {
    const card = document.createElement('div');
    card.className = 'file-card';
    if (isImage(msg.fileType) && msg.url) {
      card.innerHTML = `
        <div class="file-card-header">
          <span class="file-icon">${fileIcon(msg.fileType)}</span>
          <div class="file-info">
            <div class="file-name" title="${escapeHtml(msg.name)}">${escapeHtml(msg.name)}</div>
            <div class="file-size">${formatSize(msg.size)}</div>
          </div>
        </div>
        <div class="img-preview-wrap"><img class="img-preview" src="${msg.url}" alt="${escapeHtml(msg.name)}" /></div>
        <div class="file-actions">
          <a href="${msg.url}" download="${escapeHtml(msg.name)}" class="btn btn-primary btn-download">Download</a>
        </div>`;
      card.querySelector('.img-preview').addEventListener('click', () => openLightbox(msg.url));
    } else {
      card.innerHTML = `
        <div class="file-card-header">
          <span class="file-icon">${fileIcon(msg.fileType)}</span>
          <div class="file-info">
            <div class="file-name" title="${escapeHtml(msg.name)}">${escapeHtml(msg.name)}</div>
            <div class="file-size">${formatSize(msg.size)}</div>
          </div>
        </div>
        ${msg.url ? `<div class="file-actions"><a href="${msg.url}" download="${escapeHtml(msg.name)}" class="btn btn-primary btn-download">Download</a></div>` : '<div class="file-status">File from history</div>'}`;
    }
    return card;
  }

  function updateProgress(fileId, received, total) {
    const bar = document.getElementById(`bar-${fileId}`);
    const statusEl = document.getElementById(`status-${fileId}`);
    if (!bar) return;
    const pct = Math.round((received / total) * 100);
    bar.style.width = `${pct}%`;
    if (statusEl) statusEl.textContent = `${pct}%`;
  }

  function markFileCardDone(fileId, name, size, type, url) {
    const card = document.getElementById(`card-${fileId}`);
    if (!card) return;

    const progressEl = document.getElementById(`progress-${fileId}`);
    const statusEl = document.getElementById(`status-${fileId}`);
    if (progressEl) progressEl.remove();
    if (statusEl) statusEl.remove();

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
      a.addEventListener('click', () => {
        setTimeout(() => { URL.revokeObjectURL(url); }, 60000);
      });
      actions.appendChild(a);
      card.appendChild(actions);
    }
  }

  // ── Lightbox ───────────────────────────────────────────
  function openLightbox(src) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `<button class="lightbox-close">✕</button><img src="${src}" />`;
    lb.addEventListener('click', (e) => { if (e.target === lb || e.target.classList.contains('lightbox-close')) lb.remove(); });
    document.body.appendChild(lb);
  }

  // ── Server disconnect ──────────────────────────────────
  socket.on('disconnect', () => {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#dc2626;color:#fff;text-align:center;padding:12px;font-weight:600;z-index:999';
    banner.textContent = 'Disconnected. Reconnecting...';
    document.body.appendChild(banner);
  });

  socket.on('connect', () => {
    const banner = document.querySelector('[style*="background:#dc2626"]');
    if (banner) banner.remove();
  });

  // ── Scroll ─────────────────────────────────────────────
  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Cleanup object URLs on page unload
  window.addEventListener('beforeunload', () => {
    objectUrls.forEach(u => URL.revokeObjectURL(u));
  });
}
