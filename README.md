# 🍮 HalwaShare

Send files of any size — and text — straight to the people around you. Nothing is
uploaded, nothing is stored: the bytes travel device to device.

```
npm install
npm start
```

Open the printed **Network** URL on any device on the same Wi-Fi, or scan the QR
code in the room sidebar.

## In a room

- **Files of any size**: offered instantly, streamed when someone saves them, resumed if the connection drops.
- **Whole folders** (📎 → Folder, or drag one in, on a computer): they arrive as one .zip, built while it streams, so even a huge folder never sits in memory.
- **What I copied** (📎): sends the text or picture on your clipboard; the others tap Copy.
- **Share my screen** (📎, on a computer): everyone in the room watches live, over a direct link.
- **Chat**, with read receipts, a typing indicator and pasted screenshots.
- **Voice notes**: tap 🎙️, speak, tap ⏹. They arrive on their own and play inline.
- **Safety code**: tap a person to see twelve pictures. If their screen shows the same twelve, your direct link goes straight to them, with nobody in between.
- **Screen stays on** while others are in the room, so a phone does not sleep and drop out (☕ turns this off).
- **Background alerts**: a count in the tab title and on the app icon, plus a notification if you allow it, when something arrives while HalwaShare is not on screen.

## No code needed

- **Nearby**: other devices with HalwaShare open on the same network (the same public address) show on the start page and under 📡 in a room. Tap *Connect* and they are asked to join.
- **Your devices**: in a room, tap a person and choose *Remember this device*. From then on it appears on the start page whenever it is online, and *Connect* takes both straight into a new room, no questions asked. *✕* forgets it on both sides.

Each device has a name (shown in rooms instead of "User 2"), which *Rename* on the start page changes.
On a shared network — an office, a café — everyone with HalwaShare open sees that name. *Hide me from nearby* on the start page takes the device off the list (and hides the list from it); remembered devices still find it.
A remembered pair shares a random token made of a half from each side; the server only matches tokens and never learns which devices are behind them.

## Browser extension

`extension/` is a Chrome / Edge extension:

- the toolbar button opens HalwaShare, or brings its tab to the front;
- right-click any picture, link, selected text or page and choose **Send to HalwaShare**. The page always asks before anything is sent.

To install it before it is in the Chrome Web Store: open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked** and pick the `extension` folder.

## Install it as an app

HalwaShare is an installable web app, so it can live on the home screen
instead of behind a link. It needs the HTTPS deployment.

| Device | How |
|---|---|
| Android | Open the site in Chrome and tap **Install app** (or ⋮ → *Install app*) |
| iPhone / iPad | Open the site in Safari, tap **Share** → **Add to Home Screen** |
| Windows / Mac | Chrome or Edge: the install icon in the address bar, the *Install HalwaShare* button on the start page, or 📲 in a room. It then opens in its own window from the Start menu, taskbar or dock |

Once installed on Android, HalwaShare also appears in the **Share** menu:
share photos from the gallery, enter a room, and HalwaShare lists them and
asks before sending. Shares are only accepted inside the installed app, so a
website cannot plant files for you to send. iPhone does not let web apps join its Share menu; use 📎 instead, and
keep the app open while a transfer runs, as iOS pauses it in the background.

## How it works

Picking a file **offers** it. Only the name and size are published, so sharing a
20 GB file is instant. The bytes move when someone presses *Save*, streaming from
the sender's disk, over the wire, to the receiver's disk — never fully held in
memory on either side.

```
sender                                            receiver
  file.slice() ─► 256 KB chunk ─► DataChannel ─► sink ─► disk
                      ▲                                  ▲
            pipelined read                   FS Access API, or a
            + SCTP backpressure              service-worker stream
```

Small images (≤ 5 MB) are fetched automatically so pictures just appear inline,
like a chat. Everything else waits for a click.

### Transports

| Mode | When | Shown as |
|---|---|---|
| WebRTC DataChannel | normal case; encrypted, direct | `DIRECT` |
| Server relay | WebRTC cannot connect — client-isolated Wi-Fi, blocked UDP | `RELAY` |

A peer that has not negotiated WebRTC within 10 seconds switches to the relay
automatically, so a transfer never silently dies. The relay forwards frames
without buffering the file, under a 4 MB credit window.

### Dropped connections and resume

Phones lose their connection all the time — the screen locks, the app goes to
the background, Wi-Fi hands over to mobile data. HalwaShare treats that as a
pause, not a departure:

- **Away, not gone.** A dropped person stays in the room as *reconnecting…*
  for `USER_GRACE_MS` (3 minutes), with the same name and the same files. When
  they come back nobody sees them leave and rejoin. *Leave* removes them at once.
- **Downloads resume.** A transfer sticks to the route it started on, so bytes
  can never arrive out of order. If it stalls or its route goes down, the
  receiver asks for the rest from the byte it stopped at, into the same file.
  While either phone is away it waits instead of failing.
- **Nothing sent mid-reconnect is lost.** Files picked and messages typed while
  offline are held until the room is rejoined, then sent. Messages that arrived
  meanwhile are filled in.
- **Waking up is fast.** When the page becomes visible again it checks its
  connection at once rather than waiting ~50 s to notice it died.

A refreshed page has lost its file handles, so files it offered go grey and
must be picked again.

## Size limits

To stream huge files to disk the browser needs a **secure context**:

| Situation | Behaviour |
|---|---|
| HTTPS, or `localhost` | Streaming — no size limit (sidebar reads *Streaming mode*) |
| Plain `http://192.168.x.x` | Buffered in RAM — keep files under ~1 GB (*Buffered mode*) |

So for genuinely huge files over a LAN, serve it over HTTPS. The included
`fly.toml` deploys with `force_https`; set `PUBLIC_URL` so the QR code points at
the public hostname:

```
fly deploy
fly secrets set PUBLIC_URL=https://halwashare.fly.dev
```

Chromium saves via the File System Access API (native save dialog). Firefox and
Safari use the service worker in `public/sw.js`, which answers `/__dl/<id>` with
a streamed attachment response.

## Deploying to Render

`render.yaml` is a Blueprint. Push the repo, then in Render pick
**New → Blueprint**, point it at the repo, and apply. Or create a **Web Service**
by hand with:

| Field | Value |
|---|---|
| Runtime | Node |
| Build command | `npm install` |
| Start command | `npm start` |
| Health check path | `/healthz` |
| Instances | **1** (see below) |

After the first deploy, set `PUBLIC_URL` to the URL Render gives you, so the
room QR code points at the public host rather than the container's private
address:

```
PUBLIC_URL=https://halwashare.onrender.com
```

Render terminates TLS for you, so every visitor gets a secure context and
therefore unlimited-size streaming. `PORT` is injected by Render and already
honoured; the server binds `0.0.0.0`.

Two things about the free plan specifically:

- It **sleeps after ~15 minutes idle**. The next visitor waits ~50 s for a cold
  start, and because rooms are held in memory, **a sleep or redeploy clears every
  open room**. Anyone mid-transfer is dropped. A paid instance avoids the sleep.
- Relayed bytes count against your bandwidth quota (100 GB/month on free). Direct
  P2P transfers do not touch Render at all — configure TURN below to keep it that
  way.

## Hosting notes

Hosting over HTTPS is the *better* case for huge files — every browser gets a
secure context, so nothing is capped by RAM. Two things still need attention.

**Give it TURN.** Once the two devices are not on the same Wi-Fi, plain STUN
cannot punch through every NAT. Set these and hard-NAT pairs still connect
directly:

```
fly secrets set TURN_URLS=turn:your-turn-host:3478 \
                TURN_USERNAME=user TURN_CREDENTIAL=secret
```

Without TURN those pairs fall back to the relay, which works but sends every
byte through your server — slow, and it bills you for the bandwidth. Fine for a
photo; a poor way to move 5 GB.

**Do not scale past one instance.** Rooms and peer lists live in the process
memory of a single server, so a second instance would put users in different
rooms with the same code. `fly.toml` pins `min_machines_running = 1` with
`auto_stop_machines = false`, and `render.yaml` leaves `numInstances` unset, for
exactly this reason. Scaling out means adding `@socket.io/redis-adapter` plus
sticky sessions first.

Also inherent to the design (ToffeeShare works the same way): the sender's tab
must stay open for the whole transfer. A phone suspends a web page as soon as
its screen turns off, so HalwaShare keeps the screen on instead: always while a
file is moving, and — unless the ☕ button in the header is switched off — the
whole time someone else is in the room. Switching to another app still pauses
it on phones, and leaving the page mid-transfer asks first.

## Security

HalwaShare has no accounts, so a room code is the only thing between a
stranger and a room. The server is built to be safe on the open internet:

| Threat | Defence |
|---|---|
| Guessing room codes | 6-digit random codes (900,000 possibilities); wrong guesses are limited to ~20 a minute per address (a whole IPv6 /64 counts as one), and reconnecting does not reset that. A site-wide cap of `GLOBAL_MISSES_PER_MIN` (default 300) stops guesses spread over many addresses; people already in a room get back in even while it is spent |
| Flooding the server with rooms | Room creation limited per IP, at most `MAX_ROOMS_PER_IP` open per address, `MAX_ROOMS` in total; empty rooms expire after 2 minutes |
| Malformed messages | Strict type checks, and every handler is guarded: a bad message drops that connection, never the server |
| Exhausting memory | Chat history capped at 128 KB per room; a receiver that stops reading is not buffered for |
| Floods of chat, signalling or relay bytes | Per-connection rate limits; relay bytes and messages are paced (never dropped), counted against a backlog cap, and a sender ignoring flow control is disconnected |
| Floods of pictures | Receivers auto-fetch only small images, up to 60 MB per visit; everything else waits for a click |
| Too many connections | `MAX_CONN_PER_IP` open sockets per address |
| Other websites driving a visitor's browser | Socket.io refuses connections whose `Origin` is not this site |
| Script injection | Strict Content-Security-Policy, no inline script; all user text is escaped |
| Tampering by someone in the room | Only a file's owner can withdraw it or answer for it; a receiver rejects more bytes than advertised, and incomplete files |

Behind a proxy the server needs the real client address for those limits.
On Render (Cloudflare's `CF-Connecting-IP`) and Fly (`Fly-Client-IP`) this is
automatic. Elsewhere set `TRUST_PROXY=1`, and only when a proxy really sits in
front, or clients could fake their address; if that proxy sets a client-IP
header it overwrites, name it in `CLIENT_IP_HEADER`.

Keep dependencies patched: `npm audit` should report 0 vulnerabilities.
Run `npm test` after changing the server.

## Layout

```
server.js         static hosting, signalling, chat, fallback relay, limits
public/app.js     peers, transports, sinks, transfer protocol, UI
public/sw.js      streaming downloads + share target
public/manifest.webmanifest, public/icons/   the installable app
public/style.css  light + dark theme
test/             server tests — npm test
```

Environment: `PORT` (default 4000), `MAX_USERS` (default 5), `PUBLIC_URL`,
`TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`, `MAX_ROOMS` (default 500),
`MAX_ROOMS_PER_IP` (default 10),
`MAX_CONN_PER_IP` (default 30), `ROOM_GRACE_MS` (default 120000),
`RELAY_BYTES_PER_SEC` (default 16 MB/s), `GLOBAL_MISSES_PER_MIN` (default 300),
`USER_GRACE_MS` (default 180000),
`TRUST_PROXY`, `CLIENT_IP_HEADER`.

## Protocol

Control messages are JSON on the same channel; binary chunks carry a 4-byte
transfer tag so several files can share one link without mixing up.

| Message | Direction | Meaning |
|---|---|---|
| `req` | receiver → owner | send me this file, from byte `offset` (request id `rid`) |
| `start` | owner → receiver | here it comes from `offset`, tagged `tag`, answering `rid` |
| `end` | owner → receiver | that was the last chunk |
| `ack` | receiver → owner | relay flow control |
| `err` | owner → receiver | could not serve it |
| `pair-req` / `pair-ok` / `pair-no` | either way | remember this device: each side sends half of the pairing secret |

Screen sharing uses its own `RTCPeerConnection` per viewer, signalled with `scr-offer`, `scr-answer`, `scr-ice` and `scr-stop` through `rtc:signal`.

Presence events (socket.io): `presence:hello` (name, kind, device id, pairing tokens), `presence:nearby`, `presence:paired`, `presence:invite` → `presence:invited`, `presence:forget` → `presence:forgotten`.
