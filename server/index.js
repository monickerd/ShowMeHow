const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createRoom, getRoom, deleteRoom, scheduleDelete, resolveRoomId, claimSlot, setPeer, clearPeer, getOtherPeer, bothPresent, isRoomEmpty, allowRestart } = require('./session');

const PORT    = process.env.PORT || 8383;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PUBLIC  = path.join(__dirname, '..', 'public');

function log(tag, msg, extra) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${tag}] ${msg}`;
  if (extra !== undefined) console.log(line, JSON.stringify(extra));
  else console.log(line);
}

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

function parseTurnUrls(raw) {
  if (!raw) return [];
  const trimmed = raw.trim();
  // Accept JSON array format: ["turn:...", "turns:..."]
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(s => String(s).trim()).filter(Boolean);
    } catch (e) {
      log('WARN', 'TURN_URLS looks like JSON but failed to parse, falling back to comma-split', { raw, error: e.message });
    }
  }
  // Fallback: comma-separated plain list
  return trimmed.split(',').map(s => s.trim()).filter(Boolean);
}

// Generate time-limited credentials for coturn use_auth_secret mode.
// username = expiry timestamp; credential = HMAC-SHA1(secret, username).
function hmacTurnCredentials(secret, ttlSeconds = 86400) {
  const expiry   = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = String(expiry);
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

function buildIceServers() {
  const turnSecret = process.env.TURN_SECRET || undefined;
  let username, credential;

  if (turnSecret) {
    ({ username, credential } = hmacTurnCredentials(turnSecret));
  } else {
    username   = process.env.TURN_USERNAME   || undefined;
    credential = process.env.TURN_CREDENTIAL || undefined;
  }

  const turn = parseTurnUrls(process.env.TURN_URLS).map(url => {
    const entry = { urls: url };
    if (username)   entry.username   = username;
    if (credential) entry.credential = credential;
    return entry;
  });

  const stunUrls = parseTurnUrls(process.env.STUN_URLS);
  const stun = (stunUrls.length ? stunUrls : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'])
    .map(urls => ({ urls }));

  return [...turn, ...stun];
}

// ── HTTP ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url      = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'POST' && pathname === '/api/rooms') {
    const id = createRoom();
    log('ROOM', `Created room ${id}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ roomId: id }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    const iceServers = buildIceServers();
    log('ICE', `Serving ICE config (${iceServers.length} servers)`, iceServers.map(s => s.urls));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ iceServers }));
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
  'session-failed',   // a peer gave up recovering — tell the other side too
]);

// Notify both peers that the session is ready to (re)negotiate. The peer in
// slot 0 is always the offerer — a single deterministic choice avoids offer
// glare, whether this is a fresh join or a coordinated restart.
function notifyBothPresent(roomId) {
  const room = getRoom(roomId);
  if (!room || !room.peers[0] || !room.peers[1]) return;
  send(room.peers[0], { type: 'peer-joined', initiateOffer: true });
  send(room.peers[1], { type: 'peer-joined', initiateOffer: false });
}

wss.on('connection', (ws, req) => {
  const url      = new URL(req.url, 'http://localhost');
  const roomId   = resolveRoomId(url.searchParams.get('room') || '');
  const clientId = url.searchParams.get('id') || null;
  const ip       = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

  if (!roomId) {
    log('WS', `Rejected connection from ${ip}: missing room`);
    ws.close(1008, 'Missing room');
    return;
  }

  const room = getRoom(roomId);
  if (!room) {
    log('WS', `Rejected connection from ${ip}: room "${roomId}" not found`);
    ws.close(1008, 'Room not found');
    return;
  }

  const { slot, evict } = claimSlot(roomId, clientId);
  if (slot === -1) {
    log('WS', `Rejected connection from ${ip}: room "${roomId}" is full`);
    ws.close(1008, 'Room is full');
    return;
  }

  // Install the new socket first, then evict any predecessor. clearPeer() is
  // guarded so the evicted socket's close handler won't wipe this new slot.
  setPeer(roomId, slot, ws, clientId);
  if (evict && evict !== ws) {
    log('WS', `Evicting old slot ${slot} in room "${roomId}" (reconnect)`);
    evict.close(1012, 'Replaced by reconnect');
  }

  log('WS', `Client connected — room="${roomId}" slot=${slot} ip=${ip}`);

  if (bothPresent(roomId)) {
    log('WS', `Both peers present in room "${roomId}", signaling peer-joined`);
    notifyBothPresent(roomId);
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch {
      log('WS', `Unparseable message from slot ${slot} in room "${roomId}"`);
      return;
    }

    // Server-handled: a peer asks for a full, coordinated renegotiation.
    if (msg.type === 'request-restart') {
      log('WS', `request-restart in room "${roomId}" — bothPresent=${bothPresent(roomId)}`);
      if (bothPresent(roomId) && allowRestart(roomId)) notifyBothPresent(roomId);
      return;
    }

    if (RELAY_TYPES.has(msg.type)) {
      if (msg.type !== 'ice-candidate' && msg.type !== 'cursor') {
        log('WS', `Relay "${msg.type}" room="${roomId}" slot=${slot}→${slot === 0 ? 1 : 0}`);
      }
      send(getOtherPeer(roomId, slot), msg);
    }
  });

  ws.on('close', (code, reason) => {
    // Only tear down if this socket still owns the slot (it may have been
    // evicted by its own reconnect, in which case the slot is already reused).
    if (!clearPeer(roomId, slot, ws)) return;
    log('WS', `Client disconnected — room="${roomId}" slot=${slot} code=${code} reason=${reason || '(none)'}`);
    send(getOtherPeer(roomId, slot), { type: 'peer-left' });
    if (isRoomEmpty(roomId)) scheduleDelete(roomId);
  });
});

server.listen(PORT, () => {
  const iceServers = buildIceServers();
  const turnEntries = iceServers.filter(s => String(s.urls).startsWith('turn'));
  log('START', `Screenshare running — port=${PORT} baseUrl=${BASE_URL}`);
  log('START', `ICE config: ${iceServers.length} servers total (${turnEntries.length} TURN)`);
  if (turnEntries.length === 0) {
    log('WARN', 'No TURN servers configured — clients behind strict NAT may fail to connect');
  } else {
    const authMode = process.env.TURN_SECRET ? 'hmac (use_auth_secret)' : 'static';
    for (const t of turnEntries) {
      log('START', `  TURN [${authMode}]: ${t.urls}  user=${t.username ?? '(none)'}  credential=${t.credential ? '***' : '(none)'}`);
    }
  }
});
