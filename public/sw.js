/* ── HalwaShare streaming-download service worker ──────────
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

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

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
