/* ── Streaming zip ──────────────────────────────────────────
   Turns a folder's files into one .zip that behaves like a File:
   it has a name, a size known up front, and slice(start, end) that
   reads just those bytes. The transfer code reads it exactly like
   any picked file, so a 50 GB folder never sits in memory and an
   interrupted send resumes from any byte.

   Entries are stored, not compressed: the size is then known before
   a single byte is read, and photos and videos barely compress anyway.
   Each file's CRC is unknown until its bytes have gone by, so it goes
   in a data descriptor after the data, and in the central directory
   at the end. ZIP64 records appear only when something needs them. */

'use strict';

(function (root) {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crcUpdate(crc, bytes) {
    let c = crc ^ 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const MAX32 = 0xFFFFFFFF;
  const MAX16 = 0xFFFF;
  const enc = new TextEncoder();

  function put64(view, at, n) {
    view.setUint32(at, n % 0x100000000, true);
    view.setUint32(at + 4, Math.floor(n / 0x100000000), true);
  }

  function dosTime(ms) {
    const d = new Date(ms || Date.now());
    const year = Math.max(1980, Math.min(2107, d.getFullYear()));
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  /* Paths inside the zip: forward slashes, no leading slash, no "..". */
  function cleanPath(p) {
    return String(p || 'file').replace(/\\/g, '/').split('/')
      .filter(seg => seg && seg !== '.' && seg !== '..').join('/') || 'file';
  }

  /* entries: [{ file, path }] */
  function makeZip(entries, zipName) {
    const items = [];
    const seen = new Set();
    let off = 0;
    for (const e of entries) {
      let path = cleanPath(e.path || e.file.name);
      // Two files may not share a name inside a zip.
      if (seen.has(path)) {
        const dot = path.lastIndexOf('.');
        const base = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path;
        const ext = dot > path.lastIndexOf('/') ? path.slice(dot) : '';
        let i = 2;
        while (seen.has(base + ' (' + i + ')' + ext)) i++;
        path = base + ' (' + i + ')' + ext;
      }
      seen.add(path);
      const name = enc.encode(path);
      const size = e.file.size;
      const big = size >= MAX32;
      const it = {
        file: e.file, name, size, big, ...dosTime(e.file.lastModified),
        offset: off,
        headerLen: 30 + name.length + (big ? 20 : 0),
        descLen: big ? 24 : 16,
        crc: 0, crcPos: 0,                 // CRC of the first crcPos bytes
      };
      it.dataStart = off + it.headerLen;
      it.end = it.dataStart + size + it.descLen;
      off = it.end;
      items.push(it);
    }

    const cdStart = off;
    let cdSize = 0;
    for (const it of items) {
      it.cdFields = (it.big ? 2 : 0) + (it.offset >= MAX32 ? 1 : 0);
      it.cdLen = 46 + it.name.length + (it.cdFields ? 4 + 8 * it.cdFields : 0);
      cdSize += it.cdLen;
    }
    const zip64 = items.length >= MAX16 || cdStart >= MAX32 || cdSize >= MAX32 ||
      cdStart + cdSize >= MAX32 || items.some(it => it.cdFields);
    const endLen = (zip64 ? 56 + 20 : 0) + 22;
    const total = cdStart + cdSize + endLen;

    /* Feed bytes of entry `it` that start `at` bytes into it. Only bytes
       that continue exactly where the CRC stopped count; anything else has
       been counted already (a resend) or will be (a read-ahead). */
    function feedCrc(it, at, bytes) {
      if (at > it.crcPos || at + bytes.length <= it.crcPos) return;
      it.crc = crcUpdate(it.crc, bytes.subarray(it.crcPos - at));
      it.crcPos = at + bytes.length;
    }

    /* The whole CRC. Normally already done by the time anything needs it;
       otherwise read the rest of the file to finish it. */
    async function crcOf(it) {
      while (it.crcPos < it.size) {
        // crcPos may move while we wait (another read feeding the same
        // file), so remember where this slice started.
        const from = it.crcPos;
        const end = Math.min(it.size, from + 4 * 1024 * 1024);
        const buf = new Uint8Array(await it.file.slice(from, end).arrayBuffer());
        feedCrc(it, from, buf);
      }
      return it.crc;
    }

    function localHeader(it) {
      const b = new Uint8Array(it.headerLen);
      const v = new DataView(b.buffer);
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, it.big ? 45 : 20, true);
      v.setUint16(6, 0x0808, true);            // data descriptor follows; UTF-8 names
      v.setUint16(8, 0, true);                 // stored
      v.setUint16(10, it.time, true);
      v.setUint16(12, it.date, true);
      // CRC and sizes are in the descriptor.
      v.setUint32(14, 0, true);
      v.setUint32(18, it.big ? MAX32 : 0, true);
      v.setUint32(22, it.big ? MAX32 : 0, true);
      v.setUint16(26, it.name.length, true);
      v.setUint16(28, it.big ? 20 : 0, true);
      b.set(it.name, 30);
      if (it.big) {
        const x = 30 + it.name.length;
        v.setUint16(x, 0x0001, true);
        v.setUint16(x + 2, 16, true);
        // sizes 0 here too, as the descriptor carries them
      }
      return b;
    }

    async function descriptor(it) {
      const crc = await crcOf(it);
      const b = new Uint8Array(it.descLen);
      const v = new DataView(b.buffer);
      v.setUint32(0, 0x08074b50, true);
      v.setUint32(4, crc, true);
      if (it.big) { put64(v, 8, it.size); put64(v, 16, it.size); }
      else { v.setUint32(8, it.size, true); v.setUint32(12, it.size, true); }
      return b;
    }

    async function centralDirectory() {
      const b = new Uint8Array(cdSize);
      const v = new DataView(b.buffer);
      let p = 0;
      for (const it of items) {
        const crc = await crcOf(it);
        v.setUint32(p, 0x02014b50, true);
        v.setUint16(p + 4, 45, true);
        v.setUint16(p + 6, it.big || it.cdFields ? 45 : 20, true);
        v.setUint16(p + 8, 0x0808, true);
        v.setUint16(p + 10, 0, true);
        v.setUint16(p + 12, it.time, true);
        v.setUint16(p + 14, it.date, true);
        v.setUint32(p + 16, crc, true);
        v.setUint32(p + 20, it.big ? MAX32 : it.size, true);
        v.setUint32(p + 24, it.big ? MAX32 : it.size, true);
        v.setUint16(p + 28, it.name.length, true);
        v.setUint16(p + 30, it.cdFields ? 4 + 8 * it.cdFields : 0, true);
        v.setUint16(p + 32, 0, true);
        v.setUint16(p + 34, 0, true);
        v.setUint16(p + 36, 0, true);
        v.setUint32(p + 38, 0, true);
        v.setUint32(p + 42, it.offset >= MAX32 ? MAX32 : it.offset, true);
        b.set(it.name, p + 46);
        let x = p + 46 + it.name.length;
        if (it.cdFields) {
          v.setUint16(x, 0x0001, true);
          v.setUint16(x + 2, 8 * it.cdFields, true);
          x += 4;
          if (it.big) { put64(v, x, it.size); put64(v, x + 8, it.size); x += 16; }
          if (it.offset >= MAX32) { put64(v, x, it.offset); x += 8; }
        }
        p += it.cdLen;
      }
      return b;
    }

    function endRecords() {
      const b = new Uint8Array(endLen);
      const v = new DataView(b.buffer);
      let p = 0;
      if (zip64) {
        const rec = cdStart + cdSize;
        v.setUint32(0, 0x06064b50, true);
        put64(v, 4, 44);
        v.setUint16(12, 45, true);
        v.setUint16(14, 45, true);
        v.setUint32(16, 0, true);
        v.setUint32(20, 0, true);
        put64(v, 24, items.length);
        put64(v, 32, items.length);
        put64(v, 40, cdSize);
        put64(v, 48, cdStart);
        v.setUint32(56, 0x07064b50, true);
        v.setUint32(60, 0, true);
        put64(v, 64, rec);
        v.setUint32(72, 1, true);
        p = 76;
      }
      v.setUint32(p, 0x06054b50, true);
      v.setUint16(p + 8, zip64 ? MAX16 : items.length, true);
      v.setUint16(p + 10, zip64 ? MAX16 : items.length, true);
      v.setUint32(p + 12, zip64 ? MAX32 : cdSize, true);
      v.setUint32(p + 16, zip64 ? MAX32 : cdStart, true);
      return b;
    }

    let cdCache = null;

    /* Bytes [start, end) of the whole zip. */
    async function read(start, end) {
      end = Math.min(end, total);
      const out = new Uint8Array(Math.max(0, end - start));
      let pos = start;

      // First entry that reaches past `start`.
      let lo = 0, hi = items.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (items[mid].end <= start) lo = mid + 1; else hi = mid; }

      for (let i = lo; i < items.length && pos < end; i++) {
        const it = items[i];
        // header
        if (pos < it.dataStart) {
          const h = localHeader(it);
          const a = pos - it.offset, z = Math.min(it.headerLen, end - it.offset);
          out.set(h.subarray(a, z), pos - start);
          pos = it.offset + z;
        }
        // data
        if (pos < end && pos < it.dataStart + it.size) {
          const a = pos - it.dataStart, z = Math.min(it.size, end - it.dataStart);
          const bytes = new Uint8Array(await it.file.slice(a, z).arrayBuffer());
          if (bytes.length !== z - a) throw new Error('A file in the folder changed or could not be read: ' + it.file.name);
          feedCrc(it, a, bytes);
          out.set(bytes, pos - start);
          pos = it.dataStart + z;
        }
        // descriptor
        if (pos < end && pos < it.end) {
          const d = await descriptor(it);
          const base = it.dataStart + it.size;
          const a = pos - base, z = Math.min(it.descLen, end - base);
          out.set(d.subarray(a, z), pos - start);
          pos = base + z;
        }
      }
      if (pos < end && pos < cdStart + cdSize) {
        cdCache = cdCache || await centralDirectory();
        const a = pos - cdStart, z = Math.min(cdSize, end - cdStart);
        out.set(cdCache.subarray(a, z), pos - start);
        pos = cdStart + z;
      }
      if (pos < end) {
        const e = endRecords();
        const base = cdStart + cdSize;
        out.set(e.subarray(pos - base, end - base), pos - start);
        pos = end;
      }
      return out;
    }

    return {
      name: zipName,
      size: total,
      type: 'application/zip',
      lastModified: Date.now(),
      count: items.length,
      slice(start, end) {
        const s = Math.max(0, start || 0);
        const e = end === undefined ? total : Math.min(total, end);
        return { arrayBuffer: () => read(s, e).then(u => u.buffer) };
      },
    };
  }

  root.HalwaZip = { makeZip, crcUpdate };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.HalwaZip;
})(typeof window !== 'undefined' ? window : globalThis);
