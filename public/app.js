/* ── HalwaShare client ─────────────────────────────────────
   Files are offered, not pushed. Picking a file publishes only its
   name and size, which is instant even for a 20 GB file. The bytes
   move when someone asks for them, straight from disk to the wire
   to the other side's disk — never fully held in memory.

   Transport is a WebRTC DataChannel. If that cannot be established
   (client-isolated Wi-Fi, blocked UDP) the same protocol runs over
   the server as a relay, so a transfer never silently dies. */

'use strict';

/* ── Tunables ──────────────────────────────────────────────── */
const DEFAULT_RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  iceCandidatePoolSize: 4,
};

/* STUN alone cannot get through every NAT. When the deployment supplies TURN
   credentials we use them; without them those pairs fall back to the relay. */
let rtcConfig = DEFAULT_RTC_CONFIG;
const rtcConfigReady = (async () => {
  try {
    const res = await fetch('/api/rtc-config');
    const data = await res.json();
    if (data && Array.isArray(data.iceServers) && data.iceServers.length) {
      rtcConfig = { iceServers: data.iceServers, iceCandidatePoolSize: 4 };
    }
  } catch (_) { /* defaults are fine */ }
  return rtcConfig;
})();

const MAX_CHUNK        = 256 * 1024;      // ceiling for a DataChannel frame
const RELAY_CHUNK      = 128 * 1024;      // smaller frames over socket.io
const BUFFER_HIGH      = 8 * 1024 * 1024; // pause filling the send buffer above this
const BUFFER_LOW       = 1 * 1024 * 1024; // resume below this
const RELAY_WINDOW     = 4 * 1024 * 1024; // unacknowledged bytes allowed on the relay
const RELAY_ACK_EVERY  = 1 * 1024 * 1024;
const P2P_GRACE        = 10000;           // ms before falling back to the relay
const AUTO_PREVIEW_MAX = 5 * 1024 * 1024; // images this small arrive automatically

const isRoomPage = document.body.classList.contains('room-page');

/* ── Theme ─────────────────────────────────────────────────── */
(function initTheme() {
  try {
    const saved = localStorage.getItem('halwa-theme');
    const dark = saved ? saved === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) document.body.classList.add('dark');
  } catch (_) {}
})();

function syncThemeButtons() {
  const dark = document.body.classList.contains('dark');
  document.querySelectorAll('[data-theme-btn]').forEach(b => {
    b.textContent = dark ? '☀️' : '🌙';
  });
}

function toggleTheme() {
  const dark = document.body.classList.toggle('dark');
  try { localStorage.setItem('halwa-theme', dark ? 'dark' : 'light'); } catch (_) {}
  syncThemeButtons();
}

/* ── Sound ─────────────────────────────────────────────────── */
let soundEnabled = true;
try { soundEnabled = localStorage.getItem('halwa-sound') !== '0'; } catch (_) {}
let audioCtx = null;

function beep(freq, dur) {
  if (!soundEnabled) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0008, audioCtx.currentTime + dur);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  } catch (_) {}
}
const playPing = () => beep(880, 0.22);
const playDone = () => beep(1180, 0.3);

function toggleSound() {
  soundEnabled = !soundEnabled;
  try { localStorage.setItem('halwa-sound', soundEnabled ? '1' : '0'); } catch (_) {}
  const btn = document.getElementById('btn-sound');
  if (btn) btn.textContent = soundEnabled ? '🔔' : '🔕';
}

/* ── Formatting ────────────────────────────────────────────── */
function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec < 1) return '';
  if (bytesPerSec < 1048576) return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
  return (bytesPerSec / 1048576).toFixed(1) + ' MB/s';
}

function formatEta(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '';
  if (seconds < 1) return 'almost done';
  if (seconds < 60) return Math.ceil(seconds) + 's left';
  const m = Math.floor(seconds / 60);
  if (m < 60) return m + 'm ' + Math.ceil(seconds % 60) + 's left';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm left';
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fileIcon(type, name) {
  const t = (type || '').toLowerCase();
  const ext = (name || '').split('.').pop().toLowerCase();
  if (t.startsWith('image/')) return '🖼️';
  if (t.startsWith('video/')) return '🎬';
  if (t.startsWith('audio/')) return '🎵';
  if (t === 'application/pdf' || ext === 'pdf') return '📕';
  if (/zip|rar|7z|tar|gz/.test(t + ext)) return '🗃️';
  if (/word|document/.test(t) || /docx?/.test(ext)) return '📝';
  if (/sheet|excel|csv/.test(t) || /xlsx?|csv/.test(ext)) return '📊';
  if (/presentation|powerpoint/.test(t) || /pptx?/.test(ext)) return '📈';
  if (/^(js|ts|json|html|css|py|java|cs|go|rs|sh)$/.test(ext)) return '📄';
  return '📁';
}

const isImage = (type) => !!type && type.startsWith('image/');

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Escape first, then turn bare URLs into links. */
function linkify(text) {
  return escapeHtml(text).replace(
    /\b(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(fallbackCopy);
  }
  return Promise.resolve(fallbackCopy());
  function fallbackCopy() {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
  }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ── Landing page ──────────────────────────────────────────── */
if (!isRoomPage) {
  const socket    = io();
  const btnCreate = document.getElementById('btn-create');
  const btnJoin   = document.getElementById('btn-join');
  const inputCode = document.getElementById('input-code');
  const errorEl   = document.getElementById('landing-error');

  syncThemeButtons();
  document.querySelectorAll('[data-theme-btn]').forEach(b =>
    b.addEventListener('click', toggleTheme));

  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  };

  inputCode.addEventListener('input', () => {
    inputCode.value = inputCode.value.replace(/\D/g, '').slice(0, 4);
    errorEl.classList.add('hidden');
    if (inputCode.value.length === 4) doJoin();
  });
  inputCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

  btnCreate.addEventListener('click', () => {
    btnCreate.disabled = true;
    btnCreate.textContent = 'Creating…';
    socket.emit('room:create', (res) => {
      window.location.href = '/join/' + res.code;
    });
  });

  btnJoin.addEventListener('click', doJoin);

  let joining = false;
  function doJoin() {
    if (joining) return;
    const code = inputCode.value.trim();
    if (code.length !== 4) return showError('Enter the 4-digit room code.');
    joining = true;
    btnJoin.disabled = true;
    btnJoin.textContent = 'Joining…';
    // Only check here — the actual join happens on the room page, so we
    // never occupy two slots at once.
    socket.emit('room:check', { code }, (res) => {
      if (res && res.error) {
        joining = false;
        showError(res.error);
        btnJoin.disabled = false;
        btnJoin.textContent = 'Join room';
        return;
      }
      window.location.href = '/join/' + code;
    });
  }
}

/* ── Download sinks ────────────────────────────────────────────
   Three strategies, best first:
     disk-picker : File System Access API — true streaming, any size
     disk-stream : service worker stream — true streaming, any size
     memory      : Blob in RAM — the last resort, fine for small files  */

let swRegistration = null;
if (isRoomPage && 'serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js')
    .then(reg => { swRegistration = reg; })
    .catch(() => {});
}

function canStreamToDisk() {
  if (window.isSecureContext && typeof window.showSaveFilePicker === 'function') return true;
  return !!(window.isSecureContext && 'serviceWorker' in navigator);
}

async function makePickerSink(name) {
  if (!window.isSecureContext || typeof window.showSaveFilePicker !== 'function') return null;
  const handle = await window.showSaveFilePicker({ suggestedName: name });
  const writable = await handle.createWritable();
  return {
    kind: 'disk-picker',
    write: (chunk) => writable.write(chunk),
    close: async () => { await writable.close(); return null; },
    abort: async () => { try { await writable.abort(); } catch (_) {} },
  };
}

async function makeStreamSink(name, size) {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try {
    await navigator.serviceWorker.ready;
    const ctrl = navigator.serviceWorker.controller;
    if (!ctrl) return null;

    const id = uid();
    const channel = new MessageChannel();
    let resolveReady;
    const ready = new Promise(r => { resolveReady = r; });
    let waiter = null;
    let blocked = false;

    channel.port1.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'ready') return resolveReady(true);
      if (m.type === 'ack') {
        blocked = m.desired <= 0;
        if (!blocked && waiter) { const w = waiter; waiter = null; w(); }
      }
      if (m.type === 'cancelled' && waiter) { const w = waiter; waiter = null; w(); }
    };

    ctrl.postMessage({ type: 'init', id, name, size }, [channel.port2]);
    const ok = await Promise.race([ready, new Promise(r => setTimeout(() => r(false), 3000))]);
    if (!ok) return null;

    // Handing the URL to a hidden iframe starts the browser's own download.
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.src = '/__dl/' + id;
    document.body.appendChild(frame);

    return {
      kind: 'disk-stream',
      async write(chunk) {
        if (blocked) {
          await new Promise(r => {
            waiter = r;
            setTimeout(() => { if (waiter === r) { waiter = null; r(); } }, 2000);
          });
        }
        const buf = chunk.buffer;
        channel.port1.postMessage(
          { type: 'chunk', buf, offset: chunk.byteOffset },
          [buf] // zero-copy handoff
        );
      },
      async close() {
        channel.port1.postMessage({ type: 'end' });
        setTimeout(() => frame.remove(), 4000);
        return null;
      },
      async abort() {
        try { channel.port1.postMessage({ type: 'abort' }); } catch (_) {}
        frame.remove();
      },
    };
  } catch (_) {
    return null;
  }
}

function makeMemorySink(mime) {
  const parts = [];
  return {
    kind: 'memory',
    write(chunk) { parts.push(new Uint8Array(chunk)); },
    async close() { return URL.createObjectURL(new Blob(parts, { type: mime || '' })); },
    async abort() { parts.length = 0; },
  };
}

/* Chrome runs Safe Browsing over files written through the File System Access
   API and rejects close() for executables it cannot vouch for — throwing away
   everything already written. Those extensions skip the picker and take the
   ordinary download route instead, where the browser offers Keep / Discard
   rather than failing outright. */
const RISKY_EXT =
  /\.(exe|dll|msi|msp|bat|cmd|com|scr|pif|cpl|msc|hta|lnk|inf|sys|drv|ocx|reg|vbs|vbe|wsf|wsh|ps1|psm1|jar|apk|app|dmg|pkg|deb|rpm|iso|img|gadget)$/i;

function isRiskyDownload(name) {
  return RISKY_EXT.test(String(name || '').trim());
}

function describeSaveError(err) {
  const msg = String((err && err.message) || err || '');
  if (/safe.?browsing|blocked|dangerous/i.test(msg)) {
    return 'Your browser blocked this file type. Ask the sender to zip it and send the zip instead.';
  }
  return 'Could not finish saving: ' + msg;
}

/* `preferMemory` is used for inline image previews, which we want to
   show in the page rather than save to disk. */
async function createSink(name, size, mime, preferMemory) {
  if (!preferMemory) {
    if (!isRiskyDownload(name)) {
      try {
        const picker = await makePickerSink(name);
        if (picker) return picker;
      } catch (err) {
        if (err && err.name === 'AbortError') throw err; // user cancelled — respect it
      }
    }
    const streamed = await makeStreamSink(name, size);
    if (streamed) return streamed;
  }
  return makeMemorySink(mime);
}

/* ── Room page ─────────────────────────────────────────────── */
if (isRoomPage) {
  const socket  = io({ reconnectionDelayMax: 4000 });
  const urlCode = window.location.pathname.split('/').pop();

  let clientId;
  try {
    clientId = sessionStorage.getItem('halwa-client') || uid();
    sessionStorage.setItem('halwa-client', clientId);
  } catch (_) { clientId = uid(); }

  let myLabel = null;
  let mySocketId = null;
  let joined = false;

  const peers    = new Map(); // socketId -> Peer
  const myFiles  = new Map(); // fileId -> File (handles only, no bytes copied)
  const cards    = new Map(); // fileId -> card refs
  const incoming = new Map(); // peerId + ':' + tag -> transfer state
  const receipts = new Map(); // chat msg id -> { ticks, acked, expected }
  const objectUrls = [];
  let roomUsers = [];
  let tagSeq = 0;

  /* ── DOM ─────────────────────────────────────────────────── */
  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages');
  const emptyState = $('empty-state');
  const typingEl   = $('typing-indicator');
  const msgInput   = $('msg-input');
  const btnSend    = $('btn-send');
  const btnSound   = $('btn-sound');
  const btnExit    = $('btn-exit');
  const fileInput  = $('file-input');
  const dropZone   = $('drop-overlay');
  const userListEl = $('user-list');
  const headerCode = $('header-code');
  const linkEl     = $('share-link');
  const qrImg      = $('qr-img');
  const toastsEl   = $('toasts');
  const capsEl     = $('caps-note');

  headerCode.textContent = urlCode;
  btnSound.textContent = soundEnabled ? '🔔' : '🔕';
  syncThemeButtons();

  document.querySelectorAll('[data-theme-btn]').forEach(b =>
    b.addEventListener('click', toggleTheme));
  btnSound.addEventListener('click', toggleSound);
  btnExit.addEventListener('click', () => { window.location.href = '/'; });

  /* ── Toasts ──────────────────────────────────────────────── */
  function toast(message, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' toast-' + kind : '');
    el.textContent = message;
    toastsEl.appendChild(el);
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 300);
    }, 4200);
  }

  /* ── Join ────────────────────────────────────────────────── */
  function join() {
    socket.emit('room:join', { code: urlCode, clientId }, (res) => {
      if (res && res.error) return showFatal(res.error);

      const first = !joined;
      joined = true;
      myLabel = res.label;
      mySocketId = res.selfId;

      renderUsers(res.users);
      if (first) {
        loadQR(urlCode);
        res.history.forEach(renderHistoryEntry);
        showCapabilityNote();
      }
      // Peers already here will send us their offers.
      res.peers.forEach(p => ensurePeer(p.id, p.label));
      updateEmptyState();
    });
  }

  socket.on('connect', () => {
    $('offline-banner').classList.add('hidden');
    join();
  });

  socket.on('disconnect', () => {
    $('offline-banner').classList.remove('hidden');
  });

  function showFatal(message) {
    document.body.innerHTML =
      '<div class="fatal">' +
        '<div class="fatal-card">' +
          '<div class="fatal-icon">⚠️</div>' +
          '<h2>' + escapeHtml(message) + '</h2>' +
          '<a href="/" class="btn btn-primary">Back to start</a>' +
        '</div>' +
      '</div>';
  }

  function showCapabilityNote() {
    if (canStreamToDisk()) {
      capsEl.textContent = 'Streaming mode — no size limit';
      capsEl.className = 'caps-note ok';
    } else {
      capsEl.textContent = 'Buffered mode — keep files under ~1 GB';
      capsEl.className = 'caps-note warn';
      capsEl.title = 'Serve HalwaShare over HTTPS to stream huge files straight to disk.';
    }
  }

  /* ── Share link + QR ─────────────────────────────────────── */
  async function loadQR(code) {
    try {
      const res = await fetch('/api/qr/' + code);
      const data = await res.json();
      if (!data.qr) return;
      qrImg.src = data.qr;
      qrImg.classList.remove('hidden');
      linkEl.textContent = data.url;
      linkEl.dataset.url = data.url;
    } catch (_) {}
  }

  $('btn-copy-link').addEventListener('click', () => {
    copyText(linkEl.dataset.url || window.location.href);
    toast('Link copied');
  });
  headerCode.addEventListener('click', () => {
    copyText(urlCode);
    toast('Room code copied');
  });

  /* ── Participants ────────────────────────────────────────── */
  socket.on('room:users', renderUsers);

  function renderUsers(users) {
    roomUsers = users;
    userListEl.innerHTML = users.map(u => {
      const self = u.label === myLabel;
      const peer = peers.get(u.id);
      const mode = self ? '' : (peer ? peer.mode : 'connecting');
      const badge = self ? '' :
        '<span class="mode-pill mode-' + mode + '">' + modeLabel(mode) + '</span>';
      return '<li class="user-item">' +
        '<span class="avatar">' + escapeHtml(u.label.replace(/\D/g, '') || '?') + '</span>' +
        '<span class="user-name">' + escapeHtml(u.label) + (self ? ' (you)' : '') + '</span>' +
        badge +
      '</li>';
    }).join('');
    $('user-count').textContent = users.length;
  }

  function modeLabel(mode) {
    if (mode === 'p2p') return 'direct';
    if (mode === 'relay') return 'relay';
    if (mode === 'dead') return 'offline';
    return '…';
  }

  /* Repaint the roster from local peer state — no round trip needed
     when only a connection mode changed. */
  function refreshUsers() {
    if (!myLabel) return;
    const users = [{ id: mySocketId, label: myLabel }]
      .concat([...peers.values()].map(p => ({ id: p.id, label: p.label })));
    renderUsers(users);
  }

  /* ── Peer: one per participant, DataChannel or relay ─────── */
  class Peer {
    constructor(id, label) {
      this.id = id;
      this.label = label || '…';
      this.mode = 'connecting';
      this.pc = null;
      this.dc = null;
      this.pendingCandidates = [];
      this.sendQueue = Promise.resolve();
      this.relayInflight = 0;
      this.relayWaiters = [];
      this.graceTimer = null;
      this.openWaiters = [];
    }

    get chunkSize() {
      if (this.mode === 'relay') return RELAY_CHUNK;
      const max = (this.pc && this.pc.sctp && this.pc.sctp.maxMessageSize) || 65536;
      return Math.max(16 * 1024, Math.min(MAX_CHUNK, max - 1024));
    }

    /* Resolves once this peer can carry data, either way. */
    ready() {
      if (this.mode === 'p2p' || this.mode === 'relay') return Promise.resolve(this);
      if (this.mode === 'dead') return Promise.reject(new Error(this.label + ' is offline'));
      return new Promise((resolve, reject) => {
        this.openWaiters.push({ resolve, reject });
      });
    }

    settle(mode) {
      if (this.mode === mode) return;
      this.mode = mode;
      clearTimeout(this.graceTimer);
      const waiters = this.openWaiters;
      this.openWaiters = [];
      if (mode === 'dead') {
        waiters.forEach(w => w.reject(new Error(this.label + ' is offline')));
      } else {
        waiters.forEach(w => w.resolve(this));
      }
      refreshUsers();
    }

    sendCtrl(msg) {
      if (this.mode === 'p2p' && this.dc && this.dc.readyState === 'open') {
        this.dc.send(JSON.stringify(msg));
      } else {
        socket.emit('relay:ctrl', { to: this.id, msg });
      }
    }

    /* One framed chunk, honouring backpressure so memory stays flat. */
    async sendChunk(tag, view) {
      if (this.mode === 'relay') {
        while (this.relayInflight >= RELAY_WINDOW) {
          await new Promise(r => this.relayWaiters.push(r));
        }
        this.relayInflight += view.byteLength;
        socket.emit('relay:chunk', { to: this.id, tag, buf: view });
        return;
      }

      const dc = this.dc;
      if (!dc || dc.readyState !== 'open') throw new Error('Link to ' + this.label + ' closed');

      if (dc.bufferedAmount > BUFFER_HIGH) await this.waitDrain();

      // 4-byte tag header lets several files share one channel safely.
      const frame = new Uint8Array(4 + view.byteLength);
      new DataView(frame.buffer).setUint32(0, tag);
      frame.set(view, 4);
      dc.send(frame.buffer);
    }

    /* Polls as well as listens: the bufferedamountlow event is not
       guaranteed to fire if the buffer drained before we subscribed. */
    waitDrain() {
      return new Promise((resolve) => {
        const dc = this.dc;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearInterval(poll);
          if (dc) dc.removeEventListener('bufferedamountlow', finish);
          resolve();
        };
        const poll = setInterval(() => {
          if (!this.dc || this.dc.readyState !== 'open') return finish();
          if (this.dc.bufferedAmount <= BUFFER_LOW) finish();
        }, 40);
        if (dc) dc.addEventListener('bufferedamountlow', finish);
      });
    }

    creditRelay(bytes) {
      this.relayInflight = Math.max(0, this.relayInflight - bytes);
      if (this.relayInflight < RELAY_WINDOW) {
        const waiters = this.relayWaiters;
        this.relayWaiters = [];
        waiters.forEach(w => w());
      }
    }

    /* Transfers to one peer run one at a time — sharing a link between
       two files just makes both slower. */
    enqueue(task) {
      this.sendQueue = this.sendQueue.then(task, task);
      return this.sendQueue;
    }

    close() {
      clearTimeout(this.graceTimer);
      try { if (this.dc) this.dc.close(); } catch (_) {}
      try { if (this.pc) this.pc.close(); } catch (_) {}
      this.relayWaiters.forEach(w => w());
      this.relayWaiters = [];
    }
  }

  function ensurePeer(id, label) {
    let peer = peers.get(id);
    if (!peer) {
      peer = new Peer(id, label);
      peers.set(id, peer);
      // If WebRTC has not come up by the time the grace period ends,
      // switch this peer to the relay rather than hang.
      peer.graceTimer = setTimeout(() => {
        if (peer.mode === 'connecting') {
          peer.settle('relay');
          console.info('[halwa] falling back to relay for', peer.label);
        }
      }, P2P_GRACE);
    } else if (label) {
      peer.label = label;
    }
    return peer;
  }

  async function startOffer(peer) {
    await rtcConfigReady;
    if (peer.pc) return;
    const pc = buildPC(peer);
    const dc = pc.createDataChannel('halwa', { ordered: true });
    wireChannel(peer, dc);
    pc.createOffer()
      .then(o => pc.setLocalDescription(o))
      .then(() => socket.emit('rtc:signal', {
        to: peer.id,
        payload: { type: 'offer', sdp: pc.localDescription.sdp },
      }))
      .catch(err => console.warn('[halwa] offer failed', err));
  }

  function buildPC(peer) {
    const pc = new RTCPeerConnection(rtcConfig);
    peer.pc = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('rtc:signal', {
          to: peer.id,
          payload: { type: 'ice', candidate: e.candidate },
        });
      }
    };
    pc.ondatachannel = (e) => wireChannel(peer, e.channel);
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') {
        // Keep the peer usable — the relay can carry everything.
        if (peer.mode !== 'dead') peer.settle('relay');
      }
    };
    return pc;
  }

  function wireChannel(peer, dc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
    peer.dc = dc;

    dc.onopen = () => peer.settle('p2p');
    dc.onclose = () => { if (peer.mode === 'p2p') peer.settle('relay'); };
    dc.onerror = () => { if (peer.mode === 'p2p') peer.settle('relay'); };
    dc.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let msg = null;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        handleCtrl(peer, msg);
      } else {
        if (e.data.byteLength < 4) return;
        const tag = new DataView(e.data).getUint32(0);
        const payload = new Uint8Array(e.data, 4);
        handleChunk(peer, tag, payload, payload.byteLength);
      }
    };
  }

  /* ── Signalling ──────────────────────────────────────────── */
  socket.on('rtc:peer-joined', ({ id, label }) => {
    const peer = ensurePeer(id, label);
    startOffer(peer); // the established side always offers
    refreshUsers();
  });

  socket.on('rtc:peer-left', ({ id }) => {
    const peer = peers.get(id);
    if (!peer) return;
    peer.settle('dead');
    failTransfersFrom(id, 'the sender went offline');
    peer.close();
    peers.delete(id);
    refreshUsers();
  });

  socket.on('rtc:signal', async ({ from, payload }) => {
    const peer = ensurePeer(from);
    try {
      if (payload.type === 'offer') {
        await rtcConfigReady;
        if (!peer.pc) buildPC(peer);
        await peer.pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        socket.emit('rtc:signal', {
          to: from,
          payload: { type: 'answer', sdp: peer.pc.localDescription.sdp },
        });
        await flushCandidates(peer);

      } else if (payload.type === 'answer') {
        if (!peer.pc) return;
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        await flushCandidates(peer);

      } else if (payload.type === 'ice') {
        if (peer.pc && peer.pc.remoteDescription) {
          try { await peer.pc.addIceCandidate(payload.candidate); } catch (_) {}
        } else {
          peer.pendingCandidates.push(payload.candidate);
        }
      }
    } catch (err) {
      console.warn('[halwa] signalling error', err);
      if (peer.mode === 'connecting') peer.settle('relay');
    }
  });

  async function flushCandidates(peer) {
    const list = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const c of list) {
      try { await peer.pc.addIceCandidate(c); } catch (_) {}
    }
  }

  /* ── Relay transport ─────────────────────────────────────── */
  socket.on('relay:ctrl', ({ from, msg }) => {
    const peer = ensurePeer(from);
    if (peer.mode === 'connecting') peer.settle('relay');
    handleCtrl(peer, msg);
  });

  socket.on('relay:chunk', ({ from, tag, buf }) => {
    const peer = ensurePeer(from);
    const view = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer || buf);
    handleChunk(peer, tag, view, view.byteLength);
  });

  /* ── Control protocol ────────────────────────────────────── */
  function handleCtrl(peer, msg) {
    if (!msg || !msg.t) return;

    switch (msg.t) {
      case 'req':                    // someone wants a file we offered
        peer.enqueue(() => serveFile(peer, msg.fileId).catch(err => {
          peer.sendCtrl({ t: 'err', fileId: msg.fileId, reason: String(err.message || err) });
        }));
        break;

      case 'start': {                // the owner is about to stream
        const xfer = pendingRequests.get(msg.fileId);
        if (!xfer) return;
        pendingRequests.delete(msg.fileId);
        xfer.tag = msg.tag;
        xfer.size = msg.size;
        xfer.received = 0;
        xfer.startedAt = performance.now();
        xfer.lastTick = xfer.startedAt;
        xfer.lastBytes = 0;
        xfer.peerId = peer.id;
        incoming.set(peer.id + ':' + msg.tag, xfer);
        setCardState(msg.fileId, 'active', 'Receiving…');
        break;
      }

      case 'end': {
        const xfer = incoming.get(peer.id + ':' + msg.tag);
        if (!xfer) return;
        incoming.delete(peer.id + ':' + msg.tag);
        finishIncoming(xfer);
        break;
      }

      case 'ack':                    // relay flow control
        peer.creditRelay(msg.bytes || 0);
        break;

      case 'got': {                  // a receiver confirmed the whole file
        const card = cards.get(msg.fileId);
        if (!card || !card.mine) return;
        card.gotBy = card.gotBy || new Set();
        card.gotBy.add(peer.label);
        setCardState(msg.fileId, 'done',
          '✓✓ Downloaded by ' + [...card.gotBy].join(', '));
        card.el.classList.add('received');
        break;
      }

      case 'err': {
        const xfer = pendingRequests.get(msg.fileId) ||
          [...incoming.values()].find(x => x.fileId === msg.fileId);
        if (xfer) abortIncoming(xfer, msg.reason || 'Transfer failed');
        else setCardState(msg.fileId, 'error', msg.reason || 'Transfer failed');
        break;
      }
    }
  }

  function handleChunk(peer, tag, view, byteLength) {
    const key = peer.id + ':' + tag;
    const xfer = incoming.get(key);
    if (!xfer) return;

    xfer.received += byteLength;
    xfer.pending = (xfer.pending || Promise.resolve()).then(() => xfer.sink.write(view))
      .catch(err => abortIncoming(xfer, describeSaveError(err)));

    if (peer.mode === 'relay') {
      xfer.sinceAck = (xfer.sinceAck || 0) + byteLength;
      if (xfer.sinceAck >= RELAY_ACK_EVERY) {
        peer.sendCtrl({ t: 'ack', bytes: xfer.sinceAck });
        xfer.sinceAck = 0;
      }
    }
    tickProgress(xfer);
  }

  function failTransfersFrom(peerId, reason) {
    for (const [key, xfer] of [...incoming]) {
      if (xfer.peerId === peerId) {
        incoming.delete(key);
        abortIncoming(xfer, 'Transfer stopped — ' + reason);
      }
    }
    for (const [fileId, xfer] of [...pendingRequests]) {
      if (xfer.ownerId === peerId) {
        pendingRequests.delete(fileId);
        abortIncoming(xfer, 'Transfer stopped — ' + reason);
      }
    }
  }

  /* ── Sending: offer now, stream on demand ────────────────── */
  fileInput.addEventListener('change', () => {
    [...fileInput.files].forEach(offerFile);
    fileInput.value = '';
  });

  const chatArea = document.querySelector('.chat-area');
  let dragDepth = 0;
  ['dragenter', 'dragover'].forEach(ev =>
    chatArea.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'dragenter') dragDepth++;
      dropZone.classList.remove('hidden');
    }));
  chatArea.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; dropZone.classList.add('hidden'); }
  });
  chatArea.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropZone.classList.add('hidden');
    [...(e.dataTransfer.files || [])].forEach(offerFile);
  });

  // Paste a screenshot straight into the room.
  document.addEventListener('paste', (e) => {
    const items = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (items.length) {
      e.preventDefault();
      items.forEach(offerFile);
    }
  });

  function offerFile(file) {
    if (!file) return;
    const fileId = uid();
    myFiles.set(fileId, file);

    const meta = {
      fileId, name: file.name, size: file.size, fileType: file.type,
      sender: myLabel, ownerId: mySocketId, ts: Date.now(), available: true,
    };
    const card = renderFileCard(meta, true);

    // Show our own image immediately from the local file — no transfer needed.
    if (isImage(file.type)) {
      const url = URL.createObjectURL(file);
      objectUrls.push(url);
      attachPreview(card, url, file.name);
    }
    setCardState(fileId, 'ready', peers.size ? 'Ready to send' : 'Waiting for someone to join');

    socket.emit('file:offer', {
      fileId, name: file.name, size: file.size, type: file.type,
    });
    updateEmptyState();
  }

  async function serveFile(peer, fileId) {
    const file = myFiles.get(fileId);
    if (!file) throw new Error('That file is no longer shared');

    const tag = (++tagSeq) & 0xffffffff;
    const chunkSize = peer.chunkSize;

    peer.sendCtrl({
      t: 'start', fileId, tag,
      name: file.name, size: file.size, mime: file.type,
    });

    const progress = {
      fileId, size: file.size, sent: 0,
      startedAt: performance.now(), lastTick: performance.now(), lastBytes: 0,
      direction: 'up', peerLabel: peer.label,
    };
    setCardState(fileId, 'active', 'Sending to ' + peer.label + '…');

    // Read the next slice while the current one is in flight.
    let offset = 0;
    let nextRead = readSlice(file, 0, chunkSize);

    while (offset < file.size) {
      const buf = await nextRead;
      const advance = buf.byteLength;
      if (offset + advance < file.size) {
        nextRead = readSlice(file, offset + advance, chunkSize);
      }
      await peer.sendChunk(tag, new Uint8Array(buf));
      offset += advance;
      progress.sent = offset;
      tickProgress(progress);
    }

    peer.sendCtrl({ t: 'end', fileId, tag });
    setCardState(fileId, 'done', 'Sent to ' + peer.label + ' · ' + formatSize(file.size));
    const card = cards.get(fileId);
    if (card) card.bar.style.width = '100%';
  }

  function readSlice(file, offset, size) {
    return file.slice(offset, Math.min(offset + size, file.size)).arrayBuffer();
  }

  /* ── Receiving ───────────────────────────────────────────── */
  const pendingRequests = new Map(); // fileId -> xfer awaiting 'start'

  socket.on('file:offer', (meta) => {
    if (meta.ownerId === mySocketId) return; // our own card already exists
    renderFileCard(meta, false);
    setCardState(meta.fileId, 'ready', formatSize(meta.size) + ' · from ' + meta.sender);
    playPing();
    updateEmptyState();

    // Small images arrive on their own so pictures just appear, like a chat.
    if (isImage(meta.fileType) && meta.size <= AUTO_PREVIEW_MAX) {
      requestFile(meta, { preferMemory: true, auto: true });
    }
  });

  socket.on('file:unavailable', ({ fileId }) => {
    myFiles.delete(fileId);
    const card = cards.get(fileId);
    if (!card || card.mine) return;
    card.meta.available = false;
    if (card.state === 'ready') {
      setCardState(fileId, 'gone', 'No longer available — sender left');
      if (card.action) card.action.disabled = true;
    }
  });

  async function requestFile(meta, opts) {
    const options = opts || {};
    const card = cards.get(meta.fileId);
    if (card && (card.state === 'active' || card.state === 'done')) return;
    if (card && card.meta.available === false) {
      return toast('That file is gone — the sender left the room', 'error');
    }

    let sink;
    try {
      // The save dialog must open inside the click, so do it first.
      sink = await createSink(meta.name, meta.size, meta.fileType, options.preferMemory);
    } catch (err) {
      if (err && err.name === 'AbortError') return; // cancelled the dialog
      return toast(describeSaveError(err), 'error');
    }

    const xfer = {
      fileId: meta.fileId, name: meta.name, size: meta.size,
      mime: meta.fileType, sink, ownerId: meta.ownerId,
      auto: !!options.auto, direction: 'down', received: 0,
      startedAt: performance.now(), lastTick: performance.now(), lastBytes: 0,
    };
    pendingRequests.set(meta.fileId, xfer);
    setCardState(meta.fileId, 'active', 'Connecting…');

    const peer = ensurePeer(meta.ownerId);
    try {
      await peer.ready();
    } catch (err) {
      pendingRequests.delete(meta.fileId);
      return abortIncoming(xfer, err.message || 'Peer unavailable');
    }
    peer.sendCtrl({ t: 'req', fileId: meta.fileId });
  }

  async function finishIncoming(xfer) {
    try {
      await xfer.pending;          // drain queued writes
      const url = await xfer.sink.close();
      const card = cards.get(xfer.fileId);

      if (url) {
        objectUrls.push(url);
        if (isImage(xfer.mime) && card) attachPreview(card, url, xfer.name);
        if (xfer.auto) {
          setCardState(xfer.fileId, 'done', formatSize(xfer.size) + ' · received');
          if (card) setDownloadLink(card, url, xfer.name);
        } else {
          // Buffered mode: hand the bytes over as a download link.
          setCardState(xfer.fileId, 'done', 'Ready — ' + formatSize(xfer.size));
          if (card) {
            setDownloadLink(card, url, xfer.name);
            card.action.click();
          }
        }
      } else {
        // Streamed straight to disk — the browser already has it, so the
        // button has nothing left to do.
        setCardState(xfer.fileId, 'done', 'Saved to your device · ' + formatSize(xfer.size));
        if (card && card.action) { card.action.remove(); card.action = null; }
      }
      const card2 = cards.get(xfer.fileId);
      if (card2) card2.bar.style.width = '100%';
      if (!xfer.auto) playDone();

      // Tell the owner it actually landed, so their card can show a receipt.
      const owner = peers.get(xfer.ownerId);
      if (owner) owner.sendCtrl({ t: 'got', fileId: xfer.fileId });
    } catch (err) {
      abortIncoming(xfer, describeSaveError(err));
    }
  }

  function abortIncoming(xfer, reason) {
    try { if (xfer.sink) xfer.sink.abort(); } catch (_) {}
    pendingRequests.delete(xfer.fileId);
    setCardState(xfer.fileId, 'error', reason);
    const card = cards.get(xfer.fileId);
    if (card && card.action) {
      card.action.disabled = false;
      card.action.textContent = 'Try again';
    }
    if (!xfer.auto) toast(reason, 'error');
  }

  /* ── Progress ────────────────────────────────────────────── */
  function tickProgress(p) {
    const card = cards.get(p.fileId);
    if (!card) return;

    const done = p.direction === 'up' ? p.sent : p.received;
    const total = p.size || 0;
    const pct = total ? Math.min(100, (done / total) * 100) : 0;
    card.bar.style.width = pct.toFixed(1) + '%';

    const now = performance.now();
    if (now - p.lastTick < 250) return;     // repaint ~4x a second
    const speed = (done - p.lastBytes) / ((now - p.lastTick) / 1000);
    p.lastTick = now;
    p.lastBytes = done;

    const eta = speed > 0 && total ? (total - done) / speed : Infinity;
    const verb = p.direction === 'up' ? 'Sending' : 'Receiving';
    card.status.textContent =
      verb + ' ' + pct.toFixed(0) + '% · ' + formatSize(done) + ' of ' + formatSize(total) +
      (speed > 0 ? ' · ' + formatSpeed(speed) : '') +
      (isFinite(eta) ? ' · ' + formatEta(eta) : '');
  }

  /* ── Message rendering ───────────────────────────────────── */
  function renderHistoryEntry(entry) {
    if (entry.type === 'system') return renderSystem(entry);
    if (entry.type === 'chat') return renderChat(entry);
    if (entry.type === 'file') {
      if (entry.ownerId === mySocketId) return;
      renderFileCard(entry, false);
      if (entry.available) {
        setCardState(entry.fileId, 'ready', formatSize(entry.size) + ' · from ' + entry.sender);
        // Pictures shared before we arrived should still just appear.
        if (isImage(entry.fileType) && entry.size <= AUTO_PREVIEW_MAX) {
          requestFile(entry, { preferMemory: true, auto: true });
        }
      } else {
        setCardState(entry.fileId, 'gone', 'No longer available — sender left');
        const card = cards.get(entry.fileId);
        if (card && card.action) card.action.disabled = true;
      }
    }
  }

  function rowFor(sender, ts, mine) {
    const row = document.createElement('div');
    row.className = 'msg-row ' + (mine ? 'self' : 'other');
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = (mine ? 'You' : sender) + ' · ' + formatTime(ts);
    row.appendChild(meta);
    messagesEl.appendChild(row);
    return row;
  }

  function renderSystem(msg) {
    const el = document.createElement('div');
    el.className = 'msg-system';
    el.textContent = msg.text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function renderChat(msg) {
    const mine = msg.sender === myLabel;
    const row = rowFor(msg.sender, msg.ts, mine);

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = linkify(msg.text);
    row.appendChild(bubble);

    if (mine && msg.id) {
      // One tick: the server has it. Two: everyone in the room has it.
      const ticks = document.createElement('span');
      ticks.className = 'ticks';
      ticks.textContent = '✓';
      ticks.title = 'Sent';
      bubble.appendChild(ticks);
      receipts.set(msg.id, {
        ticks,
        acked: new Set(),
        expected: Math.max(0, roomUsers.length - 1),
      });
      markReceipt(msg.id);
    } else if (!mine && msg.id && msg.senderId) {
      socket.emit('msg:ack', { id: msg.id, to: msg.senderId });
    }

    const copy = document.createElement('button');
    copy.className = 'copy-btn';
    copy.type = 'button';
    copy.title = 'Copy text';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => {
      copyText(msg.text);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
    });
    row.appendChild(copy);
    scrollToBottom();
  }

  function renderFileCard(meta, mine) {
    if (cards.has(meta.fileId)) return cards.get(meta.fileId);

    const row = rowFor(meta.sender, meta.ts, mine);
    const card = document.createElement('div');
    card.className = 'file-card';

    card.innerHTML =
      '<div class="file-top">' +
        '<span class="file-icon">' + fileIcon(meta.fileType, meta.name) + '</span>' +
        '<div class="file-id">' +
          '<div class="file-name" title="' + escapeHtml(meta.name) + '">' + escapeHtml(meta.name) + '</div>' +
          '<div class="file-status"></div>' +
        '</div>' +
      '</div>' +
      '<div class="file-track"><div class="file-bar"></div></div>' +
      '<div class="file-actions"></div>';

    row.appendChild(card);

    const refs = {
      meta, mine, el: card, row,
      status: card.querySelector('.file-status'),
      bar: card.querySelector('.file-bar'),
      actions: card.querySelector('.file-actions'),
      action: null,
      state: 'new',
    };
    cards.set(meta.fileId, refs);

    if (mine) {
      const stop = document.createElement('button');
      stop.className = 'btn btn-ghost btn-sm';
      stop.type = 'button';
      stop.textContent = 'Stop sharing';
      stop.addEventListener('click', () => {
        myFiles.delete(meta.fileId);
        socket.emit('file:revoke', { fileId: meta.fileId });
        setCardState(meta.fileId, 'gone', 'You stopped sharing this');
        stop.remove();
      });
      refs.actions.appendChild(stop);
    } else {
      const get = document.createElement('button');
      get.className = 'btn btn-primary btn-sm';
      get.type = 'button';
      get.textContent = canStreamToDisk() ? 'Save file' : 'Download';
      get.addEventListener('click', () => requestFile(refs.meta, {}));
      refs.actions.appendChild(get);
      refs.action = get;
    }

    scrollToBottom();
    return refs;
  }

  function setCardState(fileId, state, text) {
    const card = cards.get(fileId);
    if (!card) return;
    card.state = state;
    card.el.dataset.state = state;
    if (text) card.status.textContent = text;
    if (state === 'active' && card.action) {
      card.action.disabled = true;
      card.action.textContent = 'Transferring…';
    }
  }

  function attachPreview(card, url, name) {
    if (card.el.querySelector('.file-preview')) return;
    const img = document.createElement('img');
    img.className = 'file-preview';
    img.src = url;
    img.alt = name;
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(url, name));
    card.el.insertBefore(img, card.el.querySelector('.file-track'));
    scrollToBottom();
  }

  function setDownloadLink(card, url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.className = 'btn btn-primary btn-sm';
    a.textContent = 'Save to device';
    if (card.action) card.action.replaceWith(a);
    else card.actions.appendChild(a);
    card.action = a;
  }

  function openLightbox(src, name) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML =
      '<button class="lightbox-close" type="button" aria-label="Close">✕</button>' +
      '<img src="' + src + '" alt="' + escapeHtml(name || '') + '">';
    lb.addEventListener('click', (e) => {
      if (e.target === lb || e.target.classList.contains('lightbox-close')) lb.remove();
    });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { lb.remove(); document.removeEventListener('keydown', esc); }
    });
    document.body.appendChild(lb);
  }

  function updateEmptyState() {
    const has = messagesEl.children.length > 0;
    emptyState.classList.toggle('hidden', has);
  }

  /* ── Chat ────────────────────────────────────────────────── */
  btnSend.addEventListener('click', sendMessage);
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  let typingSent = 0;
  msgInput.addEventListener('input', () => {
    const now = Date.now();
    if (now - typingSent > 1200) { typingSent = now; socket.emit('chat:typing', true); }
  });

  function sendMessage() {
    const text = msgInput.value;
    if (!text.trim()) return;
    socket.emit('chat:message', { text });
    socket.emit('chat:typing', false);
    msgInput.value = '';
    msgInput.focus();
  }

  socket.on('chat:message', (msg) => {
    if (msg.type === 'system') renderSystem(msg);
    else {
      renderChat(msg);
      if (msg.sender !== myLabel) playPing();
    }
    updateEmptyState();
  });

  socket.on('msg:ack', ({ id, label }) => {
    const r = receipts.get(id);
    if (!r) return;
    r.acked.add(label);
    markReceipt(id);
  });

  function markReceipt(id) {
    const r = receipts.get(id);
    if (!r) return;
    if (r.expected > 0 && r.acked.size >= r.expected) {
      r.ticks.textContent = '✓✓';
      r.ticks.classList.add('delivered');
      r.ticks.title = 'Delivered to everyone in the room';
    } else if (r.acked.size > 0) {
      r.ticks.textContent = '✓✓';
      r.ticks.classList.add('delivered');
      r.ticks.title = 'Delivered to ' + [...r.acked].join(', ');
    } else {
      r.ticks.title = r.expected === 0
        ? 'Sent — nobody else is here yet'
        : 'Sent, not delivered yet';
    }
  }

  const typingUsers = new Map();
  socket.on('chat:typing', ({ label, typing }) => {
    if (typing === false) typingUsers.delete(label);
    else {
      clearTimeout(typingUsers.get(label));
      typingUsers.set(label, setTimeout(() => {
        typingUsers.delete(label);
        paintTyping();
      }, 2600));
    }
    paintTyping();
  });

  function paintTyping() {
    const names = [...typingUsers.keys()];
    if (!names.length) {
      typingEl.classList.add('hidden');
      typingEl.textContent = '';
      return;
    }
    typingEl.textContent = names.join(' and ') + (names.length === 1 ? ' is' : ' are') + ' typing…';
    typingEl.classList.remove('hidden');
  }

  /* ── Misc ────────────────────────────────────────────────── */
  function scrollToBottom() {
    // Stay put if the reader has scrolled up to look at something.
    const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 220;
    if (nearBottom) requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }

  window.addEventListener('beforeunload', (e) => {
    const busy = incoming.size > 0 || pendingRequests.size > 0;
    if (busy) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
    objectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
    peers.forEach(p => p.close());
  });
}
