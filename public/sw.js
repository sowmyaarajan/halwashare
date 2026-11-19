/* ── HalwaShare service worker ─────────────────────────────
   Two jobs: streaming downloads (below) and the share target.

   Streaming downloads ──
   Lets a browser without the File System Access API write an
   incoming file straight to disk instead of holding it in RAM.

   The page opens /__dl/<id>; we answer that navigation with a
   ReadableStream and an attachment header, then feed the stream
   from chunks the page posts over a MessagePort. Memory use stays
   flat no matter how big the file is. */

const streams = new Map(); // id -> { stream, name, size }

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'init') return;

  const port = event.ports[0];
  if (!port) return;

  let controller = null;
  let closed = false;

  const stream = new ReadableStream({
    start(c) { controller = c; },
    cancel() {
      closed = true;
      streams.delete(data.id);
      try { port.postMessage({ type: 'cancelled' }); } catch (_) {}
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 24 * 1024 * 1024 }));

  port.onmessage = (ev) => {
    const m = ev.data;
    if (!m || closed) return;

    if (m.type === 'chunk') {
      try {
        controller.enqueue(new Uint8Array(m.buf, m.offset || 0));
      } catch (_) {
        closed = true;
        return;
      }
      // Report remaining room so the page can throttle if the disk
      // is slower than the network.
      const desired = controller.desiredSize;
      try { port.postMessage({ type: 'ack', desired: typeof desired === 'number' ? desired : 1 }); } catch (_) {}

    } else if (m.type === 'end') {
      closed = true;
      try { controller.close(); } catch (_) {}
      streams.delete(data.id);

    } else if (m.type === 'abort') {
      closed = true;
      try { controller.error(new Error('Transfer aborted')); } catch (_) {}
      streams.delete(data.id);
    }
  };

  streams.set(data.id, { stream, name: data.name, size: data.size });

  // Drop the reservation if the page never triggers the download.
  setTimeout(() => {
    const entry = streams.get(data.id);
    if (entry && entry.stream === stream && !entry.claimed) streams.delete(data.id);
  }, 60000);

  try { port.postMessage({ type: 'ready' }); } catch (_) {}
});

/* ── Share target ───────────────────────────────────────────
   The installed app appears in the phone's Share menu. Shared files
   arrive here as a form POST; we park them in Cache Storage (on disk,
   so a 2 GB video does not sit in memory) and open the app, which
   offers them as soon as the person enters a room. */
const SHARE_CACHE = 'halwa-shared';

/* Any website can auto-submit a hidden form here and try to plant a file
   for the person to share later. A real share comes from the operating
   system with no referrer; a form on another site carries that site's,
   unless it hides it. So this only stops the careless attacker — the page
   also refuses shares outside the installed app, and the room always asks
   before sending. */
function isGenuineShare(request) {
  if (!request.referrer) return true;
  try { return new URL(request.referrer).origin === self.location.origin; } catch (_) { return false; }
}

async function receiveShare(request) {
  if (!isGenuineShare(request)) return Response.redirect('/', 303);
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter(f => f && typeof f === 'object' && 'name' in f);
    const text = [form.get('title'), form.get('text'), form.get('url')]
      .filter(v => typeof v === 'string' && v.trim())
      .filter((v, i, all) => all.indexOf(v) === i)
      .join('\n');

    await caches.delete(SHARE_CACHE);
    const cache = await caches.open(SHARE_CACHE);
    const names = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      names.push({ name: f.name || 'file', type: f.type || '', size: f.size || 0 });
      await cache.put('/__shared/' + i, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }));
    }
    await cache.put('/__shared/index', new Response(JSON.stringify({ files: names, text, at: Date.now() }), {
      headers: { 'Content-Type': 'application/json' },
    }));
  } catch (_) { /* fall through: the app opens without the files */ }
  return Response.redirect('/?shared=1', 303);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(receiveShare(event.request));
    return;
  }

  const match = url.pathname.match(/^\/__dl\/([A-Za-z0-9_-]+)$/);
  if (!match) return;

  const entry = streams.get(match[1]);
  if (!entry) {
    event.respondWith(new Response('Transfer expired', { status: 410 }));
    return;
  }
  entry.claimed = true;

  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition':
      "attachment; filename*=UTF-8''" + encodeURIComponent(entry.name),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  // A known length gives the browser a real progress bar in its own UI.
  if (entry.size > 0) headers['Content-Length'] = String(entry.size);

  event.respondWith(new Response(entry.stream, { headers }));
});

/* ── Notifications ──────────────────────────────────────────
   Tapping one brings the room back to the front, or reopens it. */
/* A remembered device rang this one while HalwaShare was closed. The
   message was encrypted for this device alone, and signed with the
   pairing token: only a ring from a pairing this device still holds
   shows a name and opens a room. Anything else is shown plainly (every
   push must show something). Three such rings within a day retire this
   push address, so a device that was forgotten cannot keep ringing; a
   genuine ring in between does not wipe the count. Remembered devices
   get the new address the next time they meet in a room. */
const RING_FAILS_TO_RETIRE = 3;
const RING_FAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* { ring } when verified, otherwise { bad: true } — including when the
   list of pairings cannot be read: a ring that cannot be checked is not
   trusted. (The page rewrites the list every time it opens.) */
async function checkRing(d) {
  if (!d || d.t !== 'ring' || typeof d.code !== 'string' || !/^\d{6}$/.test(d.code) || typeof d.mac !== 'string') {
    return { bad: true };
  }
  let list;
  try {
    const res = await (await caches.open('halwa-paired')).match('/__paired');
    if (!res) return { bad: true };
    list = await res.json();
  } catch (_) { return { bad: true }; }
  if (!Array.isArray(list)) return { bad: true };
  const enc = new TextEncoder();
  for (const p of list) {
    if (!p || typeof p.token !== 'string') continue;
    const key = await crypto.subtle.importKey('raw', enc.encode(p.token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = b64url(await crypto.subtle.sign('HMAC', key, enc.encode('halwa-ring-v1|' + d.code)));
    if (mac === d.mac) return { ring: { name: String(p.name || 'A remembered device').slice(0, 40), code: d.code } };
  }
  return { bad: true };
}

async function countRingFailure() {
  try {
    const cache = await caches.open('halwa-paired');
    const res = await cache.match('/__ring-fails');
    let times = [];
    try { times = res ? await res.json() : []; } catch (_) { times = []; }
    const now = Date.now();
    times = (Array.isArray(times) ? times : []).filter(t => typeof t === 'number' && now - t < RING_FAIL_WINDOW_MS);
    times.push(now);
    if (times.length >= RING_FAILS_TO_RETIRE) {
      await cache.delete('/__ring-fails');
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } else {
      await cache.put('/__ring-fails', new Response(JSON.stringify(times.slice(-10))));
    }
  } catch (_) {}
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let d = null;
    try { d = event.data && event.data.json(); } catch (_) {}
    const { ring } = await checkRing(d);
    if (ring) {
      return self.registration.showNotification(ring.name + ' wants to connect', {
        body: 'Tap to join them on HalwaShare',
        tag: 'halwa-ring',
        renotify: true,
        requireInteraction: true,
        icon: '/icons/icon-192.png',
        data: { url: '/join/' + ring.code },
      });
    }
    await countRingFailure();
    return self.registration.showNotification('HalwaShare', {
      body: 'Ignored a ring from a device this one does not remember.',
      tag: 'halwa-ring-ignored',
      icon: '/icons/icon-192.png',
      data: { url: '/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || '/';
  const target = /^\/join\/\d+$/.test(path) ? path : '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find(c => new URL(c.url).pathname === target);
    if (open) return open.focus();
    return self.clients.openWindow(target);
  })());
});
