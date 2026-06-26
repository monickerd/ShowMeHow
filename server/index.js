const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createRoom, getRoom, deleteRoom, claimSlot, setPeer, getOtherPeer, isRoomEmpty } = require('./session');

const PORT   = process.env.PORT || 8383;
const PUBLIC = path.join(__dirname, '..', 'public');

// ── Static file server ──────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function serveHtml(res, name) {
  serveFile(res, path.join(PUBLIC, name));
}

// ── ICE / TURN config ───────────────────────────────────────────────────────

function buildIceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  const turnUrls   = process.env.TURN_URLS;
  const username   = process.env.TURN_USERNAME   || undefined;
  const credential = process.env.TURN_CREDENTIAL || undefined;

  if (turnUrls) {
    for (const url of turnUrls.split(',').map(s => s.trim()).filter(Boolean)) {
      const entry = { urls: url };
      if (username)   entry.username   = username;
      if (credential) entry.credential = credential;
      servers.push(entry);
    }
  }

  return servers;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url      = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'POST' && pathname === '/api/rooms') {
    const id = createRoom();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ roomId: id }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ iceServers: buildIceServers() }));
    return;
  }

  if (pathname.startsWith('/js/') || pathname.startsWith('/css/')) {
    serveFile(res, path.join(PUBLIC, pathname));
    return;
  }

  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  if (pathname === '/') { serveHtml(res, 'index.html'); return; }

  // /<roomId> — both participants use the same page
  const roomMatch = pathname.match(/^\/([A-Za-z]+)$/);
  if (roomMatch) {
    const room = getRoom(roomMatch[1]);
    if (!room) { res.writeHead(404); res.end('Room not found or expired'); return; }
    serveHtml(res, 'room.html');
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket signaling ─────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws' });

function send(socket, msg) {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

const RELAY_TYPES = new Set([
  'offer', 'answer', 'ice-candidate',
  'cursor',
  'share-start', 'share-stop',
  'chat',
]);

wss.on('connection', (ws, req) => {
  const url    = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room');
  if (!roomId) { ws.close(1008, 'Missing room'); return; }

  const room = getRoom(roomId);
  if (!room) { ws.close(1008, 'Room not found'); return; }

  const slot = claimSlot(roomId);
  if (slot === -1) { ws.close(1008, 'Room is full'); return; }

  setPeer(roomId, slot, ws);
  const other = getOtherPeer(roomId, slot);

  if (other) {
    // Both peers are now present.
    // The one who was waiting first (other) creates the offer — they've had time
    // to set up their page and are ready to initiate.
    send(other, { type: 'peer-joined', initiateOffer: true });
    send(ws,    { type: 'peer-joined', initiateOffer: false });
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (RELAY_TYPES.has(msg.type)) send(getOtherPeer(roomId, slot), msg);
  });

  ws.on('close', () => {
    const currentRoom = getRoom(roomId);
    if (!currentRoom) return;
    currentRoom.peers[slot] = null;
    send(getOtherPeer(roomId, slot), { type: 'peer-left' });
    if (isRoomEmpty(roomId)) deleteRoom(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`Screenshare running on http://localhost:${PORT}`);
});
