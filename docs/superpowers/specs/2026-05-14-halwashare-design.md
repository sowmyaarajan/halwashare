# HalwaShare — Design Spec
**Date:** 2026-05-14

---

## Overview

HalwaShare is a local-network, browser-based application for 2–5 people on the same Wi-Fi/LAN. It provides real-time chat, peer-to-peer-style file sharing (relayed in-memory, nothing written to disk), and quality-of-life features like QR code joining, inline image previews, and dark mode. No accounts, no cloud, no shareable links — just open a browser and share a 4-digit room code.

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js | Event-driven, ideal for WebSocket relay and file streaming |
| HTTP server | Express | Serves frontend static files |
| Real-time | Socket.io | Handles WebSocket rooms, broadcasts, reconnections |
| Frontend | Vanilla HTML/CSS/JS | No build step, runs instantly in any browser |
| QR code | `qrcode` npm package | Generates QR PNG server-side |
| Storage | None | All state in Node.js memory only |

---

## Architecture

```
Host's machine (runs Node.js server)
├── Express  →  serves /public (frontend)
└── Socket.io  →  relays chat + file chunks in memory
        ↕                    ↕                    ↕
   Browser (User 1)   Browser (User 2)   Browser (User 3-5)
   [same Wi-Fi network — all hit http://<host-ip>:3000]
```

The server process is the single hub. All chat messages and file bytes pass through it in memory. Nothing is written to disk. When a room empties, its state is garbage-collected.

---

## Room & Identity

### Room creation
- Host clicks **"Create Room"** on the landing page
- Server generates a random 4-digit numeric code (e.g. `4821`)
- Room object created in server memory: `{ code, users: [], history: [] }`
- Host is assigned **User 1** and lands on the room screen

### Joining
- Others open `http://<host-ip>:3000` in any browser (desktop or mobile)
- Enter the 4-digit code on the landing page
- If valid and room has < 5 users: assigned next available `User N` slot, receive full session history
- If invalid: error `"Room not found. Check the code and try again."`
- If full: error `"This room is full (5/5). Ask someone to leave first."`

### QR code
- Room screen displays a QR code encoding `http://<host-ip>:3000/join/<code>`
- Mobile users scan the QR code to skip manual code entry entirely
- QR is generated server-side using the `qrcode` package and served as a PNG data URL

### Identity
- Fully anonymous. Users are auto-assigned `User 1`, `User 2`, etc.
- No names, avatars, or accounts
- User numbers are assigned in join order and freed when a user disconnects (next joiner reuses the slot)

### Room lifecycle
- Room persists in memory as long as at least one user is connected
- When the last user disconnects, the room object is deleted from memory
- If the Node.js process stops (host closes terminal), all connected clients receive a `"Session ended — the host closed the room"` banner and are returned to the landing page

---

## Chat

### Message flow
1. User types a message and presses Enter or clicks Send
2. Client emits `chat:message` Socket.io event to server
3. Server appends message to room history and broadcasts to all room members
4. All clients render the message immediately

### Message anatomy
Each message renders with:
- Sender label (`User 2`)
- Timestamp (HH:MM format, local time)
- Message text
- **Copy to clipboard** button (copies raw text)

### Typing indicator
- Client emits `chat:typing` on each keystroke (debounced, max once per 500ms)
- Server broadcasts `"User N is typing..."` to all other room members
- Indicator auto-clears after 2 seconds of no new keystrokes
- Multiple simultaneous typers: `"User 2 and User 3 are typing..."`

### Sound notification
- A soft ping plays via the Web Audio API when a new message arrives from another user
- Mute toggle button in the top bar; preference stored in `localStorage`

### Session history
- New joiners receive the full `history` array on connect and render all prior messages and file cards
- History is cleared when the room is destroyed (last user leaves)

---

## File Sharing

### Upload flow
1. User drags a file onto the chat window (desktop) or clicks the paperclip button (desktop + mobile)
2. Client reads the file using the FileReader API and splits it into 64 KB chunks
3. Client emits `file:start` with metadata: `{ name, size, type, totalChunks }`
4. Client emits sequential `file:chunk` events: `{ chunkIndex, data (base64) }`
5. Client emits `file:end` when all chunks are sent

### Relay flow
- Server receives `file:start` and creates an in-memory buffer for the transfer
- Server relays each `file:chunk` to all other room members as it arrives (streaming, not buffered)
- Server emits `file:end` to all members when the last chunk arrives
- Server discards the in-memory buffer immediately after `file:end`

### Receive & download
- Receiving clients reassemble chunks into a `Blob` using the Web Blob API
- A browser object URL (`URL.createObjectURL`) is created for download
- The object URL is revoked after the user clicks Download (memory freed)
- **Images** (JPEG, PNG, GIF, WebP): shown as inline thumbnails in chat; click to view full size in a lightbox
- **All other files** (PDF, docx, zip, etc.): shown as a file card with icon, filename, size, and a Download button

### Progress
- Files > 1 MB show a progress bar during transfer (based on chunks received / total chunks)
- If a sender disconnects mid-transfer, recipients see `"Transfer incomplete — User N disconnected"` on the file card

### Constraints
- No file size hard limit (limited only by available RAM on the host machine)
- Files are not stored anywhere; once all recipients have downloaded, the object URL is the only reference

---

## UI Layout

### Desktop (≥ 768px)

```
┌─────────────────────────────────────────────────────┐
│  HalwaShare          Room: 4821   [🔇] [🌙]  [Exit] │
├──────────────────┬──────────────────────────────────┤
│  Participants    │  10:32  User 2: hey everyone!    │
│                  │         [copy]                   │
│  ● User 1 (you)  │  10:33  User 1: files incoming! │
│  ● User 2        │         [copy]                   │
│  ● User 3        │  [📄 report.pdf  2.3 MB]         │
│                  │       [Download]                 │
│  ──────────────  │  [🖼 photo.jpg — inline preview] │
│  [QR Code PNG]   │                                  │
│  Scan to join    │  User 3 is typing...             │
│                  ├──────────────────────────────────┤
│                  │  [📎]  Type a message...  [Send] │
└──────────────────┴──────────────────────────────────┘
```

### Mobile (< 768px)
- Sidebar collapses into a top banner: `Room: 4821 · 3 users`
- Tap the room code to reveal the QR code in a modal
- File upload via the paperclip button only (drag & drop not available on mobile)
- Full-width message bubbles, bottom-anchored input

### Dark mode
- CSS custom properties (`--bg`, `--surface`, `--text`, etc.) toggled by a class on `<body>`
- Toggle button in top bar; preference stored in `localStorage` and applied on page load

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Wrong room code | Inline error: `"Room not found. Check the code and try again."` |
| Room full | Inline error: `"This room is full (5/5)."` |
| User disconnects | System message in chat: `"User 3 has left the room"` |
| File transfer interrupted | File card shows `"Transfer incomplete — User N disconnected"` |
| Host closes server | All clients get banner: `"Session ended — the host closed the room"` → redirect to landing |
| Duplicate room code (collision) | Server regenerates until unique (4-digit space = 10,000 codes, max 9,999 rooms) |

---

## File & Folder Structure

```
HalwaShare/
├── server.js              # Express + Socket.io server, room logic, file relay
├── package.json
├── public/
│   ├── index.html         # Landing page (create / join)
│   ├── room.html          # Chat room page
│   ├── style.css          # All styles (light + dark mode via CSS vars)
│   └── app.js             # Frontend Socket.io client, chat, file handling
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-05-14-halwashare-design.md
```

---

## How to Run

```bash
npm install
node server.js
# Server starts on http://0.0.0.0:3000
# Open http://localhost:3000 on the host machine
# Others on the same Wi-Fi open http://<host-local-ip>:3000
```

---

## Verification Checklist

- [ ] Create room → 4-digit code appears, QR code renders
- [ ] Join from second device using code → assigned User 2, sees room history
- [ ] Join via QR code scan on mobile → lands directly in room
- [ ] Send chat message → appears on all connected clients instantly
- [ ] Typing indicator appears on other clients, auto-clears
- [ ] Sound ping plays on new message; mute toggle works and persists
- [ ] Drag & drop an image → inline thumbnail appears for all users
- [ ] Drag & drop a PDF → file card appears, Download works
- [ ] File > 1 MB → progress bar visible during transfer
- [ ] Disconnect a user mid-transfer → incomplete transfer notice appears
- [ ] Last user leaves → room cleared from memory (verified via server logs)
- [ ] Dark mode toggle → persists across refresh
- [ ] Copy button on message → clipboard receives text
- [ ] Room full (5 users) → 6th user gets error
- [ ] Host kills server → all clients see session-ended banner
