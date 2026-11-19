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
const isAudio = (type) => !!type && type.startsWith('audio/');

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

/* ── This device, and the devices it remembers ─────────────────
   A device has a name people see ("Windows PC · Mango") and a random id
   that only tells its own tabs apart on the server. A remembered device
   is a shared random token: both sides hold it, the server only matches
   it, and nobody else can produce it. */
const PAIR_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const NICKNAMES = ['Mango', 'Pista', 'Kaju', 'Badam', 'Jalebi', 'Laddu', 'Barfi', 'Kulfi',
  'Peda', 'Rasgulla', 'Kesar', 'Chikki', 'Rabri', 'Imarti', 'Modak', 'Payasam'];

function detectKind() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'tablet';
  if (/Android/.test(ua) && !/Mobile/.test(ua)) return 'tablet';
  if (/iPhone|iPod|Android|Mobile/.test(ua)) return 'phone';
  return 'laptop';
}

function defaultDeviceName(kind) {
  const ua = navigator.userAgent;
  let base = 'Computer';
  if (/iPhone|iPod/.test(ua)) base = 'iPhone';
  else if (kind === 'tablet' && !/Android/.test(ua)) base = 'iPad';
  else if (/Android/.test(ua)) base = kind === 'tablet' ? 'Android tablet' : 'Android phone';
  else if (/CrOS/.test(ua)) base = 'Chromebook';
  else if (/Mac/.test(ua)) base = 'Mac';
  else if (/Windows/.test(ua)) base = 'Windows PC';
  else if (/Linux/.test(ua)) base = 'Linux PC';
  const nick = NICKNAMES[crypto.getRandomValues(new Uint8Array(1))[0] % NICKNAMES.length];
  return base + ' · ' + nick;
}

function cleanDeviceName(v) {
  return String(v || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32).trim();
}

let deviceCache = null;
function getDevice() {
  if (deviceCache) return deviceCache;
  let d = null;
  try { d = JSON.parse(localStorage.getItem('halwa-device') || 'null'); } catch (_) {}
  if (!d || typeof d.id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(d.id) || !cleanDeviceName(d.name)) {
    const kind = detectKind();
    d = { id: uid(), name: defaultDeviceName(kind), kind };
    try { localStorage.setItem('halwa-device', JSON.stringify(d)); } catch (_) {}
  }
  d.kind = ['phone', 'tablet', 'laptop', 'desktop'].includes(d.kind) ? d.kind : detectKind();
  d.name = cleanDeviceName(d.name);
  deviceCache = d;
  return d;
}

function renameDevice(name) {
  const clean = cleanDeviceName(name);
  if (!clean) return false;
  const d = getDevice();
  d.name = clean;
  try { localStorage.setItem('halwa-device', JSON.stringify(d)); } catch (_) {}
  return true;
}

function getPaired() {
  try {
    const list = JSON.parse(localStorage.getItem('halwa-paired') || '[]');
    return Array.isArray(list) ? list.filter(p => p && PAIR_TOKEN_RE.test(p.token) && typeof p.name === 'string') : [];
  } catch (_) { return []; }
}

function savePaired(list) {
  try { localStorage.setItem('halwa-paired', JSON.stringify(list.slice(0, 50))); } catch (_) {}
}

function addPaired(rec) {
  // Pairing the same device again replaces the old pairing.
  const list = getPaired().filter(p => p.token !== rec.token && !(rec.device && p.device === rec.device));
  list.unshift(rec);
  savePaired(list);
}

function removePaired(token) {
  savePaired(getPaired().filter(p => p.token !== token));
}

/* Whether other devices on this network may see this one. */
function isVisibleNearby() {
  try { return localStorage.getItem('halwa-visible') !== '0'; } catch (_) { return true; }
}

function kindIcon(kind) {
  return kind === 'phone' || kind === 'tablet' ? '📱' : kind === 'desktop' ? '🖥️' : '💻';
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomPart() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));   // 43 characters
}

async function pairToken(requesterPart, responderPart) {
  const digest = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode('halwa-pair-v1|' + requesterPart + '|' + responderPart));
  return b64url(new Uint8Array(digest));
}

/* Tells the server who this page is, and keeps the lists of nearby and
   remembered devices current. Used by the start page and by rooms. */
function startPresence(socket, on) {
  const state = { nearby: [], online: new Map() };
  function hello() {
    const d = getDevice();
    socket.emit('presence:hello', {
      name: d.name, kind: d.kind, device: d.id, clientId: getClientId(),
      tokens: getPaired().map(p => p.token), visible: isVisibleNearby(),
    });
  }
  socket.on('connect', hello);
  if (socket.connected) hello();
  socket.on('presence:nearby', (list) => { state.nearby = Array.isArray(list) ? list : []; on.change(); });
  socket.on('presence:paired', ({ token, online }) => { state.online.set(token, !!online); on.change(); });
  socket.on('presence:forgotten', ({ token }) => {
    if (!getPaired().some(p => p.token === token)) return;
    removePaired(token);
    state.online.delete(token);
    hello();
    on.change();
  });
  socket.on('presence:invited', (inv) => {
    if (!inv || typeof inv.code !== 'string' || !/^\d{6}$/.test(inv.code)) return;
    const paired = inv.token ? getPaired().find(p => p.token === inv.token) : null;
    on.invited(Object.assign({}, inv, { paired, from: paired ? paired.name : cleanDeviceName(inv.from) || 'A device' }));
  });
  socket.on('presence:knock', (k) => {
    if (!k || typeof k.kid !== 'string' || !on.knock) return;
    const paired = k.token ? getPaired().find(p => p.token === k.token) : null;
    on.knock({ kid: k.kid, kind: k.kind, paired: !!paired, from: paired ? paired.name : cleanDeviceName(k.from) || 'A device' });
  });
  socket.on('presence:declined', (d) => {
    if (d && typeof d.kid === 'string' && on.declined) on.declined({ kid: d.kid, from: cleanDeviceName(d.from) || 'They' });
  });
  return {
    state,
    hello,
    invite(target, code) {
      return new Promise((resolve) => {
        const arg = Object.assign({ clientId: getClientId() }, target);
        if (code) arg.code = code;
        socket.timeout(8000).emit('presence:invite', arg, (err, res) => {
          resolve(err ? { error: 'No answer from the server. Try again.' } : (res || { error: 'Try again.' }));
        });
      });
    },
    answer(kid, ok) { socket.emit('presence:answer', { kid, ok: !!ok }); },
    forget(token) {
      socket.emit('presence:forget', { token });
      removePaired(token);
      state.online.delete(token);
      hello();
      on.change();
    },
    /* Remembered devices first (online ones on top), then strangers nearby. */
    list() {
      const paired = getPaired().map(p => ({ paired: true, token: p.token, name: p.name, kind: p.kind, online: !!state.online.get(p.token) }));
      paired.sort((a, b) => Number(b.online) - Number(a.online));
      // A remembered device that is online is listed once, under its pairing.
      const known = new Set(paired.filter(p => p.online).map(p => p.name));
      const nearby = state.nearby
        .map(n => ({ paired: false, id: n.id, name: cleanDeviceName(n.name), kind: n.kind, online: true }))
        .filter(n => !known.has(n.name));
      return { paired, nearby };
    },
  };
}

/* One row in a device list. */
function deviceRow(dev, actionLabel, onAction, onForget) {
  const li = document.createElement('li');
  li.className = 'device-item' + (dev.online ? '' : ' offline');
  const icon = document.createElement('span');
  icon.className = 'device-icon';
  icon.textContent = kindIcon(dev.kind);
  const text = document.createElement('span');
  text.className = 'device-text';
  const name = document.createElement('span');
  name.className = 'device-name';
  name.textContent = dev.name;
  const st = document.createElement('span');
  st.className = 'device-state';
  st.textContent = dev.paired ? (dev.online ? 'online' : 'offline') : 'nearby';
  text.append(name, st);
  li.append(icon, text);
  if (dev.online) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-sm';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => onAction(dev, btn));
    li.appendChild(btn);
  }
  if (onForget) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'device-forget';
    x.title = 'Forget ' + dev.name;
    x.setAttribute('aria-label', 'Forget ' + dev.name);
    x.textContent = '✕';
    x.addEventListener('click', () => onForget(dev));
    li.appendChild(x);
  }
  return li;
}

/* Things sent from the HalwaShare browser extension. Its script runs in
   this page and posts here; nothing from another site can, because the
   message must come from this very window and origin. */
function onExtensionItem(handler) {
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.source !== 'halwa-ext' || !d.item || typeof d.item !== 'object') return;
    const item = d.item;
    const text = typeof item.text === 'string' ? item.text.slice(0, 4000) : '';
    let file = null;
    if (item.file && typeof item.file.data === 'string' && item.file.data.length < 40 * 1024 * 1024) {
      try {
        const bin = atob(item.file.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        file = new File([bytes], cleanDeviceName(item.file.name) || 'image',
          { type: typeof item.file.type === 'string' ? item.file.type.slice(0, 100) : '' });
      } catch (_) { file = null; }
    }
    if (text || file) handler({ text, files: file ? [file] : [] });
  });
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
    // Parked by the extension in this very tab: keep it.
    let armedHere = false;
    try { armedHere = sessionStorage.getItem(SHARE_ARMED) === '1'; } catch (_) {}
    if (!isStandalone() && !armedHere) { clearShared(); return; }
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
      document.getElementById('install-desktop').classList.toggle('hidden', detectKind() !== 'laptop');
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

  /* ── Devices: remembered and nearby ────────────────────────── */
  const myDevicesEl = document.getElementById('my-devices');
  const nearbyEl = document.getElementById('nearby');
  const inviteIn = document.getElementById('invite-in');
  const deviceNameEl = document.getElementById('device-name');
  deviceNameEl.textContent = getDevice().name;

  const presence = startPresence(socket, { change: renderDevices, invited: onInvited, declined: onDeclined });
  let knocking = null;   // { kid, btn }: waiting to be let into someone's room

  function renderDevices() {
    const { paired, nearby } = presence.list();
    myDevicesEl.replaceChildren(...paired.map(d => deviceRow(d, 'Connect', connectTo, forgetDevice)));
    nearbyEl.replaceChildren(...nearby.map(d => deviceRow(d, 'Connect', connectTo)));
    document.getElementById('my-devices-empty').classList.toggle('hidden', paired.length > 0);
    document.getElementById('nearby-empty').classList.toggle('hidden', nearby.length > 0);
  }
  renderDevices();

  async function connectTo(dev, btn) {
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    const res = await presence.invite(dev.paired ? { token: dev.token } : { to: dev.id });
    if (res.code) { window.location.href = '/join/' + res.code; return; }
    if (res.waiting && res.kid) {
      // They are in a room already: wait for them to let us in.
      btn.textContent = 'Waiting for ' + dev.name + '…';
      const kid = res.kid;
      knocking = { kid, btn };
      setTimeout(() => {
        if (!knocking || knocking.kid !== kid) return;
        knocking = null;
        showError(dev.name + ' did not answer. Try again.');
        resetConnect(btn);
      }, 2 * 60 * 1000);
      return;
    }
    showError(res.error || 'Could not connect. Try again.');
    resetConnect(btn);
  }

  function resetConnect(btn) {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }

  function onDeclined(d) {
    if (!knocking || knocking.kid !== d.kid) return;
    const { btn } = knocking;
    knocking = null;
    showError(d.from + ' did not let you in this time.');
    resetConnect(btn);
  }

  function forgetDevice(dev) {
    if (!window.confirm('Forget ' + dev.name + '? It will forget this device too.')) return;
    presence.forget(dev.token);
  }

  /* A remembered device that connects to us opens the room at once — that
     is the point of remembering it. Anyone else nearby has to be accepted. */
  let inviteTimer = null;
  function onInvited(inv) {
    // Remembered devices, and the room we just asked to be let into, open at once.
    if (inv.paired || (knocking && inv.kid && inv.kid === knocking.kid)) { window.location.href = '/join/' + inv.code; return; }
    inviteIn.replaceChildren();
    const p = document.createElement('p');
    p.className = 'invite-in-text';
    p.textContent = kindIcon(inv.kind) + ' ' + inv.from + ' wants to share with you.';
    const actions = document.createElement('div');
    actions.className = 'share-confirm-actions';
    const no = document.createElement('button');
    no.type = 'button'; no.className = 'btn btn-ghost btn-sm'; no.textContent = 'Decline';
    const yes = document.createElement('button');
    yes.type = 'button'; yes.className = 'btn btn-primary btn-sm'; yes.textContent = 'Join';
    actions.append(no, yes);
    inviteIn.append(p, actions);
    inviteIn.classList.remove('hidden');
    yes.focus();
    const close = () => { inviteIn.classList.add('hidden'); clearTimeout(inviteTimer); };
    no.addEventListener('click', close);
    yes.addEventListener('click', () => { window.location.href = '/join/' + inv.code; });
    clearTimeout(inviteTimer);
    inviteTimer = setTimeout(close, 60000);
  }

  const btnVisible = document.getElementById('btn-visible');
  const paintVisible = () => {
    btnVisible.textContent = isVisibleNearby() ? 'Hide me from nearby' : 'Show me to nearby devices';
    document.getElementById('nearby-empty').textContent = isVisibleNearby()
      ? 'Open HalwaShare on another device on this Wi-Fi and it appears here.'
      : 'Hidden — other devices on this network cannot see this one, and it does not see them. Remembered devices still work.';
  };
  paintVisible();
  btnVisible.addEventListener('click', () => {
    try { localStorage.setItem('halwa-visible', isVisibleNearby() ? '0' : '1'); } catch (_) {}
    paintVisible();
    presence.hello();
  });

  document.getElementById('btn-rename').addEventListener('click', () => {
    const name = window.prompt('Name this device — others see it in rooms and nearby lists:', getDevice().name);
    if (name === null) return;
    if (!renameDevice(name)) return showError('Pick a name with at least one letter.');
    deviceNameEl.textContent = getDevice().name;
    presence.hello();
  });

  /* The extension hands over a picture, link or text: keep it, like a
     share from the phone's Share menu, until a room is open. */
  onExtensionItem(async ({ text, files }) => {
    try {
      await clearShared();
      const cache = await caches.open(SHARE_CACHE);
      for (let i = 0; i < files.length; i++) {
        await cache.put('/__shared/' + i, new Response(files[i], { headers: { 'Content-Type': files[i].type || 'application/octet-stream' } }));
      }
      await cache.put('/__shared/index', new Response(JSON.stringify({
        files: files.map(f => ({ name: f.name, type: f.type, size: f.size })), text, at: Date.now(),
      }), { headers: { 'Content-Type': 'application/json' } }));
      sessionStorage.setItem(SHARE_ARMED, '1');
    } catch (_) { return; }
    const el = document.getElementById('share-pending');
    el.textContent = '📎 ' + (files.length ? files[0].name : 'Your text') +
      ' is ready. Create or join a room, or tap a device, and you can send it from there.';
    el.classList.remove('hidden');
  });
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
      code: urlCode, clientId, name: getDevice().name,
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
        restoreChat();
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
      } else if (h.ts > since && h.type === 'system') {
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
      const lock = !self && peer && peer.safety && peer.linkAlive()
        ? '<span class="safety-badge" title="Verified link available — tap to compare the safety code">🔐</span>' : '';
      if (peer) peer.label = u.label;   // follow renames
      return '<li class="user-item tappable' + (u.away ? ' away' : '') + '"' +
        (self
          ? ' data-self="1" tabindex="0" role="button" title="Tap to change your name"'
          : ' data-id="' + escapeHtml(u.id) + '" tabindex="0" role="button" title="Safety code with ' + escapeHtml(u.label) + '"') + '>' +
        '<span class="avatar">' + escapeHtml(avatarText(u.label)) + '</span>' +
        '<span class="user-name">' + escapeHtml(u.label) + (self ? ' (you) ✏️' : u.away ? ' · reconnecting…' : '') + '</span>' +
        lock + badge +
      '</li>';
    }).join('');
    $('user-count').textContent = users.length;
    syncWakeLock();
    if (users.some(u => u.id !== myId && !u.away)) maybeAskNotify();
    if (typeof paintNearbyCount === 'function') paintNearbyCount();
  }

  userListEl.addEventListener('click', (e) => {
    if (e.target.closest('.user-item[data-self]')) return renameSelf();
    const item = e.target.closest('.user-item[data-id]');
    if (item) showSafety(item.dataset.id);
  });

  /* Your name here is also this device's name everywhere else. */
  function renameSelf() {
    const name = window.prompt('Your name — everyone in the room sees it:', myLabel || getDevice().name);
    if (name === null) return;
    const clean = cleanDeviceName(name);
    if (!clean) return toast('Pick a name with at least one letter or number', 'error');
    if (!inRoom) return toast('Reconnecting — try again in a moment');
    socket.emit('room:rename', { name: clean }, (res) => {
      if (!res || res.error) return toast((res && res.error) || 'Could not change your name', 'error');
      myLabel = res.label;
      renameDevice(clean);
      presence.hello();
      if (res.label !== clean) toast('Someone here is already ' + clean + ' — you are ' + res.label);
    });
  }
  userListEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('.user-item[data-self]')) { e.preventDefault(); return renameSelf(); }
    const item = e.target.closest('.user-item[data-id]');
    if (item) { e.preventDefault(); showSafety(item.dataset.id); }
  });

  /* "User 2" shows 2; a device name shows its first letter. */
  function avatarText(label) {
    if (/^User \d+$/.test(label)) return label.slice(5);
    const first = Array.from(String(label).trim())[0] || '?';
    return first.toUpperCase();
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
      if (mode === 'p2p') {
        const pc = this.pc;
        safetyCode(this).then((code) => {
          if (this.pc === pc) { this.safety = code; refreshUsers(); }
        });
      }
      clearTimeout(this.graceTimer);
      // A link that just came up: hand them the chat they missed.
      if ((mode === 'p2p' || mode === 'relay') && prev !== 'p2p' && prev !== 'relay') {
        setTimeout(() => syncChatTo(this), 0);
      }
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
    closeScreenFor(id);
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
    if (screenStream) setTimeout(() => { if (screenStream) shareScreenTo(id); }, 1200);
  });

  socket.on('rtc:peer-left', ({ id }) => dropPeer(id, 'the sender left the room'));

  socket.on('rtc:signal', async ({ from, payload }) => {
    if (payload && typeof payload.type === 'string' && payload.type.startsWith('scr-')) {
      return handleScreenSignal(from, payload);
    }
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

      case 'chat':                   // a message, straight from its author
        receiveChat(peer, msg, false);
        break;

      case 'chat-sync':              // their own earlier messages, for us
        if (Array.isArray(msg.list)) msg.list.slice(-CHAT_MAX).forEach(m => receiveChat(peer, m, true));
        if (Array.isArray(msg.reacts)) {
          msg.reacts.slice(0, 2000).forEach(r => Array.isArray(r) && applyReact(peer.id, r[0], r[1], true));
        }
        break;

      case 'chat-ack': {             // they have our message
        const r = typeof msg.id === 'string' && receipts.get(msg.id);
        if (r) { r.acked.add(peer.label); markReceipt(msg.id); }
        break;
      }

      case 'react':
        applyReact(peer.id, msg.key, msg.emoji, msg.on !== false);
        break;

      case 'pair-req':               // they want to remember this device
        if (PAIR_TOKEN_RE.test(msg.part)) askPair(peer, msg);
        break;

      case 'pair-ok':                // they agreed
        finishPair(peer, msg);
        break;

      case 'pair-no':
        if (pairPending.has(peer.id)) {
          pairPending.delete(peer.id);
          toast(peer.label + ' chose not to remember this device');
        }
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
    // Entries must be taken now, inside the event; they vanish after it.
    const entries = [...(e.dataTransfer.items || [])]
      .map(i => (i.kind === 'file' && i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
    if (entries.some(en => en && en.isDirectory)) {
      const files = [...(e.dataTransfer.files || [])];
      entries.forEach((en, i) => {
        if (en && en.isDirectory) offerDroppedFolder(en);
        else if (files[i]) offerFile(files[i]);
        else if (en && en.isFile) en.file(offerFile);
      });
      return;
    }
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

    // Show our own picture or voice note straight from the local file.
    if (isImage(file.type) || (isAudio(file.type) && file.size <= AUTO_PREVIEW_MAX)) {
      const url = URL.createObjectURL(file);
      objectUrls.push(url);
      attachPreview(card, url, file.name, file.type);
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
    noteArrival(meta.sender + (isAudio(meta.fileType) && /^Voice note/.test(meta.name) ? ' sent a voice note' : ' shared a file'),
      meta.name + ' · ' + formatSize(meta.size));
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
    if (!(isImage(meta.fileType) || isAudio(meta.fileType)) || !(meta.size > 0) || meta.size > AUTO_PREVIEW_MAX) return false;
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
        if ((isImage(xfer.mime) || isAudio(xfer.mime)) && card) attachPreview(card, url, xfer.name, xfer.mime);
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

  function rowFor(sender, ts, mine, inOrder) {
    const row = document.createElement('div');
    row.className = 'msg-row ' + (mine ? 'self' : 'other');
    row.dataset.ts = String(ts || Date.now());
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = (mine ? 'You' : sender) + ' · ' + formatTime(ts);
    row.appendChild(meta);
    placeByTime(row, inOrder);
    return row;
  }

  /* New things go at the bottom; earlier messages handed over by someone
     go where they belong in time. */
  function placeByTime(el, inOrder) {
    if (inOrder) {
      const ts = Number(el.dataset.ts);
      const after = [...messagesEl.children].find(c => c.dataset.ts && Number(c.dataset.ts) > ts);
      if (after) { messagesEl.insertBefore(el, after); return; }
    }
    messagesEl.appendChild(el);
  }

  let lastSeenTs = 0;            // newest message on screen, for catching up
  const seenChat = new Set();    // chat ids on screen

  function renderSystem(msg) {
    lastSeenTs = Math.max(lastSeenTs, msg.ts || 0);
    const el = document.createElement('div');
    el.className = 'msg-system';
    el.dataset.ts = String(msg.ts || Date.now());
    el.textContent = msg.text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  /* msg: { key, id, senderId, sender, text, ts, reply }. `opts.inOrder`
     places it by time; `opts.restored` is a message this page already
     showed before a refresh, so no receipts are asked for again. */
  function renderChat(msg, opts) {
    const o = opts || {};
    if (seenChat.has(msg.key)) return;
    seenChat.add(msg.key);
    lastSeenTs = Math.max(lastSeenTs, msg.ts || 0);
    const mine = msg.senderId === myId;
    const row = rowFor(msg.sender, msg.ts, mine, o.inOrder);
    row.dataset.key = msg.key;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (msg.reply) bubble.appendChild(quoteFor(msg.reply));
    const body = document.createElement('span');
    body.innerHTML = linkify(msg.text);
    bubble.appendChild(body);
    row.appendChild(bubble);

    if (mine && !o.restored) {
      // One tick: sent. Two: the others have it.
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
    }

    const chips = document.createElement('div');
    chips.className = 'reacts';
    row.appendChild(chips);

    const tools = document.createElement('div');
    tools.className = 'msg-tools';
    const tool = (label, title, fn) => {
      const b = document.createElement('button');
      b.className = 'copy-btn';
      b.type = 'button';
      b.title = title;
      b.textContent = label;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); });
      tools.appendChild(b);
      return b;
    };
    tool('Reply', 'Reply to this message', () => startReply(msg));
    tool('☺+', 'React', (b) => openReactPicker(msg.key, b));
    tool('Copy', 'Copy text', (b) => {
      copyText(msg.text);
      b.textContent = 'Copied';
      setTimeout(() => { b.textContent = 'Copy'; }, 1400);
    });
    row.appendChild(tools);
    paintReacts(msg.key);
    scrollToBottom();
  }

  /* The message being replied to, shown inside the reply. Looked up here
     by its key, so nobody can put words in someone else's mouth. */
  function quoteFor(key) {
    const q = document.createElement('button');
    q.type = 'button';
    q.className = 'quote';
    q.dataset.reply = key;
    fillQuote(q);
    q.addEventListener('click', () => {
      const el = messagesEl.querySelector('[data-key="' + CSS.escape(key) + '"]');
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1200);
    });
    return q;
  }

  function fillQuote(q) {
    const target = chatLog.find(m => m.key === q.dataset.reply);
    const who = document.createElement('strong');
    who.textContent = target ? (target.senderId === myId ? 'You' : target.sender) : 'Earlier message';
    const what = document.createElement('span');
    what.textContent = target ? snippet(target.text) : 'not on this device';
    q.replaceChildren(who, what);
  }

  /* A reply can arrive before the message it answers (someone joining
     late gets each person's messages separately): fill it in then. */
  function refreshQuotes(key) {
    messagesEl.querySelectorAll('.quote[data-reply="' + CSS.escape(key) + '"]').forEach(fillQuote);
  }

  function snippet(text) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    return t.length > 90 ? t.slice(0, 89) + '…' : t;
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

  function attachPreview(card, url, name, mime) {
    if (card.el.querySelector('.file-preview')) return;
    if (isAudio(mime)) {
      const audio = document.createElement('audio');
      audio.className = 'file-preview file-audio';
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = url;
      card.el.insertBefore(audio, card.el.querySelector('.file-track'));
      scrollToBottom();
      return;
    }
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
    if (!sendChat(text)) return;
    if (inRoom) socket.emit('chat:typing', false);
    msgInput.value = '';
    msgInput.focus();
  }

  /* Only the server's own notes ("X joined") still come from the server. */
  socket.on('chat:message', (msg) => {
    if (msg && msg.type === 'system') { renderSystem(msg); updateEmptyState(); }
  });

  /* ── Chat, peer to peer ──────────────────────────────────────
     Messages go from the writer straight to each person over the same
     link the files use, so the server never sees them. (When no direct
     link can be made, they ride the relay, as files do.) Nobody else
     holds the history, so:
       · each page keeps this room's chat for itself (sessionStorage),
         so a refresh loses nothing
       · when a link comes up, each side hands over the messages it wrote
         itself — someone arriving late sees what the people here said,
         and every message's author is the person whose link carried it. */
  const CHAT_MAX = 300;
  const CHAT_KEY = 'halwa-chat-' + urlCode;
  const REACTIONS = ['👍', '❤️', '😂', '😮', '🙏', '✅'];
  const MSG_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
  let chatLog = [];                    // { key, id, senderId, sender, text, ts, reply }
  const reactions = new Map();         // key -> Map(emoji -> Set(pid))
  let replyTo = null;

  function chatId() {
    return b64url(crypto.getRandomValues(new Uint8Array(12)));
  }

  function saveChat() {
    try {
      const reacts = [];
      for (const [key, m] of reactions) for (const [emoji, who] of m) for (const pid of who) reacts.push([key, emoji, pid]);
      sessionStorage.setItem(CHAT_KEY, JSON.stringify({ log: chatLog.slice(-CHAT_MAX), reacts: reacts.slice(-3000) }));
    } catch (_) {}
  }

  /* After a refresh: what this page had already shown. */
  function restoreChat() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(CHAT_KEY) || 'null'); } catch (_) {}
    if (!saved || !Array.isArray(saved.log)) return;
    for (const r of Array.isArray(saved.reacts) ? saved.reacts : []) {
      if (Array.isArray(r) && typeof r[2] === 'string') setReact(r[2], r[0], r[1], true);
    }
    for (const m of saved.log) {
      if (!m || typeof m.key !== 'string' || typeof m.text !== 'string' || seenChat.has(m.key)) continue;
      addToLog(m);
      renderChat(m, { inOrder: true, restored: true });
    }
    updateEmptyState();
  }

  function addToLog(m) {
    let i = chatLog.length;
    while (i > 0 && chatLog[i - 1].ts > m.ts) i--;
    chatLog.splice(i, 0, m);
    if (chatLog.length > CHAT_MAX) chatLog.splice(0, chatLog.length - CHAT_MAX);
  }

  function sendChat(text) {
    const clean = String(text).slice(0, 4000);
    if (!clean.trim()) return false;
    if (!myId) { toast('Still connecting — try again in a moment'); return false; }
    const id = chatId();
    const msg = { key: myId + '/' + id, id, senderId: myId, sender: myLabel, text: clean, ts: Date.now() };
    if (replyTo) msg.reply = replyTo.key;
    clearReply();
    addToLog(msg);
    saveChat();
    renderChat(msg);
    updateEmptyState();
    for (const peer of peers.values()) {
      peer.ready().then(() => peer.sendCtrl({ t: 'chat', id, text: clean, ts: msg.ts, reply: msg.reply }))
        .catch(() => {});   // gone; they get it from the sync if they come back
    }
    return true;
  }

  function receiveChat(peer, m, synced) {
    if (!m || typeof m.id !== 'string' || !MSG_ID_RE.test(m.id)) return;
    if (typeof m.text !== 'string' || !m.text.trim()) return;
    const key = peer.id + '/' + m.id;            // the link says who wrote it
    if (seenChat.has(key)) {
      if (!synced) { try { peer.sendCtrl({ t: 'chat-ack', id: m.id }); } catch (_) {} }
      return;
    }
    const now = Date.now();
    const ts = Number.isFinite(m.ts) && m.ts < now + 60000 && m.ts > now - 7 * 864e5 ? m.ts : now;
    const msg = { key, id: m.id, senderId: peer.id, sender: peer.label, text: m.text.slice(0, 4000), ts };
    if (typeof m.reply === 'string' && m.reply.length <= 120) msg.reply = m.reply;
    addToLog(msg);
    saveChat();
    renderChat(msg, { inOrder: synced });
    refreshQuotes(key);
    updateEmptyState();
    try { peer.sendCtrl({ t: 'chat-ack', id: m.id }); } catch (_) {}
    if (!synced) { playPing(); noteArrival(msg.sender, msg.text); }
  }

  /* Our own messages and reactions, for someone whose link just came up.
     Sent in parts: a data channel message has a size limit. */
  function syncChatTo(peer) {
    if (!myId || peer.closed) return;
    const mine = chatLog.filter(m => m.senderId === myId).slice(-150)
      .map(m => ({ id: m.id, text: m.text, ts: m.ts, reply: m.reply }));
    const reacts = [];
    for (const [key, m] of reactions) for (const [emoji, who] of m) if (who.has(myId)) reacts.push([key, emoji]);
    if (!mine.length && !reacts.length) return;
    let part = [];
    let size = 0;
    const flush = (withReacts) => {
      try { peer.sendCtrl({ t: 'chat-sync', list: part, reacts: withReacts ? reacts : [] }); } catch (_) {}
      part = []; size = 0;
    };
    for (const m of mine) {
      const n = m.text.length * 3 + 120;
      if (size + n > 48 * 1024 && part.length) flush(false);
      part.push(m); size += n;
    }
    flush(true);
  }

  /* ── Replies ── */
  const replyBar = document.createElement('div');
  replyBar.className = 'reply-bar hidden';
  document.querySelector('.composer').before(replyBar);

  function startReply(msg) {
    replyTo = msg;
    replyBar.replaceChildren();
    const t = document.createElement('span');
    t.className = 'reply-bar-text';
    const who = document.createElement('strong');
    who.textContent = 'Replying to ' + (msg.senderId === myId ? 'yourself' : msg.sender);
    const what = document.createElement('span');
    what.textContent = snippet(msg.text);
    t.append(who, what);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'reply-bar-close';
    x.setAttribute('aria-label', 'Cancel reply');
    x.textContent = '✕';
    x.addEventListener('click', clearReply);
    replyBar.append(t, x);
    replyBar.classList.remove('hidden');
    msgInput.focus();
  }

  function clearReply() {
    replyTo = null;
    replyBar.classList.add('hidden');
    replyBar.replaceChildren();
  }
  msgInput.addEventListener('keydown', (e) => { if (e.key === 'Escape' && replyTo) clearReply(); });

  /* ── Reactions ── */
  function setReact(pid, key, emoji, on) {
    if (typeof key !== 'string' || key.length > 120 || !REACTIONS.includes(emoji)) return false;
    let m = reactions.get(key);
    if (!m) { if (!on) return false; m = new Map(); reactions.set(key, m); }
    let who = m.get(emoji);
    if (!who) { if (!on) return false; who = new Set(); m.set(emoji, who); }
    if (on) who.add(pid); else who.delete(pid);
    if (!who.size) m.delete(emoji);
    if (!m.size) reactions.delete(key);
    return true;
  }

  function applyReact(pid, key, emoji, on) {
    if (reactions.size > 3000 && !reactions.has(key)) return;
    if (!setReact(pid, key, emoji, on)) return;
    saveChat();
    paintReacts(key);
  }

  function toggleReact(key, emoji) {
    const m = reactions.get(key);
    const on = !(m && m.get(emoji) && m.get(emoji).has(myId));
    applyReact(myId, key, emoji, on);
    for (const peer of peers.values()) {
      peer.ready().then(() => peer.sendCtrl({ t: 'react', key, emoji, on })).catch(() => {});
    }
  }

  function nameOf(pid) {
    if (pid === myId) return 'You';
    const u = roomUsers.find(x => x.id === pid);
    return u ? u.label : 'Someone who left';
  }

  function paintReacts(key) {
    const row = messagesEl.querySelector('[data-key="' + CSS.escape(key) + '"]');
    const box = row && row.querySelector('.reacts');
    if (!box) return;
    box.replaceChildren();
    const m = reactions.get(key);
    if (!m) return;
    for (const emoji of REACTIONS) {
      const who = m.get(emoji);
      if (!who || !who.size) continue;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'react-chip' + (who.has(myId) ? ' mine' : '');
      chip.textContent = emoji + (who.size > 1 ? ' ' + who.size : '');
      chip.title = [...who].map(nameOf).join(', ');
      chip.addEventListener('click', () => toggleReact(key, emoji));
      box.appendChild(chip);
    }
  }

  let openPicker = null;
  function openReactPicker(key, anchor) {
    if (openPicker) openPicker.remove();
    const pick = document.createElement('div');
    pick.className = 'react-picker';
    pick.setAttribute('role', 'menu');
    for (const emoji of REACTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = emoji;
      b.addEventListener('click', (e) => { e.stopPropagation(); toggleReact(key, emoji); pick.remove(); openPicker = null; });
      pick.appendChild(b);
    }
    anchor.closest('.msg-row').appendChild(pick);
    openPicker = pick;
    pick.querySelector('button').focus();
  }
  document.addEventListener('click', (e) => {
    if (openPicker && !openPicker.contains(e.target)) { openPicker.remove(); openPicker = null; }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openPicker) { openPicker.remove(); openPicker = null; }
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

  /* ── Keep the screen awake ───────────────────────────────────
     A phone whose screen turns off suspends the page: the connection
     drops and any transfer stalls. Nothing a web page can do keeps it
     running with the screen off, so instead keep the screen on — always
     while bytes are moving, and, unless the person turns it off with ☕,
     the whole time someone else is in the room. The browser drops the
     lock whenever the page is hidden, so take it again on return. */
  let activeSends = 0;
  let wakeLock = null;
  let wakeLockPending = false;
  let stayAwake = true;
  try { stayAwake = localStorage.getItem('halwa-awake') !== '0'; } catch (_) {}

  const btnAwake = $('btn-awake');
  if ('wakeLock' in navigator) {
    btnAwake.classList.remove('hidden');
    paintAwake();
  }
  btnAwake.addEventListener('click', () => {
    stayAwake = !stayAwake;
    try { localStorage.setItem('halwa-awake', stayAwake ? '1' : '0'); } catch (_) {}
    paintAwake();
    syncWakeLock();
    toast(stayAwake
      ? 'Screen stays on while others are in the room'
      : 'Screen can turn off now — it still stays on during transfers');
  });

  function paintAwake() {
    btnAwake.classList.toggle('on', stayAwake);
    btnAwake.setAttribute('aria-pressed', String(stayAwake));
    btnAwake.title = stayAwake
      ? 'Screen stays on while others are here — tap to let it turn off'
      : 'Screen may turn off — tap to keep it on while others are here';
  }

  function isTransferring() {
    return activeSends > 0 || incoming.size > 0 || pendingRequests.size > 0;
  }

  function wantAwake() {
    if (isTransferring()) return true;
    return stayAwake && roomUsers.some(u => u.id !== myId && !u.away);
  }

  async function syncWakeLock() {
    if (!('wakeLock' in navigator)) return;
    const want = wantAwake() && document.visibilityState === 'visible';
    if (want && !wakeLock && !wakeLockPending) {
      wakeLockPending = true;
      try {
        const lock = await navigator.wakeLock.request('screen');
        wakeLock = lock;
        lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
        // Things may have changed while we waited for the lock.
        if (!wantAwake()) syncWakeLock();
      } catch (_) { /* low battery, or not allowed: the transfer still runs */ }
      wakeLockPending = false;
    } else if (!want && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      try { await lock.release(); } catch (_) {}
    }
  }

  document.addEventListener('visibilitychange', syncWakeLock);
  // Some browsers only grant the lock after a tap.
  document.addEventListener('pointerdown', () => { if (!wakeLock) syncWakeLock(); }, { passive: true });
  // incoming and pendingRequests change in many places; checking every
  // couple of seconds is cheaper than hooking each one and never misses.
  setInterval(syncWakeLock, 2000);

  /* ── Alerts while in the background ──────────────────────────
     A file or message that arrives while HalwaShare is not on screen
     shows as a count in the tab title and on the app icon, and — if the
     person allowed it — as a notification. */
  const baseTitle = document.title;
  let unread = 0;

  function noteArrival(title, body) {
    if (document.visibilityState === 'visible') return;
    unread++;
    document.title = '(' + unread + ') ' + baseTitle;
    if (navigator.setAppBadge) navigator.setAppBadge(unread).catch(() => {});
    if ('Notification' in window && Notification.permission === 'granted') {
      showNotice(title, String(body || ''));
    }
  }

  async function showNotice(title, body) {
    const opts = {
      body: body.length > 140 ? body.slice(0, 139) + '…' : body,
      tag: 'halwa-' + urlCode,       // one notification per room, replaced
      renotify: true,
      icon: '/icons/icon-192.png',
      data: { url: location.pathname },
    };
    try {
      const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
      if (reg) await reg.showNotification(title, opts);
      else new Notification(title, opts);
    } catch (_) {}
  }

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !unread) return;
    unread = 0;
    document.title = baseTitle;
    if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
    try {
      const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
      if (reg) (await reg.getNotifications({ tag: 'halwa-' + urlCode })).forEach(n => n.close());
    } catch (_) {}
  });

  /* Asked once per device, and only once there is someone to hear from. */
  let notifyAsked = false;
  function maybeAskNotify() {
    if (notifyAsked) return;
    notifyAsked = true;
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    try {
      if (localStorage.getItem('halwa-notify-asked')) return;
      localStorage.setItem('halwa-notify-asked', '1');
    } catch (_) { return; }

    const bar = document.createElement('div');
    bar.className = 'share-confirm notify-ask';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Notifications');
    const title = document.createElement('p');
    title.className = 'share-confirm-title';
    title.textContent = '🔔 Get a notification when a file or message arrives while HalwaShare is in the background?';
    const actions = document.createElement('div');
    actions.className = 'share-confirm-actions';
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn btn-ghost btn-sm';
    no.textContent = 'Not now';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'btn btn-primary btn-sm';
    yes.textContent = 'Turn on';
    actions.append(no, yes);
    bar.append(title, actions);
    document.querySelector('.composer').before(bar);

    no.addEventListener('click', () => bar.remove());
    yes.addEventListener('click', async () => {
      bar.remove();
      try {
        const result = await Notification.requestPermission();
        toast(result === 'granted' ? 'Notifications on' : 'Notifications stay off — you can allow them in your browser settings');
      } catch (_) {}
    });
  }

  /* ── Safety code ─────────────────────────────────────────────
     The direct link is encrypted with keys whose fingerprints travel
     through the server. A server that swapped them could sit in the
     middle unseen — except that both people would then see different
     pictures here. Same pictures on both screens: nobody is in between. */
  const SAFETY_EMOJI = [
    '🍎','🍌','🍇','🍓','🍒','🍍','🥕','🌽','🍄','🌵','🌻','🌲','🍁','🌙','⭐','🔥',
    '🌈','❄️','⚡','💧','🐶','🐱','🐭','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷',
    '🐸','🐵','🐔','🐧','🐦','🦆','🦉','🐝','🦋','🐌','🐢','🐙','🐬','🐳','🦀','🐘',
    '🚗','🚲','✈️','🚀','⛵','🏠','⏰','🎈','🎁','📚','✏️','🔑','🔔','🎸','⚽','🎲',
  ];

  async function safetyCode(peer) {
    try {
      const pc = peer.pc;
      if (!pc || !crypto.subtle) return null;
      // The certificates DTLS actually used, as the browser reports them —
      // never the SDP text, which the server relays and could pad with a
      // second fingerprint that the browser would accept but we would not show.
      const stats = await pc.getStats();
      let a = null, b = null;
      stats.forEach((r) => {
        if (a || r.type !== 'transport' || r.dtlsState !== 'connected') return;
        const l = r.localCertificateId && stats.get(r.localCertificateId);
        const m = r.remoteCertificateId && stats.get(r.remoteCertificateId);
        if (!l || !m || !l.fingerprint || !m.fingerprint) return;
        a = String(l.fingerprintAlgorithm).toLowerCase() + ' ' + String(l.fingerprint).toUpperCase();
        b = String(m.fingerprintAlgorithm).toLowerCase() + ' ' + String(m.fingerprint).toUpperCase();
      });
      if (!a || !b) return null;   // e.g. Firefox, which does not report them
      const digest = await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode('halwashare-safety-v1|' + [a, b].sort().join('|')));
      // 12 pictures × 6 bits = 72 bits. A server in the middle picks keys for
      // both sides, so it only needs a collision — about 2^36 key generations,
      // far more than it can do while a connection is being set up.
      const h = new Uint8Array(digest);
      const bits = [...h.slice(0, 9)].map(x => x.toString(2).padStart(8, '0')).join('');
      const pics = [];
      for (let i = 0; i < 12; i++) pics.push(SAFETY_EMOJI[parseInt(bits.slice(i * 6, i * 6 + 6), 2)]);
      return [pics.slice(0, 4), pics.slice(4, 8), pics.slice(8)].map(r => r.join(' ')).join('\n');
    } catch (_) { return null; }
  }

  function showSafety(id) {
    const user = roomUsers.find(u => u.id === id);
    const peer = peers.get(id);
    if (!user) return;
    const name = user.label;
    const sheet = document.createElement('div');
    sheet.className = 'lightbox safety-sheet';
    const card = document.createElement('div');
    card.className = 'safety-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Safety code with ' + name);

    const h = document.createElement('h3');
    h.textContent = 'Safety code with ' + name;
    const code = document.createElement('div');
    code.className = 'safety-code';
    const p = document.createElement('p');
    p.className = 'safety-text';

    if (peer && peer.safety && peer.linkAlive()) {
      code.textContent = peer.safety;
      p.textContent = 'Check that ' + name + "'s screen shows the same twelve pictures, in the same order. " +
        'If they match, your direct link goes straight to them and nobody can listen in.';
    } else {
      code.textContent = '—';
      p.textContent = user.away
        ? name + ' is reconnecting. The code appears once you are linked directly again.'
        : peer && peer.linkAlive()
        ? 'You are linked directly to ' + name + ', but this browser cannot show a safety code for it. Try Chrome, Edge or Safari.'
        : 'No direct link to ' + name + ' right now, so there is no code to compare. ' +
          'Files go through the HalwaShare server instead, which passes them on without keeping them.';
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn-primary btn-sm';
    close.textContent = 'Done';
    const actions = document.createElement('div');
    actions.className = 'safety-actions';
    if (peer && !user.away && (peer.mode === 'p2p' || peer.mode === 'relay')) {
      const remember = document.createElement('button');
      remember.type = 'button';
      remember.className = 'btn btn-secondary btn-sm';
      remember.textContent = '📌 Remember this device';
      remember.title = 'Next time, connect to ' + name + ' with one tap from the start page — no code';
      remember.addEventListener('click', () => { requestPair(peer); done(); });
      actions.appendChild(remember);
    }
    actions.appendChild(close);
    card.append(h, code, p, actions);
    sheet.appendChild(card);
    document.body.appendChild(sheet);
    close.focus();

    const done = () => { sheet.remove(); document.removeEventListener('keydown', esc); };
    const esc = (e) => { if (e.key === 'Escape') done(); };
    document.addEventListener('keydown', esc);
    close.addEventListener('click', done);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) done(); });
  }

  /* ── Voice notes ─────────────────────────────────────────────
     Recorded here, then offered like any other file. They are small,
     so they arrive on their own and play inline. */
  const btnMic = $('btn-mic');
  const recBar = $('rec-bar');
  const recTime = $('rec-time');
  const composerEl = document.querySelector('.composer');
  const VOICE_MAX_MS = 5 * 60 * 1000;
  let rec = null;

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder && window.isSecureContext) {
    btnMic.classList.remove('hidden');
  }
  btnMic.addEventListener('click', () => (rec ? stopRecording(false) : startRecording()));
  $('btn-rec-cancel').addEventListener('click', () => stopRecording(true));

  async function startRecording() {
    if (rec) return;
    rec = { pending: true };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      rec = null;
      return toast(err && err.name === 'NotAllowedError'
        ? 'Microphone blocked — allow it in your browser settings to record'
        : 'Could not use the microphone', 'error');
    }
    // MP4 plays everywhere, iPhones included; fall back to WebM elsewhere.
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
      .find(t => { try { return MediaRecorder.isTypeSupported(t); } catch (_) { return false; } });
    let recorder;
    try {
      recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    } catch (_) {
      stream.getTracks().forEach(t => t.stop());
      rec = null;
      return toast('This browser cannot record audio', 'error');
    }
    const r = rec = { recorder, stream, chunks: [], started: Date.now(), cancelled: false };
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
    recorder.onstop = () => finishRecording(r);
    recorder.start(1000);
    r.timer = setInterval(() => {
      const ms = Date.now() - r.started;
      if (ms >= VOICE_MAX_MS) return stopRecording(false);
      paintRecTime(ms);
    }, 250);
    paintRecTime(0);
    composerEl.classList.add('recording');
    recBar.classList.remove('hidden');
    btnMic.textContent = '⏹';
    btnMic.title = 'Stop and send';
  }

  function paintRecTime(ms) {
    const sec = Math.floor(ms / 1000);
    recTime.textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  function stopRecording(cancel) {
    const r = rec;
    if (!r || r.pending) return;
    rec = null;
    r.cancelled = cancel;
    r.stoppedAt = Date.now();
    clearInterval(r.timer);
    composerEl.classList.remove('recording');
    recBar.classList.add('hidden');
    btnMic.textContent = '🎙️';
    btnMic.title = 'Record a voice note';
    try { r.recorder.stop(); } catch (_) { finishRecording(r); }
    r.stream.getTracks().forEach(t => t.stop());
  }

  function finishRecording(r) {
    if (r.done) return;
    r.done = true;
    if (r.cancelled) return;
    if ((r.stoppedAt || Date.now()) - r.started < 700 || !r.chunks.length) {
      return toast('Too short — tap 🎙️, speak, then tap ⏹ to send');
    }
    const mime = (r.recorder.mimeType || r.chunks[0].type || 'audio/webm').split(';')[0];
    const ext = /mp4|aac|m4a/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm';
    const t = new Date(r.started);
    const pad = (n) => String(n).padStart(2, '0');
    const name = 'Voice note ' + pad(t.getHours()) + '.' + pad(t.getMinutes()) + '.' + pad(t.getSeconds()) + '.' + ext;
    offerFile(new File([new Blob(r.chunks, { type: mime })], name, { type: mime }));
  }

  // A page that is hidden mid-recording is about to be suspended: send
  // what was said rather than lose it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && rec && !rec.pending) stopRecording(false);
  });

  /* ── Remember a device ───────────────────────────────────────
     Both sides add half of the secret, so neither can choose it alone.
     The halves travel over the direct link when there is one. */
  const pairPending = new Map();   // peer id -> our half

  function requestPair(peer) {
    const part = randomPart();
    pairPending.set(peer.id, part);
    const d = getDevice();
    try {
      peer.sendCtrl({ t: 'pair-req', part, name: d.name, kind: d.kind, device: d.id });
      toast('Asked ' + peer.label + ' to remember this device…');
    } catch (_) {
      pairPending.delete(peer.id);
      toast('Could not reach ' + peer.label + ' — try again in a moment', 'error');
    }
  }

  function askPair(peer, msg) {
    const theirName = cleanDeviceName(msg.name) || peer.label;
    const bar = document.createElement('div');
    bar.className = 'share-confirm';
    bar.setAttribute('role', 'dialog');
    const title = document.createElement('p');
    title.className = 'share-confirm-title';
    title.textContent = '📌 ' + theirName + ' wants to remember this device, so you can connect with one tap next time, without a code. Only do this with your own devices or people you trust.';
    const actions = document.createElement('div');
    actions.className = 'share-confirm-actions';
    const no = document.createElement('button');
    no.type = 'button'; no.className = 'btn btn-ghost btn-sm'; no.textContent = 'Not now';
    const yes = document.createElement('button');
    yes.type = 'button'; yes.className = 'btn btn-primary btn-sm'; yes.textContent = 'Remember';
    actions.append(no, yes);
    bar.append(title, actions);
    document.querySelector('.composer').before(bar);
    no.addEventListener('click', () => {
      bar.remove();
      try { peer.sendCtrl({ t: 'pair-no' }); } catch (_) {}
    });
    yes.addEventListener('click', async () => {
      bar.remove();
      const part = randomPart();
      const token = await pairToken(msg.part, part);
      addPaired({
        token, name: theirName, kind: ['phone', 'tablet', 'laptop', 'desktop'].includes(msg.kind) ? msg.kind : 'laptop',
        device: typeof msg.device === 'string' ? msg.device.slice(0, 64) : null, at: Date.now(),
      });
      const d = getDevice();
      try { peer.sendCtrl({ t: 'pair-ok', part, name: d.name, kind: d.kind, device: d.id }); } catch (_) {}
      presence.hello();
      toast('Remembered ' + theirName + ' — it now shows on your start page');
    });
  }

  async function finishPair(peer, msg) {
    const mine = pairPending.get(peer.id);
    if (!mine || !PAIR_TOKEN_RE.test(msg.part)) return;
    pairPending.delete(peer.id);
    const theirName = cleanDeviceName(msg.name) || peer.label;
    addPaired({
      token: await pairToken(mine, msg.part), name: theirName,
      kind: ['phone', 'tablet', 'laptop', 'desktop'].includes(msg.kind) ? msg.kind : 'laptop',
      device: typeof msg.device === 'string' ? msg.device.slice(0, 64) : null, at: Date.now(),
    });
    presence.hello();
    toast('Remembered ' + theirName + ' — connect with one tap from the start page next time');
  }

  /* ── Nearby and remembered devices, from inside a room ─────── */
  const presence = startPresence(socket, { change: paintNearbyCount, invited: onInvitedInRoom, knock: onKnock });

  /* Someone not in a room asked to join this one: a nearby device, or a
     remembered one while others are here too. */
  function onKnock(k) {
    const bar = document.createElement('div');
    bar.className = 'share-confirm';
    bar.setAttribute('role', 'dialog');
    const title = document.createElement('p');
    title.className = 'share-confirm-title';
    title.textContent = kindIcon(k.kind) + ' ' + k.from + (k.paired ? ' (your remembered device)' : ' (on this Wi-Fi)') + ' wants to join this room.';
    const actions = document.createElement('div');
    actions.className = 'share-confirm-actions';
    const no = document.createElement('button');
    no.type = 'button'; no.className = 'btn btn-ghost btn-sm'; no.textContent = 'Not now';
    const yes = document.createElement('button');
    yes.type = 'button'; yes.className = 'btn btn-primary btn-sm'; yes.textContent = 'Let in';
    actions.append(no, yes);
    bar.append(title, actions);
    document.querySelector('.composer').before(bar);
    noteArrival(k.from + ' wants to join', 'Open HalwaShare to let them in');
    const answer = (ok) => { presence.answer(k.kid, ok); bar.remove(); clearTimeout(t); };
    no.addEventListener('click', () => answer(false));
    yes.addEventListener('click', () => answer(true));
    const t = setTimeout(() => bar.remove(), 2 * 60 * 1000);
  }
  const nearbyCount = $('nearby-count');

  function paintNearbyCount() {
    const { paired, nearby } = presence.list();
    const here = new Set(roomUsers.map(u => u.label));
    const n = paired.filter(d => d.online && !here.has(d.name)).length + nearby.filter(d => !here.has(d.name)).length;
    nearbyCount.textContent = n;
    nearbyCount.classList.toggle('hidden', n === 0);
    if (openDeviceSheet) openDeviceSheet.render();
  }

  let openDeviceSheet = null;
  $('btn-nearby').addEventListener('click', () => {
    const sheet = document.createElement('div');
    sheet.className = 'lightbox safety-sheet';
    const card = document.createElement('div');
    card.className = 'safety-card devices-sheet';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Invite a device');
    const h = document.createElement('h3');
    h.textContent = 'Invite a device into this room';
    const body = document.createElement('div');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn-primary btn-sm';
    close.textContent = 'Done';
    card.append(h, body, close);
    sheet.appendChild(card);
    document.body.appendChild(sheet);

    async function invite(dev, btn) {
      btn.disabled = true;
      btn.textContent = 'Inviting…';
      const res = await presence.invite(dev.paired ? { token: dev.token } : { to: dev.id }, urlCode);
      if (res.code) { btn.textContent = 'Invited ✓'; toast('Invite sent to ' + dev.name); }
      else { btn.disabled = false; btn.textContent = 'Invite'; toast(res.error || 'Could not invite', 'error'); }
    }

    const render = () => {
      const { paired, nearby } = presence.list();
      const here = new Set(roomUsers.map(u => u.label));
      const sec = (title, list, empty) => {
        const t = document.createElement('h4');
        t.className = 'devices-title';
        t.textContent = title;
        const ul = document.createElement('ul');
        ul.className = 'device-list';
        list.filter(d => !here.has(d.name)).forEach(d => ul.appendChild(deviceRow(d, 'Invite', invite)));
        const e = document.createElement('p');
        e.className = 'devices-empty';
        e.textContent = empty;
        return ul.children.length ? [t, ul] : [t, e];
      };
      body.replaceChildren(
        ...sec('Your devices', paired, 'None yet. Tap a person in the room and choose Remember this device. It works across different Wi-Fi networks, so next time no code is needed.'),
        ...sec('Nearby on this network', nearby, 'Nobody else nearby has HalwaShare open.'),
      );
    };
    render();
    openDeviceSheet = { render };
    const done = () => { sheet.remove(); openDeviceSheet = null; document.removeEventListener('keydown', esc); };
    const esc = (e) => { if (e.key === 'Escape') done(); };
    document.addEventListener('keydown', esc);
    close.addEventListener('click', done);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) done(); });
  });

  function onInvitedInRoom(inv) {
    if (inv.code === urlCode) return;
    const bar = document.createElement('div');
    bar.className = 'share-confirm';
    bar.setAttribute('role', 'dialog');
    const title = document.createElement('p');
    title.className = 'share-confirm-title';
    title.textContent = kindIcon(inv.kind) + ' ' + inv.from + ' wants to connect. Joining takes you to a new room.';
    const actions = document.createElement('div');
    actions.className = 'share-confirm-actions';
    const no = document.createElement('button');
    no.type = 'button'; no.className = 'btn btn-ghost btn-sm'; no.textContent = 'Not now';
    const yes = document.createElement('button');
    yes.type = 'button'; yes.className = 'btn btn-primary btn-sm'; yes.textContent = 'Join';
    actions.append(no, yes);
    bar.append(title, actions);
    document.querySelector('.composer').before(bar);
    noteArrival(inv.from + ' wants to connect', 'Open HalwaShare to join');
    no.addEventListener('click', () => bar.remove());
    yes.addEventListener('click', () => {
      socket.emit('room:leave');
      setTimeout(() => { window.location.href = '/join/' + inv.code; }, 150);
    });
    setTimeout(() => bar.remove(), 120000);
  }

  /* ── The 📎 menu ─────────────────────────────────────────────── */
  const btnAttach = $('btn-attach');
  const attachMenu = $('attach-menu');
  const folderInput = $('folder-input');
  const canFolder = 'webkitdirectory' in folderInput && window.matchMedia('(pointer: fine)').matches;
  const canClipboard = !!(window.isSecureContext && navigator.clipboard && (navigator.clipboard.read || navigator.clipboard.readText));
  // Phones cannot share their screen from a browser, even where the call exists.
  const canScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && window.matchMedia('(pointer: fine)').matches;
  attachMenu.querySelector('[data-act="folder"]').classList.toggle('hidden', !canFolder);
  attachMenu.querySelector('[data-act="clipboard"]').classList.toggle('hidden', !canClipboard);
  attachMenu.querySelector('[data-act="screen"]').classList.toggle('hidden', !canScreen);

  function setMenu(open) {
    attachMenu.classList.toggle('hidden', !open);
    btnAttach.setAttribute('aria-expanded', String(open));
  }
  btnAttach.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenu(attachMenu.classList.contains('hidden'));
  });
  document.addEventListener('click', (e) => {
    if (!attachMenu.classList.contains('hidden') && !attachMenu.contains(e.target)) setMenu(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
  attachMenu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-act]');
    if (!item) return;
    setMenu(false);
    const act = item.dataset.act;
    if (act === 'files') fileInput.click();
    else if (act === 'folder') folderInput.click();
    else if (act === 'clipboard') sendClipboard();
    else if (act === 'screen') startScreenShare();
  });

  /* ── Folders: one zip, built while it streams ─────────────── */
  const MAX_FOLDER_FILES = 20000;

  folderInput.addEventListener('change', () => {
    const files = [...folderInput.files];
    folderInput.value = '';
    if (!files.length) return toast('That folder is empty');
    const top = (files[0].webkitRelativePath || '').split('/')[0] || 'Folder';
    offerFolder(files.map(f => ({ file: f, path: f.webkitRelativePath || f.name })), top);
  });

  function offerFolder(entries, folderName) {
    if (!entries.length) return toast(folderName + ' is empty');
    if (entries.length > MAX_FOLDER_FILES) {
      return toast('That folder has more than ' + MAX_FOLDER_FILES + ' files. Zip it first and send the zip.', 'error');
    }
    const zip = window.HalwaZip.makeZip(entries, (cleanDeviceName(folderName) || 'Folder') + '.zip');
    offerFile(zip);
    toast('Folder ready — ' + entries.length + (entries.length === 1 ? ' file' : ' files') + ', arrives as a .zip');
  }

  async function offerDroppedFolder(dirEntry) {
    const out = [];
    async function walk(dir, prefix) {
      const reader = dir.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const en of batch) {
          if (out.length > MAX_FOLDER_FILES) return;
          if (en.isDirectory) await walk(en, prefix + en.name + '/');
          else if (en.isFile) out.push({ file: await new Promise((res, rej) => en.file(res, rej)), path: prefix + en.name });
        }
      }
    }
    try {
      await walk(dirEntry, dirEntry.name + '/');
    } catch (_) {
      return toast('Could not read the folder ' + dirEntry.name, 'error');
    }
    offerFolder(out, dirEntry.name);
  }

  /* ── Clipboard: send what you copied ─────────────────────── */
  async function sendClipboard() {
    try {
      if (navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const img = item.types.find(t => t.startsWith('image/'));
          if (img) {
            const blob = await item.getType(img);
            offerFile(new File([blob], 'Copied image.' + (img.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, ''), { type: img }));
            return;
          }
        }
        for (const item of items) {
          if (item.types.includes('text/plain')) {
            const text = await (await item.getType('text/plain')).text();
            return sendCopiedText(text);
          }
        }
        return toast('Nothing copied yet — copy some text or a picture first');
      }
      sendCopiedText(await navigator.clipboard.readText());
    } catch (_) {
      toast('Could not read what you copied — paste it into the message box instead');
      msgInput.focus();
    }
  }

  function sendCopiedText(text) {
    if (!text || !text.trim()) return toast('Nothing copied yet — copy some text or a picture first');
    if (sendChat(text)) toast('Sent what you copied — the others can tap Copy');
  }

  /* ── Screen sharing ────────────────────────────────────────────
     Its own WebRTC connection per viewer, so it never disturbs the file
     link. Needs a direct connection; there is no relay for video. */
  let screenStream = null;
  const screenLinks = new Map();   // viewer id -> RTCPeerConnection (we share)
  const watching = new Map();      // sharer id -> { pc, panel, pending } (we watch)
  const screenBar = $('screen-bar');
  $('btn-screen-stop').addEventListener('click', stopScreenShare);

  async function startScreenShare() {
    if (screenStream) return;
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: true });
    } catch (err) {
      screenStream = null;
      if (err && err.name !== 'NotAllowedError' && err.name !== 'AbortError') toast('Could not share your screen', 'error');
      return;
    }
    const video = screenStream.getVideoTracks()[0];
    if (video) {
      video.contentHint = 'detail';
      video.addEventListener('ended', stopScreenShare);
    }
    screenBar.classList.remove('hidden');
    const viewers = roomUsers.filter(u => u.id !== myId && !u.away);
    viewers.forEach(u => shareScreenTo(u.id));
    toast(viewers.length ? 'Sharing your screen with everyone here' : 'Sharing your screen — people who join will see it');
    syncWakeLock();
  }

  function stopScreenShare() {
    if (!screenStream) return;
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
    for (const [id, pc] of screenLinks) {
      try { pc.close(); } catch (_) {}
      try { socket.emit('rtc:signal', { to: id, payload: { type: 'scr-stop' } }); } catch (_) {}
    }
    screenLinks.clear();
    screenBar.classList.add('hidden');
  }

  async function shareScreenTo(id) {
    if (!screenStream || id === myId) return;
    await rtcConfigReady;
    const old = screenLinks.get(id);
    if (old) { try { old.close(); } catch (_) {} }
    const pc = new RTCPeerConnection(rtcConfig);
    screenLinks.set(id, pc);
    screenStream.getTracks().forEach(t => pc.addTrack(t, screenStream));
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('rtc:signal', { to: id, payload: { type: 'scr-ice', role: 's', candidate: e.candidate } });
    };
    try {
      await pc.setLocalDescription(await pc.createOffer());
      socket.emit('rtc:signal', { to: id, payload: { type: 'scr-offer', sdp: pc.localDescription.sdp } });
    } catch (err) {
      console.warn('[halwa] screen offer failed', err);
    }
  }

  function closeScreenFor(id) {
    const link = screenLinks.get(id);
    if (link) { try { link.close(); } catch (_) {} screenLinks.delete(id); }
    const w = watching.get(id);
    if (w) { try { w.pc.close(); } catch (_) {} w.panel.remove(); watching.delete(id); }
  }

  async function handleScreenSignal(from, payload) {
    try {
      if (payload.type === 'scr-offer') {
        await rtcConfigReady;
        closeScreenFor(from);
        const pc = new RTCPeerConnection(rtcConfig);
        const w = { pc, panel: screenPanel(from), pending: [] };
        watching.set(from, w);
        pc.ontrack = (e) => {
          const v = w.panel.querySelector('video');
          if (v.srcObject !== e.streams[0]) v.srcObject = e.streams[0];
        };
        pc.onicecandidate = (e) => {
          if (e.candidate) socket.emit('rtc:signal', { to: from, payload: { type: 'scr-ice', role: 'v', candidate: e.candidate } });
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed') {
            w.panel.querySelector('.screen-note').textContent = 'Could not connect directly to show this screen. Try the same Wi-Fi.';
          }
        };
        await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        socket.emit('rtc:signal', { to: from, payload: { type: 'scr-answer', sdp: pc.localDescription.sdp } });
        for (const c of w.pending.splice(0)) { try { await pc.addIceCandidate(c); } catch (_) {} }
      } else if (payload.type === 'scr-answer') {
        const pc = screenLinks.get(from);
        if (pc && pc.signalingState === 'have-local-offer') await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
      } else if (payload.type === 'scr-ice') {
        // 's' came from a sharer, for our viewing side; 'v' from a viewer.
        const pc = payload.role === 's' ? (watching.get(from) || {}).pc : screenLinks.get(from);
        if (!pc) return;
        if (pc.remoteDescription) { try { await pc.addIceCandidate(payload.candidate); } catch (_) {} }
        else if (payload.role === 's' && watching.get(from)) watching.get(from).pending.push(payload.candidate);
      } else if (payload.type === 'scr-stop') {
        const w = watching.get(from);
        if (w) { try { w.pc.close(); } catch (_) {} w.panel.remove(); watching.delete(from); }
      }
    } catch (err) {
      console.warn('[halwa] screen signalling error', err);
    }
  }

  function screenPanel(from) {
    const user = roomUsers.find(u => u.id === from);
    const panel = document.createElement('div');
    panel.className = 'screen-panel';
    const head = document.createElement('div');
    head.className = 'screen-head';
    const title = document.createElement('span');
    title.textContent = '🖥️ ' + (user ? user.label : 'Someone') + "'s screen";
    const sound = document.createElement('button');
    sound.type = 'button'; sound.className = 'icon-btn'; sound.textContent = '🔇'; sound.title = 'Turn sound on';
    const full = document.createElement('button');
    full.type = 'button'; full.className = 'icon-btn'; full.textContent = '⛶'; full.title = 'Full screen';
    const small = document.createElement('button');
    small.type = 'button'; small.className = 'icon-btn'; small.textContent = '–'; small.title = 'Make smaller';
    head.append(title, sound, full, small);
    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true; video.muted = true;
    const note = document.createElement('p');
    note.className = 'screen-note';
    panel.append(head, video, note);
    document.querySelector('.chat-area').appendChild(panel);
    sound.addEventListener('click', () => {
      video.muted = !video.muted;
      sound.textContent = video.muted ? '🔇' : '🔊';
      sound.title = video.muted ? 'Turn sound on' : 'Mute';
    });
    full.addEventListener('click', () => {
      const el = video;
      if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
      else if (el.webkitEnterFullscreen) el.webkitEnterFullscreen();
    });
    small.addEventListener('click', () => panel.classList.toggle('mini'));
    return panel;
  }

  /* ── From the browser extension ──────────────────────────────── */
  const extQueue = [];
  onExtensionItem((item) => {
    if (!joined) { extQueue.push(item); return; }
    takeExtItem(item);
  });
  function takeExtItem({ text, files }) {
    if (text) { msgInput.value = text; msgInput.focus(); }
    if (files.length) confirmShared(files);
  }
  const extTimer = setInterval(() => {
    if (!joined) return;
    clearInterval(extTimer);
    extQueue.splice(0).forEach(takeExtItem);
  }, 300);

  /* ── Install on this device ──────────────────────────────────── */
  const btnInstallRoom = $('btn-install-room');
  let installPromptRoom = null;
  if (!isStandalone()) {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installPromptRoom = e;
      btnInstallRoom.classList.remove('hidden');
    });
  }
  btnInstallRoom.addEventListener('click', async () => {
    if (!installPromptRoom) return;
    installPromptRoom.prompt();
    await installPromptRoom.userChoice.catch(() => {});
    installPromptRoom = null;
    btnInstallRoom.classList.add('hidden');
  });

  window.addEventListener('beforeunload', (e) => {
    const busy = isTransferring();
    if (busy) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
    objectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
    peers.forEach(p => p.close());
    if (screenStream) stopScreenShare();
  });
}
