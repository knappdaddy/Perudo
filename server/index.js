// Optional Node server: serves the app and runs every room over WebSockets.
// (The GitHub Pages build needs no server — the host's browser runs the room.)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createHub } from '../public/game/hub.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};
const ROOM_IDLE_MS = 15 * 60 * 1000;
const SERVER_CONFIG = "export default { mode: 'server' };\n";

export function createServer({ timing } = {}) {
  const hub = createHub({ timing });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(`ok ${hub.rooms.size} rooms`);
    }
    if (url.pathname === '/config.js') {
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-cache' });
      return res.end(SERVER_CONFIG);
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
      // Unknown paths fall back to the app.
      const body = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      res.end(body);
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

  wss.on('connection', (ws) => {
    const client = {
      open: true,
      send: (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg)),
      close: () => ws.close(),
    };
    ws.alive = true;
    ws.on('pong', () => (ws.alive = true));
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      hub.receive(client, msg);
    });
    ws.on('close', () => hub.disconnect(client));
  });

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
    hub.sweep(ROOM_IDLE_MS);
  }, 25000);
  sweep.unref();

  server.on('close', () => {
    clearInterval(sweep);
    hub.destroyAll();
  });

  return { server, rooms: hub.rooms, wss };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createServer();
  server.listen(port, () => console.log(`🎲 Perudo is rolling on http://localhost:${port}`));
}
