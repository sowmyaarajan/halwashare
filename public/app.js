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
const ICE_WOBBLE       = 6000;            // a 'disconnected' link this long is treated as lost
const STALL_MS         = 12000;           // no bytes this long: ask for the rest again
const REQ_TIMEOUT      = 15000;           // no answer to a request this long: ask again
const MAX_RETRIES      = 6;               // consecutive attempts without progress
const AUTO_PREVIEW_MAX = 5 * 1024 * 1024; // images this small arrive automatically
const AUTO_PREVIEW_BUDGET = 60 * 1024 * 1024; // …until this much has arrived unasked
const CODE_LENGTH      = 6;               // digits in a room code — matches server.js

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
  // Unguessable: a device's id lets it back into its room without the
  // code-guessing limits, so it must not be predictable.
  const b = crypto.getRandomValues(new Uint8Array(15));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_');
}

/* This tab's identity, shared by the landing page and the room. */
function getClientId() {
  try {
    let id = sessionStorage.getItem('halwa-client');
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      id = uid();
      sessionStorage.setItem('halwa-client', id);
    }
    return id;
  } catch (_) { return uid(); }
}

/* ── Service worker ────────────────────────────────────────────
   Registered on every page: the installed app opens on the landing
   page, and that is where shared files arrive. */
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/* ── Files shared in from the phone's Share menu ───────────────
   sw.js parks them in Cache Storage. The landing page shows them and
   arms this tab; the room page offers them once, then forgets them.
   Arming per tab means an old share never ambushes a later room. */
const SHARE_CACHE = 'halwa-shared';
const SHARE_MAX_AGE = 60 * 60 * 1000;
const SHARE_ARMED = 'halwa-share-armed';

async function readSharedIndex() {
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const res = await cache.match('/__shared/index');
    if (!res) return null;
    const index = await res.json();
    if (!index || Date.now() - index.at > SHARE_MAX_AGE) { await clearShared(); return null; }
    if (!(index.files || []).length && !index.text) return null;
    return index;
  } catch (_) { return null; }
}

async function takeShared() {
  const index = await readSharedIndex();
  if (!index) return null;
  const cache = await caches.open(SHARE_CACHE);
  const files = [];
  for (let i = 0; i < index.files.length; i++) {
    const res = await cache.match('/__shared/' + i);
    if (!res) continue;
    const blob = await res.blob();
    files.push(new File([blob], index.files[i].name, { type: index.files[i].type }));
  }
  await clearShared();
  return { files, text: index.text || '' };
}

async function clearShared() {
  try { await caches.delete(SHARE_CACHE); } catch (_) {}
}

function isStandalone() {
  return window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
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
    inputCode.value = inputCode.value.replace(/\D/g, '').slice(0, CODE_LENGTH);
    errorEl.classList.add('hidden');
    if (inputCode.value.length === CODE_LENGTH) doJoin();
  });
  inputCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

  btnCreate.addEventListener('click', () => {
    btnCreate.disabled = true;
    btnCreate.textContent = 'Creating…';
    socket.emit('room:create', { clientId: getClientId() }, (res) => {
      if (res && res.code) {
        window.location.href = '/join/' + res.code;
        return;
      }
      showError((res && res.error) || 'Could not create a room. Try again.');
      btnCreate.disabled = false;
      btnCreate.textContent = 'Create a room';
    });
  });

  btnJoin.addEventListener('click', doJoin);

  /* Files shared from another app wait here until a room is chosen.
     The phone's Share menu always opens the installed app; a website
     that forged a share can only open an ordinary tab. Outside the app,
     whatever is parked is thrown away unseen. */
  readSharedIndex().then((index) => {
    if (!index) return;
    if (!isStandalone()) { clearShared(); return; }
    try { sessionStorage.setItem(SHARE_ARMED, '1'); } catch (_) {}
    const n = index.files.length;
    const what = n
      ? n + (n === 1 ? ' file' : ' files') + ' (' +
        index.files.slice(0, 3).map(f => f.name).join(', ') + (n > 3 ? ', …' : '') + ')'
      : 'Your text';
    const el = document.getElementById('share-pending');
    el.textContent = '📎 ' + what + ' ready. Create or join a room, and you can send ' +
      (n === 1 || !n ? 'it' : 'them') + ' from there.';
    el.classList.remove('hidden');
    if (location.search) history.replaceState(null, '', '/');
  });

  /* Install: Chrome and Edge hand us a prompt to show on a click.
     iPhone has no prompt, so it gets instructions instead. */
  const installBox = document.getElementById('install-box');
  const btnInstall = document.getElementById('btn-install');
  let installPrompt = null;

  if (!isStandalone()) {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installPrompt = e;
      btnInstall.classList.remove('hidden');
      installBox.classList.remove('hidden');
    });
    const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (iOS) {
      document.getElementById('install-ios').classList.remove('hidden');
      installBox.classList.remove('hidden');
    }
  }

  btnInstall.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    installBox.classList.add('hidden');
  });

  window.addEventListener('appinstalled', () => installBox.classList.add('hidden'));

  let joining = false;
  function doJoin() {
    if (joining) return;
    const code = inputCode.value.trim();
    if (code.length !== CODE_LENGTH) return showError('Enter the ' + CODE_LENGTH + '-digit room code.');
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

  const clientId = getClientId();

  let myLabel = null;
  let myId = null;          // our id in the room; stable across reconnects

  /* Room messages wait until we are actually back in the room. While the
     socket is down, socket.io holds what we emit and sends it the moment it
     reconnects — before we have rejoined — and the server, not yet knowing
     our room, would drop it: a file picked mid-reconnect would never reach
     anyone. So hold them here and send them once the join has landed. */
  let inRoom = false;
  const held = [];
  function roomEmit(event, data) {
    if (inRoom && socket.connected) socket.emit(event, data);
    else held.push([event, data]);
  }
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
  // Leaving on purpose tells the room at once; closing the tab or losing
  // the connection leaves us "away" for a while in case we come back.
  btnExit.addEventListener('click', () => {
    socket.emit('room:leave');
    setTimeout(() => { window.location.href = '/'; }, 150);
  });

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
  /* Joining and re-joining are the same call. After a dropped connection
     the server knows us by clientId and keeps our id, name and files, so
     the others see us come straight back instead of leave and rejoin. */
  function join() {
    const first = !joined;
    socket.emit('room:join', {
      code: urlCode, clientId,
      fresh: first,                 // a newly loaded page holds no old links or files
      files: [...myFiles.keys()],   // what we can still send
    }, (res) => {
      if (res && res.error) return showFatal(res.error);

      joined = true;
      myLabel = res.label;
      myId = res.selfId;
      inRoom = true;

      renderUsers(res.users);
      if (first) {
        loadQR(urlCode);
        res.history.forEach(renderHistoryEntry);
        showCapabilityNote();
        offerSharedFiles();
      } else {
        catchUp(res.history);
      }
      reconcilePeers(res.peers, res.users, first);
      updateEmptyState();
      held.splice(0).forEach(([event, data]) => socket.emit(event, data));
    });
  }

  socket.on('connect', () => {
    const banner = $('offline-banner');
    if (banner) banner.classList.add('hidden');
    join();
  });

  socket.on('disconnect', () => {
    inRoom = false;
    const banner = $('offline-banner');
    if (banner) banner.classList.remove('hidden');
  });

  /* A phone that slept may hold a socket that died without telling it, and
     would otherwise only notice ~50 s later. Check the moment it wakes. */
  function checkConnection() {
    if (!joined && socket.connected) return;
    if (!socket.connected) { socket.connect(); return; }
    socket.timeout(4000).emit('room:ping', (err) => {
      if (err) { socket.disconnect(); socket.connect(); }
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkConnection();
  });
  window.addEventListener('online', checkConnection);
  window.addEventListener('pageshow', (e) => { if (e.persisted) checkConnection(); });

  /* Messages and files that arrived while we were disconnected. */
  function catchUp(history) {
    const since = lastSeenTs;
    for (const h of history) {
      if (h.type === 'file') {
        const card = cards.get(h.fileId);
        if (!card) { if (h.ownerId !== myId) renderHistoryEntry(h); }
        else if (!card.mine) setAvailability(card, h.available);
      } else if (h.type === 'chat') {
        if (!seenChat.has(h.id)) renderChat(h);
      } else if (h.ts > since) {
        renderSystem(h);
      }
    }
  }

  function setAvailability(card, available) {
    if (!available && card.state === 'ready') {
      card.meta.available = false;
      setCardState(card.meta.fileId, 'gone', 'No longer available — ask ' + (card && card.meta.sender || 'the sender') + ' to share it again');
      if (card.action) card.action.disabled = true;
    } else if (available && card.state === 'gone' && card.meta.available === false) {
      card.meta.available = true;
      setCardState(card.meta.fileId, 'ready', formatSize(card.meta.size) + ' · from ' + card.meta.sender);
      if (card.action) card.action.disabled = false;
    }
  }

  /* Bring our links in line with who is actually in the room now. */
  function reconcilePeers(list, users, first) {
    const here = new Set(users.map(u => u.id));
    for (const id of [...peers.keys()]) {
      if (!here.has(id)) dropPeer(id, 'the sender left');
    }
    for (const p of list) {
      const peer = peers.get(p.id);
      if (!peer) { ensurePeer(p.id, p.label); continue; }
      peer.label = p.label;
      if (first || peer.linkAlive()) continue;
      // Our link to them died while we were away. Start over, and ask them
      // to offer a new one — they may not have noticed theirs is dead.
      resetPeer(p.id, p.label);
      socket.emit('rtc:signal', { to: p.id, payload: { type: 'reset' } });
    }
    refreshUsers();
  }

  // The page is gone after a fatal error, so stop reconnecting to it.
  function showFatal(message) {
    socket.disconnect();
    document.body.innerHTML =
      '<div class="fatal">' +
        '<div class="fatal-card">' +
          '<div class="fatal-icon">⚠️</div>' +
          '<h2>' + escapeHtml(message) + '</h2>' +
          '<a href="/" class="btn btn-primary">Back to start</a>' +
        '</div>' +
      '</div>';
  }

  async function offerSharedFiles() {
    if (!isStandalone()) return;
    let armed = false;
    try { armed = sessionStorage.getItem(SHARE_ARMED) === '1'; sessionStorage.removeItem(SHARE_ARMED); } catch (_) {}
    if (!armed) return;
    const shared = await takeShared();
    if (!shared) return;
    // Text lands in the composer, where sending it is already a choice.
    if (shared.text) {
      msgInput.value = shared.text.slice(0, 4000);
      msgInput.focus();
    }
    if (shared.files.length) confirmShared(shared.files);
  }

  /* Shared files are shown, never sent unasked: the person sees exactly
     what is about to go out under their name, and chooses. */
  function confirmShared(files) {
    const bar = document.createElement('div');
    bar.className = 'share-confirm';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Send shared files');

    const title = document.createElement('p');
    title.className = 'share-confirm-title';
    title.textContent = 'Send ' + (files.length === 1 ? 'this file' : 'these ' + files.length + ' files') + ' to the room?';

    const list = document.createElement('ul');
    list.className = 'share-confirm-list';
    files.forEach(f => {
      const li = document.createElement('li');
      li.textContent = fileIcon(f.type, f.name) + ' ' + f.name + ' · ' + formatSize(f.size);
      list.appendChild(li);
    });

    const actions = document.createElement('div');
    actions.className = 'share-confirm-actions';
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'btn btn-ghost btn-sm';
    discard.textContent = 'Discard';
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'btn btn-primary btn-sm';
    send.textContent = 'Send';
    actions.append(discard, send);

    bar.append(title, list, actions);
    document.querySelector('.composer').before(bar);
    send.focus();

    discard.addEventListener('click', () => bar.remove());
    send.addEventListener('click', () => {
      bar.remove();
      files.forEach(offerFile);
    });
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
      const self = u.id === myId;
      const peer = peers.get(u.id);
      const mode = self ? '' : u.away ? 'away' : (peer ? peer.mode : 'connecting');
      const badge = self ? '' :
        '<span class="mode-pill mode-' + mode + '">' + modeLabel(mode) + '</span>';
      return '<li class="user-item' + (u.away ? ' away' : '') + '">' +
        '<span class="avatar">' + escapeHtml(u.label.replace(/\D/g, '') || '?') + '</span>' +
        '<span class="user-name">' + escapeHtml(u.label) + (self ? ' (you)' : u.away ? ' · reconnecting…' : '') + '</span>' +
        badge +
      '</li>';
    }).join('');
    $('user-count').textContent = users.length;
  }

  function modeLabel(mode) {
    if (mode === 'p2p') return 'direct';
    if (mode === 'relay') return 'relay';
    if (mode === 'dead') return 'offline';
    if (mode === 'away') return 'away';
    return '…';
  }

  /* Repaint the roster — no round trip needed when only a mode changed. */
  function refreshUsers() {
    if (myLabel) renderUsers(roomUsers);
  }

  function isAway(id) {
    const u = roomUsers.find(x => x.id === id);
    return !u || !!u.away;
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
      this.iceTimer = null;
      this.openWaiters = [];
      this.rxUnacked = 0;            // relay bytes received, not yet acknowledged
      this.closed = false;
      this.createdAt = Date.now();
    }

    /* A direct link that is up right now. */
    linkAlive() {
      return this.mode === 'p2p' && !!this.dc && this.dc.readyState === 'open' &&
        !!this.pc && this.pc.connectionState === 'connected';
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
      if (this.mode === mode || this.closed) return;
      const prev = this.mode;
      this.mode = mode;
      // Downloads streaming over the direct link died with it. Ask for the
      // rest over the relay; the bytes already saved stay saved.
      if (prev === 'p2p' && mode === 'relay') setTimeout(() => restartDownloadsFrom(this.id), 0);
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

    /* `via` pins a message to one route. A file's start, chunks and end must
       all travel the same way, or a chunk could overtake another and the
       file would be scrambled. Without it, use whatever works now. */
    sendCtrl(msg, via) {
      const direct = this.dc && this.dc.readyState === 'open';
      if (via === 'p2p' && !direct) throw linkLost(this);
      if (via !== 'relay' && direct && (via === 'p2p' || this.mode === 'p2p')) {
        this.dc.send(JSON.stringify(msg));
      } else {
        socket.emit('relay:ctrl', { to: this.id, msg });
      }
    }

    /* One framed chunk, honouring backpressure so memory stays flat. */
    async sendChunk(tag, view, via) {
      if (via === 'relay') {
        while (this.relayInflight >= RELAY_WINDOW && !this.closed) {
          await new Promise(r => this.relayWaiters.push(r));
        }
        if (this.closed) throw linkLost(this);
        this.relayInflight += view.byteLength;
        socket.emit('relay:chunk', { to: this.id, tag, buf: view });
        return;
      }

      const dc = this.dc;
      if (!dc || dc.readyState !== 'open') throw linkLost(this);

      if (dc.bufferedAmount > BUFFER_HIGH) await this.waitDrain();
      if (dc.readyState !== 'open' || this.dc !== dc) throw linkLost(this);

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

    /* Bytes handed over but not yet on the wire. Counting them as "sent"
       would show 100% while the other side is still receiving. */
    get inflight() {
      if (this.mode === 'relay') return this.relayInflight;
      return (this.dc && this.dc.bufferedAmount) || 0;
    }

    /* Resolves once the send buffer has actually drained. */
    async drained(timeoutMs) {
      const limit = timeoutMs || 180000;
      const start = performance.now();
      while (this.inflight > 0) {
        if (this.mode !== 'relay' && (!this.dc || this.dc.readyState !== 'open')) return;
        if (performance.now() - start > limit) return;
        await new Promise(r => setTimeout(r, 60));
      }
    }

    /* An abandoned stream's bytes may never be acknowledged; start clean. */
    resetRelayCredit() {
      this.relayInflight = 0;
      const waiters = this.relayWaiters;
      this.relayWaiters = [];
      waiters.forEach(w => w());
    }

    /* Acknowledge relay bytes as they land, whether or not they still
       belong to a live download, so the sender's window never jams. */
    ackRelay(bytes, flush) {
      this.rxUnacked += bytes;
      if (this.rxUnacked > 0 && (flush || this.rxUnacked >= RELAY_ACK_EVERY)) {
        this.sendCtrl({ t: 'ack', bytes: this.rxUnacked });
        this.rxUnacked = 0;
      }
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
      this.closed = true;
      clearTimeout(this.graceTimer);
      clearTimeout(this.iceTimer);
      // Silence the old link first so its closing does not look like news.
      if (this.dc) { this.dc.onopen = this.dc.onclose = this.dc.onerror = this.dc.onmessage = null; }
      if (this.pc) { this.pc.onconnectionstatechange = this.pc.onicecandidate = this.pc.ondatachannel = null; }
      try { if (this.dc) this.dc.close(); } catch (_) {}
      try { if (this.pc) this.pc.close(); } catch (_) {}
      this.relayWaiters.forEach(w => w());
      this.relayWaiters = [];
      const waiters = this.openWaiters;
      this.openWaiters = [];
      waiters.forEach(w => w.reject(new Error('Link replaced')));
    }
  }

  function linkLost(peer) {
    const err = new Error('Link to ' + peer.label + ' closed');
    err.linkLost = true;
    return err;
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

  /* Throw away a peer's link and start a new one. Anything we were
     downloading from them asks for the rest once the new link is up. */
  function resetPeer(id, label) {
    const old = peers.get(id);
    if (old) { old.close(); peers.delete(id); }
    const peer = ensurePeer(id, label || (old && old.label));
    restartDownloadsFrom(id);
    return peer;
  }

  /* Gone for good: stop everything to do with them. */
  function dropPeer(id, reason) {
    const peer = peers.get(id);
    if (!peer) return;
    peer.settle('dead');
    failTransfersFrom(id, reason);
    stopRowsFor(id);
    peer.close();
    peers.delete(id);
    refreshUsers();
  }

  async function startOffer(peer) {
    await rtcConfigReady;
    if (peer.pc || peer.closed) return;
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
      if (peer.pc !== pc || peer.mode === 'dead') return;
      const s = pc.connectionState;
      clearTimeout(peer.iceTimer);
      if (s === 'failed' || s === 'closed') {
        // Keep the peer usable — the relay can carry everything.
        peer.settle('relay');
      } else if (s === 'disconnected') {
        // Phones hop networks; a link often recovers within seconds. Only
        // give up on it if it stays down.
        peer.iceTimer = setTimeout(() => {
          if (peer.pc === pc && pc.connectionState === 'disconnected') peer.settle('relay');
        }, ICE_WOBBLE);
      } else if (s === 'connected' && peer.mode === 'relay' && peer.dc && peer.dc.readyState === 'open') {
        peer.settle('p2p'); // back on the direct link
      }
    };
    return pc;
  }

  function wireChannel(peer, dc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
    peer.dc = dc;

    const lost = () => { if (peer.dc === dc && peer.mode === 'p2p') peer.settle('relay'); };
    dc.onopen = () => { if (peer.dc === dc) peer.settle('p2p'); };
    dc.onclose = lost;
    dc.onerror = lost;
    dc.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let msg = null;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        handleCtrl(peer, msg);
      } else {
        if (e.data.byteLength < 4) return;
        const tag = new DataView(e.data).getUint32(0);
        const payload = new Uint8Array(e.data, 4);
        handleChunk(peer, tag, payload, payload.byteLength, false);
      }
    };
  }

  /* ── Signalling ──────────────────────────────────────────── */
  socket.on('rtc:peer-joined', ({ id, label, rejoin, fresh }) => {
    const existing = peers.get(id);
    // Back from a blip with the direct link still up: nothing to rebuild.
    if (rejoin && !fresh && existing && existing.linkAlive()) {
      existing.label = label;
      refreshUsers();
      return;
    }
    const peer = existing ? resetPeer(id, label) : ensurePeer(id, label);
    startOffer(peer); // the established side always offers
    refreshUsers();
  });

  socket.on('rtc:peer-left', ({ id }) => dropPeer(id, 'the sender left the room'));

  socket.on('rtc:signal', async ({ from, payload }) => {
    let peer = ensurePeer(from);
    try {
      if (payload.type === 'reset') {
        // They came back and their link to us is dead. Offer a new one —
        // unless we just started one for them.
        if (Date.now() - peer.createdAt < 4000 && !peer.linkAlive()) return;
        startOffer(resetPeer(from));

      } else if (payload.type === 'offer') {
        await rtcConfigReady;
        // Only one side ever offers, so an offer always means a new link.
        if (peer.pc) peer = resetPeer(from);
        buildPC(peer);
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
    handleChunk(peer, tag, view, view.byteLength, true);
  });

  /* ── Control protocol ────────────────────────────────────── */
  function handleCtrl(peer, msg) {
    if (!msg || !msg.t) return;

    switch (msg.t) {
      case 'req': {                  // someone wants a file we offered
        // A repeat request for the same file replaces the old stream: they
        // lost it and want the rest from `offset`.
        const key = peer.id + ':' + msg.fileId;
        const prev = serving.get(key);
        if (prev) { prev.cancelled = true; peer.resetRelayCredit(); }
        const job = { cancelled: false };
        serving.set(key, job);
        peer.enqueue(() => {
          if (job.cancelled || peer.closed) return;
          activeSends++;
          syncWakeLock();
          return serveFile(peer, msg.fileId, msg.offset, msg.rid, job).catch(err => {
            if (job.cancelled || err.linkLost) return; // they will ask again
            try {
              peer.sendCtrl({ t: 'err', fileId: msg.fileId, rid: msg.rid, reason: String(err.message || err) });
            } catch (_) {}
          }).finally(() => {
            activeSends--;
            if (serving.get(key) === job) serving.delete(key);
            syncWakeLock();
          });
        });
        break;
      }

      case 'start': {                // the owner is about to stream
        const xfer = pendingRequests.get(msg.fileId);
        if (!xfer || xfer.ownerId !== peer.id) return; // only the owner may answer
        if (msg.rid !== undefined && msg.rid !== xfer.rid) return; // answer to an older request
        if (!Number.isInteger(msg.tag)) return;
        pendingRequests.delete(msg.fileId);
        // Resuming needs the sender to pick up exactly where we stopped. An
        // older app always starts from zero, and we cannot unwrite bytes.
        if ((msg.offset || 0) !== xfer.received) {
          return abortIncoming(xfer, 'Transfer interrupted — tap Try again.');
        }
        xfer.tag = msg.tag;
        // xfer.size stays the size from the offer: the sender is held to what
        // they advertised, so they cannot keep streaming until memory runs out.
        xfer.lastData = Date.now();
        xfer.lastTick = performance.now();
        xfer.lastBytes = xfer.received;
        xfer.peerId = peer.id;
        xfer.key = peer.id + ':' + msg.tag;
        incoming.set(xfer.key, xfer);
        setCardState(msg.fileId, 'active', xfer.received ? 'Resuming…' : 'Receiving…');
        break;
      }

      case 'end': {
        if (peer.rxUnacked) peer.ackRelay(0, true); // hand back the last partial window
        const xfer = incoming.get(peer.id + ':' + msg.tag);
        if (!xfer) return;
        incoming.delete(peer.id + ':' + msg.tag);
        xfer.key = null;
        if (xfer.received !== xfer.size) {
          // Some bytes went missing on the way: fetch the rest.
          if (++xfer.retries > MAX_RETRIES) {
            abortIncoming(xfer, 'Transfer incomplete — only ' + formatSize(xfer.received) +
              ' of ' + formatSize(xfer.size) + ' arrived. Try again.');
          } else {
            sendRequest(xfer);
          }
          break;
        }
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
        if (card.peerRows && card.peerRows.has(peer.id)) {
          const row = card.peerRows.get(peer.id);
          row.state = 'got';
          row.row.classList.add('done');
          row.bar.style.width = '100%';
          row.pct.textContent = '✓✓ saved';
          // Everyone confirmed — settle the card without waiting on our buffer.
          const busy = [...card.peerRows.values()].some(r => r.state === 'active');
          if (!busy) {
            setCardState(msg.fileId, 'done');
            card.bar.style.width = '100%';
          }
        }
        updateSenderSummary(card);
        break;
      }

      case 'err': {
        const xfer = pendingRequests.get(msg.fileId) ||
          [...incoming.values()].find(x => x.fileId === msg.fileId);
        if (!xfer || xfer.ownerId !== peer.id) return;
        if (msg.rid !== undefined && msg.rid !== xfer.rid) return; // about an older request
        for (const [key, x] of incoming) if (x === xfer) incoming.delete(key);
        abortIncoming(xfer, String(msg.reason || 'Transfer failed').slice(0, 200));
        break;
      }
    }
  }

  function handleChunk(peer, tag, view, byteLength, viaRelay) {
    if (viaRelay) peer.ackRelay(byteLength);
    const key = peer.id + ':' + tag;
    const xfer = incoming.get(key);
    if (!xfer) return; // from a stream we gave up on

    xfer.received += byteLength;
    xfer.lastData = Date.now();
    xfer.retries = 0;
    if (xfer.received > xfer.size) {
      incoming.delete(key);
      return abortIncoming(xfer, 'Transfer stopped — the sender sent more than the file size');
    }
    xfer.pending = (xfer.pending || Promise.resolve()).then(() => xfer.sink.write(view))
      .catch(err => abortIncoming(xfer, describeSaveError(err)));
    tickProgress(xfer);
  }

  /* ── Resume ──────────────────────────────────────────────────
     A download is never thrown away because a link hiccuped. Whenever it
     stalls, or the route it used goes down, we ask the sender for the rest
     from the byte we stopped at, into the same file. */
  let ridSeq = 0;

  function downloads() {
    return new Set([...incoming.values(), ...pendingRequests.values()]);
  }

  function sendRequest(xfer) {
    if (xfer.aborted) return;
    if (xfer.key) { incoming.delete(xfer.key); xfer.key = null; } // late chunks of the old stream are ignored
    const rid = xfer.rid = ++ridSeq;
    xfer.reqAt = Date.now();
    pendingRequests.set(xfer.fileId, xfer);
    const peer = ensurePeer(xfer.ownerId);
    peer.ready().then(() => {
      if (xfer.rid !== rid || pendingRequests.get(xfer.fileId) !== xfer) return;
      try {
        peer.sendCtrl({ t: 'req', fileId: xfer.fileId, offset: xfer.received, rid });
      } catch (_) { /* link dropped this instant; the watchdog asks again */ }
    }, () => { /* link replaced or peer gone: handled elsewhere */ });
  }

  function restartDownloadsFrom(id) {
    for (const xfer of downloads()) {
      if (xfer.ownerId === id) {
        setCardState(xfer.fileId, 'active', 'Reconnecting…');
        sendRequest(xfer);
      }
    }
  }

  setInterval(() => {
    const now = Date.now();
    // Hand back relay credit for bytes that arrived but filled no window.
    peers.forEach(p => { if (p.rxUnacked) p.ackRelay(0, true); });

    for (const xfer of downloads()) {
      // Bytes still flowing — over the direct link they can, even while a
      // socket is down — means leave it alone.
      const idle = xfer.key ? now - xfer.lastData : now - xfer.reqAt;
      const blocked = !socket.connected || isAway(xfer.ownerId);
      if (xfer.waiting) {
        if (blocked) continue;
        xfer.waiting = false;   // everyone is back: pick up where we stopped
        xfer.retries = 0;
        setCardState(xfer.fileId, 'active', 'Reconnecting…');
        sendRequest(xfer);
        continue;
      }
      if (idle < (xfer.key ? STALL_MS : REQ_TIMEOUT)) continue;
      if (blocked) {
        // A phone is asleep or switching networks. Wait, without counting
        // it as a failure; the download resumes when both are back.
        xfer.waiting = true;
        const card = cards.get(xfer.fileId);
        if (card) {
          card.status.textContent = socket.connected
            ? 'Paused — waiting for ' + (card.meta.sender || 'the sender') + ' to reconnect…'
            : 'Paused — reconnecting…';
        }
        continue;
      }
      if (++xfer.retries > MAX_RETRIES) {
        for (const [key, x] of incoming) if (x === xfer) incoming.delete(key);
        abortIncoming(xfer, 'Lost the connection to the sender. Tap Try again.');
        continue;
      }
      setCardState(xfer.fileId, 'active', 'Reconnecting…');
      sendRequest(xfer);
    }
  }, 2000);

  function failTransfersFrom(peerId, reason) {
    for (const [key, xfer] of [...incoming]) {
      if (xfer.ownerId === peerId) {
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
      sender: myLabel, ownerId: myId, ts: Date.now(), available: true,
    };
    const card = renderFileCard(meta, true);

    // Show our own image immediately from the local file — no transfer needed.
    if (isImage(file.type)) {
      const url = URL.createObjectURL(file);
      objectUrls.push(url);
      attachPreview(card, url, file.name);
    }
    setCardState(fileId, 'ready', peers.size ? 'Ready to send' : 'Waiting for someone to join');

    roomEmit('file:offer', {
      fileId, name: file.name, size: file.size, type: file.type,
    });
    updateEmptyState();
  }

  const serving = new Map(); // peerId + ':' + fileId -> { cancelled }

  async function serveFile(peer, fileId, fromOffset, rid, job) {
    const file = myFiles.get(fileId);
    if (!file) throw new Error('That file is no longer shared');

    const tag = (++tagSeq) & 0xffffffff;
    // The whole file goes one way, chosen now; see Peer.sendCtrl.
    const via = peer.mode === 'p2p' && peer.dc && peer.dc.readyState === 'open' ? 'p2p' : 'relay';
    const chunkSize = via === 'relay' ? RELAY_CHUNK : peer.chunkSize;
    const begin = Number.isSafeInteger(fromOffset) && fromOffset > 0 && fromOffset <= file.size ? fromOffset : 0;
    const stopped = () => job.cancelled || peer.closed;

    peer.sendCtrl({
      t: 'start', fileId, tag, rid, offset: begin,
      name: file.name, size: file.size, mime: file.type,
    }, via);

    const progress = {
      fileId, size: file.size, sent: begin,
      startedAt: performance.now(), lastTick: performance.now(), lastBytes: 0,
      direction: 'up', peerId: peer.id, peerLabel: peer.label,
    };

    const ownCard = cards.get(fileId);
    if (ownCard) {
      const row = peerRow(ownCard, peer.id, peer.label);
      row.state = 'active';
      row.row.classList.remove('done');
      setCardState(fileId, 'active');
      updateSenderSummary(ownCard);
    }

    // Read the next slice while the current one is in flight.
    let offset = begin;
    let nextRead = offset < file.size ? readSlice(file, offset, chunkSize) : null;

    while (offset < file.size) {
      const buf = await nextRead;
      if (stopped()) return;
      const advance = buf.byteLength;
      if (offset + advance < file.size) {
        nextRead = readSlice(file, offset + advance, chunkSize);
      }
      await peer.sendChunk(tag, new Uint8Array(buf), via);
      if (stopped()) return;
      offset += advance;
      progress.sent = Math.max(begin, offset - peer.inflight); // only what has left
      tickProgress(progress);
    }

    peer.sendCtrl({ t: 'end', fileId, tag }, via);

    // The loop finishes as soon as the last chunk is queued, which can be well
    // before it reaches the other side. Keep reporting until the buffer empties,
    // but do not wait forever on a receiver that has gone quiet.
    let lastInflight = peer.inflight;
    let quietSince = performance.now();
    while (peer.inflight > 0 && !stopped()) {
      progress.sent = Math.max(begin, file.size - peer.inflight);
      tickProgress(progress, true);
      await Promise.race([peer.drained(), new Promise(r => setTimeout(r, 300))]);
      if (via === 'p2p' && (!peer.dc || peer.dc.readyState !== 'open')) break;
      if (peer.inflight !== lastInflight) { lastInflight = peer.inflight; quietSince = performance.now(); }
      else if (performance.now() - quietSince > 30000) break;
    }
    if (stopped()) return;

    const card = cards.get(fileId);
    if (card) {
      const row = peerRow(card, peer.id, peer.label);
      row.bar.style.width = '100%';
      // Their receipt can land before our buffer finishes draining; never
      // downgrade a confirmed save back to "sent".
      if (row.state !== 'got') {
        row.state = 'sent';
        row.pct.textContent = 'sent';
      }
      // Only settle the whole card once nobody is still pulling it.
      const busy = [...card.peerRows.values()].some(r => r.state === 'active');
      if (!busy) {
        setCardState(fileId, 'done');
        card.bar.style.width = '100%';
      }
      updateSenderSummary(card);
    }
  }

  function readSlice(file, offset, size) {
    return file.slice(offset, Math.min(offset + size, file.size)).arrayBuffer();
  }

  /* ── Receiving ───────────────────────────────────────────── */
  const pendingRequests = new Map(); // fileId -> xfer awaiting 'start'

  socket.on('file:offer', (meta) => {
    if (meta.ownerId === myId) return; // our own card already exists
    renderFileCard(meta, false);
    setCardState(meta.fileId, 'ready', formatSize(meta.size) + ' · from ' + meta.sender);
    playPing();
    updateEmptyState();

    // Small images arrive on their own so pictures just appear, like a chat.
    if (wantsAutoPreview(meta)) requestFile(meta, { preferMemory: true, auto: true });
  });

  socket.on('file:unavailable', ({ fileId }) => {
    myFiles.delete(fileId);
    const card = cards.get(fileId);
    if (!card || card.mine) return;
    card.meta.available = false;
    if (card.state === 'ready') {
      setCardState(fileId, 'gone', 'No longer available — ask ' + (card && card.meta.sender || 'the sender') + ' to share it again');
      if (card.action) card.action.disabled = true;
    }
  });

  /* Pictures fetch themselves, but only real, small ones, and only up to a
     budget — a flood of image offers must not fill this tab's memory. */
  let autoBytes = 0;
  function wantsAutoPreview(meta) {
    if (!isImage(meta.fileType) || !(meta.size > 0) || meta.size > AUTO_PREVIEW_MAX) return false;
    if (autoBytes + meta.size > AUTO_PREVIEW_BUDGET) return false;
    autoBytes += meta.size;
    return true;
  }

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
      auto: !!options.auto, direction: 'down', received: 0, retries: 0,
      startedAt: performance.now(), lastTick: performance.now(), lastBytes: 0,
    };
    setCardState(meta.fileId, 'active', 'Connecting…');
    sendRequest(xfer);
    syncWakeLock();
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
    if (xfer.aborted) return;
    xfer.aborted = true;
    try { if (xfer.sink) xfer.sink.abort(); } catch (_) {}
    if (xfer.key) { incoming.delete(xfer.key); xfer.key = null; }
    if (pendingRequests.get(xfer.fileId) === xfer) pendingRequests.delete(xfer.fileId);
    setCardState(xfer.fileId, 'error', reason);
    const card = cards.get(xfer.fileId);
    if (card && card.action) {
      card.action.disabled = false;
      card.action.textContent = 'Try again';
    }
    if (!xfer.auto) toast(reason, 'error');
  }

  /* ── Progress ────────────────────────────────────────────── */
  function tickProgress(p, force) {
    const card = cards.get(p.fileId);
    if (!card) return;

    const done = p.direction === 'up' ? p.sent : p.received;
    const total = p.size || 0;
    const pct = total ? Math.min(100, (done / total) * 100) : 0;

    const now = performance.now();
    const due = force || now - p.lastTick >= 250;   // repaint ~4x a second
    let speed = 0;
    if (due) {
      speed = (done - p.lastBytes) / ((now - p.lastTick) / 1000);
      p.lastTick = now;
      p.lastBytes = done;
    }

    // Outgoing transfers get one row per recipient, because several people can
    // be pulling the same file at once and they do not share a progress line.
    if (p.direction === 'up') {
      const row = peerRow(card, p.peerId, p.peerLabel);
      row.bar.style.width = pct.toFixed(1) + '%';
      if (due) {
        const eta = speed > 0 && total ? (total - done) / speed : Infinity;
        row.pct.textContent = pct.toFixed(0) + '%' + (speed > 0 ? ' · ' + formatSpeed(speed) : '');
        row.row.title = p.peerLabel + ' — ' + formatSize(done) + ' of ' + formatSize(total) +
          (isFinite(eta) ? ' · ' + formatEta(eta) : '');
        card.bar.style.width = furthestPeer(card).toFixed(1) + '%';
        updateSenderSummary(card);
      }
      return;
    }

    card.bar.style.width = pct.toFixed(1) + '%';
    if (!due) return;
    const eta = speed > 0 && total ? (total - done) / speed : Infinity;
    card.status.textContent =
      'Receiving ' + pct.toFixed(0) + '% · ' + formatSize(done) + ' of ' + formatSize(total) +
      (speed > 0 ? ' · ' + formatSpeed(speed) : '') +
      (isFinite(eta) ? ' · ' + formatEta(eta) : '');
  }

  /* A receiver left for good: their rows stop showing a live transfer. */
  function stopRowsFor(peerId) {
    for (const card of cards.values()) {
      if (!card.mine || !card.peerRows || !card.peerRows.has(peerId)) continue;
      const row = card.peerRows.get(peerId);
      if (row.state === 'active') {
        row.state = 'stopped';
        row.pct.textContent = 'stopped';
      }
      const busy = [...card.peerRows.values()].some(r => r.state === 'active');
      if (!busy && card.state === 'active') setCardState(card.meta.fileId, 'ready', 'Ready to send');
      updateSenderSummary(card);
    }
  }

  /* One row per recipient on your own card, created on first sight. */
  function peerRow(card, peerId, label) {
    card.peerRows = card.peerRows || new Map();
    let row = card.peerRows.get(peerId);
    if (row) return row;

    const el = document.createElement('div');
    el.className = 'peer-row';
    el.innerHTML =
      '<span class="peer-name"></span>' +
      '<span class="peer-track"><span class="peer-bar"></span></span>' +
      '<span class="peer-pct">0%</span>';
    el.querySelector('.peer-name').textContent = label;

    row = {
      row: el,
      label,
      bar: el.querySelector('.peer-bar'),
      pct: el.querySelector('.peer-pct'),
      state: 'active',
    };
    card.peerRows.set(peerId, row);
    if (card.peersEl) card.peersEl.appendChild(el);
    return row;
  }

  function furthestPeer(card) {
    let max = 0;
    if (!card.peerRows) return max;
    for (const r of card.peerRows.values()) {
      max = Math.max(max, parseFloat(r.bar.style.width) || 0);
    }
    return max;
  }

  /* The headline summarises; the rows carry the detail. */
  function updateSenderSummary(card) {
    if (!card.mine || !card.peerRows || !card.peerRows.size) return;
    const sending = [];
    for (const r of card.peerRows.values()) {
      if (r.state === 'active') sending.push(r.label);
    }
    if (sending.length) {
      card.status.textContent = sending.length === 1
        ? 'Sending to ' + sending[0] + '…'
        : 'Sending to ' + sending.length + ' people…';
      return;
    }
    const got = card.gotBy ? [...card.gotBy] : [];
    const all = [...card.peerRows.values()].map(r => r.label);
    if (got.length >= all.length) {
      card.status.textContent = '✓✓ Downloaded by ' + got.join(', ');
      card.el.classList.add('received');
      return;
    }
    if (got.length) {
      card.status.textContent =
        '✓✓ Downloaded by ' + got.join(', ') +
        ' · sent to ' + all.filter(n => !card.gotBy.has(n)).join(', ');
      return;
    }
    card.status.textContent = 'Sent to ' + all.join(', ');
  }

  /* ── Message rendering ───────────────────────────────────── */
  function renderHistoryEntry(entry) {
    if (entry.type === 'system') return renderSystem(entry);
    if (entry.type === 'chat') return renderChat(entry);
    if (entry.type === 'file') {
      if (entry.ownerId === myId) {
        // Ours, from before this page was reloaded: the browser no longer
        // has the file, so it cannot be sent until it is picked again.
        const card = renderFileCard(entry, true);
        setCardState(entry.fileId, 'gone', 'Pick this file again to share it — the page was reloaded');
        card.actions.innerHTML = '';
        return;
      }
      renderFileCard(entry, false);
      if (entry.available) {
        setCardState(entry.fileId, 'ready', formatSize(entry.size) + ' · from ' + entry.sender);
        // Pictures shared before we arrived should still just appear.
        if (wantsAutoPreview(entry)) requestFile(entry, { preferMemory: true, auto: true });
      } else {
        setCardState(entry.fileId, 'gone', 'No longer available — ask ' + (entry.sender || 'the sender') + ' to share it again');
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

  let lastSeenTs = 0;            // newest message on screen, for catching up
  const seenChat = new Set();    // chat ids on screen

  function renderSystem(msg) {
    lastSeenTs = Math.max(lastSeenTs, msg.ts || 0);
    const el = document.createElement('div');
    el.className = 'msg-system';
    el.textContent = msg.text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function renderChat(msg) {
    if (msg.id) {
      if (seenChat.has(msg.id)) return;
      seenChat.add(msg.id);
    }
    lastSeenTs = Math.max(lastSeenTs, msg.ts || 0);
    const mine = msg.senderId ? msg.senderId === myId : msg.sender === myLabel;
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
    lastSeenTs = Math.max(lastSeenTs, meta.ts || 0);

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
      '<div class="file-peers"></div>' +
      '<div class="file-actions"></div>';

    row.appendChild(card);

    const refs = {
      meta, mine, el: card, row,
      status: card.querySelector('.file-status'),
      bar: card.querySelector('.file-bar'),
      peersEl: card.querySelector('.file-peers'),
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
        roomEmit('file:revoke', { fileId: meta.fileId });
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
    if (inRoom && now - typingSent > 1200) { typingSent = now; socket.emit('chat:typing', true); }
  });

  function sendMessage() {
    const text = msgInput.value;
    if (!text.trim()) return;
    roomEmit('chat:message', { text });
    if (inRoom) socket.emit('chat:typing', false);
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

  /* ── Keep the screen awake while bytes move ──────────────────
     A phone that dims and locks mid-transfer suspends the page and the
     transfer stalls, on both the sending and the receiving side. Hold a
     screen wake lock while anything is in flight. The browser drops the
     lock whenever the page is hidden, so take it again on return. */
  let activeSends = 0;
  let wakeLock = null;
  let wakeLockPending = false;

  function isTransferring() {
    return activeSends > 0 || incoming.size > 0 || pendingRequests.size > 0;
  }

  async function syncWakeLock() {
    if (!('wakeLock' in navigator)) return;
    const want = isTransferring() && document.visibilityState === 'visible';
    if (want && !wakeLock && !wakeLockPending) {
      wakeLockPending = true;
      try {
        const lock = await navigator.wakeLock.request('screen');
        wakeLock = lock;
        lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
        // The transfer may have finished while we waited for the lock.
        if (!isTransferring()) syncWakeLock();
      } catch (_) { /* low battery, or not allowed: the transfer still runs */ }
      wakeLockPending = false;
    } else if (!want && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      try { await lock.release(); } catch (_) {}
    }
  }

  document.addEventListener('visibilitychange', syncWakeLock);
  // incoming and pendingRequests change in many places; checking every
  // couple of seconds is cheaper than hooking each one and never misses.
  setInterval(syncWakeLock, 2000);

  window.addEventListener('beforeunload', (e) => {
    const busy = isTransferring();
    if (busy) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
    objectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
    peers.forEach(p => p.close());
  });
}
