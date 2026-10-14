import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room, GameError } from './room.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/manifest+json',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};
const ROOM_IDLE_MS = 15 * 60 * 1000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O — too easy to misread

export function createServer({ timing } = {}) {
  const rooms = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(`ok ${rooms.size} rooms`);
    }
    let file;
    try {
      file = normalize(join(PUBLIC_DIR, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (!file.startsWith(PUBLIC_DIR.replace(/[\\/]$/, '') + sep)) {
      res.writeHead(403);
      return res.end();
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(body);
    } catch {
      // Unknown paths fall back to the app so links like /ABCD still work.
      const body = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      res.end(body);
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

  const broadcast = (room) => {
    for (const p of room.players) {
      if (p.socket?.readyState === 1) send(p.socket, { t: 'state', state: room.viewFor(p.id) });
    }
  };

  const newCode = () => {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      if (!rooms.has(code)) return code;
    }
  };

  const attach = (ws, room, player) => {
    if (ws.ctx && ws.ctx.player !== player && ws.ctx.player.socket === ws) {
      ws.ctx.player.socket = null;
      ws.ctx.room.setConnected(ws.ctx.player.id, false);
    }
    if (player.socket && player.socket !== ws) {
      send(player.socket, { t: 'kicked', msg: 'You joined from another tab.' });
      player.socket.close();
    }
    ws.ctx = { room, player };
    player.socket = ws;
    send(ws, { t: 'joined', code: room.code, token: player.token, id: player.id });
    room.setConnected(player.id, true);
  };

  wss.on('connection', (ws) => {
    ws.alive = true;
    ws.lastEmote = 0;
    ws.on('pong', () => (ws.alive = true));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      try {
        handle(ws, msg);
      } catch (err) {
        if (err instanceof GameError) send(ws, { t: 'error', msg: err.message });
        else {
          console.error(err);
          send(ws, { t: 'error', msg: 'Something went wobbly. Try again?' });
        }
      }
    });

    ws.on('close', () => {
      const { room, player } = ws.ctx || {};
      if (room && player?.socket === ws) {
        player.socket = null;
        room.setConnected(player.id, false);
      }
    });
  });

  function handle(ws, msg) {
    const ctx = ws.ctx;
    switch (msg.t) {
      case 'create': {
        const code = newCode();
        const room = new Room(code, { onChange: broadcast, timing });
        rooms.set(code, room);
        const player = room.addPlayer({ name: msg.name, avatar: msg.avatar });
        return attach(ws, room, player);
      }
      case 'join': {
        const room = rooms.get(String(msg.code || '').toUpperCase().trim());
        if (!room) throw new GameError("Can't find that room. Check the code?");
        const existing = msg.token && room.playerByToken(msg.token);
        if (existing) return attach(ws, room, existing);
        const player = room.addPlayer({ name: msg.name, avatar: msg.avatar });
        return attach(ws, room, player);
      }
      case 'resume': {
        const room = rooms.get(String(msg.code || '').toUpperCase());
        const player = room?.playerByToken(msg.token);
        if (!player || player.left) return send(ws, { t: 'gone' });
        return attach(ws, room, player);
      }
    }

    if (!ctx) throw new GameError('Join a room first.');
    const { room, player } = ctx;
    if (player.socket !== ws) return;
    switch (msg.t) {
      case 'settings': return room.updateSettings(player.id, msg.settings || {});
      case 'addBot': return room.addBot(player.id);
      case 'kick': {
        const target = room.kick(player.id, msg.id);
        if (target.socket) {
          send(target.socket, { t: 'kicked', msg: 'The host showed you the door.' });
          target.socket.ctx = null;
          target.socket = null;
        }
        return;
      }
      case 'start': return room.start(player.id);
      case 'bid': return room.bid(player.id, msg.qty, msg.face);
      case 'dudo': return room.dudo(player.id);
      case 'calza': return room.calza(player.id);
      case 'ready': return room.markReady(player.id);
      case 'lobby': return room.backToLobby(player.id);
      case 'leave': {
        room.leave(player.id);
        player.socket = null;
        ws.ctx = null;
        if (room.isAbandoned()) {
          room.destroy();
          rooms.delete(room.code);
        }
        return;
      }
      case 'emote': {
        const now = Date.now();
        if (now - ws.lastEmote < 700) return;
        ws.lastEmote = now;
        const e = String(msg.e || '').slice(0, 8);
        if (!EMOTES.has(e)) return;
        for (const p of room.players) if (p.socket?.readyState === 1) send(p.socket, { t: 'emote', from: player.id, e });
        return;
      }
    }
  }

  // Drop dead sockets (phones love to vanish without saying goodbye) and idle rooms.
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.isAbandoned() && now - room.lastActivity > ROOM_IDLE_MS) {
        room.destroy();
        rooms.delete(code);
      }
    }
  }, 25000);
  sweep.unref();

  server.on('close', () => {
    clearInterval(sweep);
    for (const room of rooms.values()) room.destroy();
  });

  return { server, rooms, wss };
}

const EMOTES = new Set(['😂', '🤥', '🤨', '🔥', '😱', '🦙', '👏', '💀']);

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createServer();
  server.listen(port, () => console.log(`🎲 Perudo is rolling on http://localhost:${port}`));
}
