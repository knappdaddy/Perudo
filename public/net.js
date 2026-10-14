// The app's only link to other players. Two flavours, same interface:
//   server – a WebSocket to the Node server, which runs the rooms.
//   p2p    – no server: whoever creates a room runs it in their own browser
//            (the same hub/room code the server uses) and friends connect to
//            them over WebRTC data channels. PeerJS's free cloud broker is
//            only used to introduce phones to each other.
import { createHub, randomCode } from './game/hub.js';

const PEER_PREFIX = 'perudo-knappdaddy-v1-';
const PING_MS = 4000;
const DEAD_MS = 15000;

export function createNet({ config, onMessage, onStatus }) {
  const deliver = (msg) => queueMicrotask(() => onMessage(msg));
  return config.mode === 'server' ? serverNet(deliver, onStatus) : p2pNet(config, deliver, onStatus);
}

// ---------------------------------------------------------------------------

function serverNet(deliver, onStatus) {
  let ws = null;
  let retry = 0;
  let outbox = [];
  let session = null;

  function connect() {
    if (ws && ws.readyState <= 1) return;
    const base = location.pathname.replace(/[^/]*$/, '');
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base}ws`);
    ws.onopen = () => {
      retry = 0;
      onStatus(true);
      if (session) ws.send(JSON.stringify({ t: 'resume', ...session }));
      for (const m of outbox) ws.send(JSON.stringify(m));
      outbox = [];
    };
    ws.onmessage = (ev) => deliver(JSON.parse(ev.data));
    ws.onclose = () => {
      onStatus(false);
      setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
    };
  }

  connect();
  return {
    isHost: () => false,
    send(msg) {
      if (msg.t === 'leave') session = null;
      if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
      else {
        outbox.push(msg);
        connect();
      }
    },
    resume(s) {
      session = s;
      if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'resume', ...s }));
    },
    setSession(s) {
      session = s;
    },
    wake: connect,
  };
}

// ---------------------------------------------------------------------------

let peerLib = null;
function loadPeerJS() {
  peerLib ??= new Promise((resolve, reject) => {
    if (window.Peer) return resolve(window.Peer);
    const s = document.createElement('script');
    s.src = new URL('vendor/peerjs.min.js', import.meta.url).href;
    s.onload = () => resolve(window.Peer);
    s.onerror = () => {
      peerLib = null;
      reject(new Error('Could not load PeerJS'));
    };
    document.head.appendChild(s);
  });
  return peerLib;
}

const SAVE_KEY = 'perudo:hostedRoom';
const saveRoom = (snap) => {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(snap));
  } catch {}
};
const loadRoom = () => {
  try {
    return JSON.parse(localStorage.getItem(SAVE_KEY));
  } catch {
    return null;
  }
};
const clearRoom = () => {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {}
};

function p2pNet(config, deliver, onStatus) {
  const peerOpts = { debug: 0, ...(config.peer || {}) };
  let peer = null;
  let host = null; // { code, hub, local, clients:Set, timer }
  let guest = null; // { code, first, joined, conn, outbox, failures, gotState, lastSeen, timer, retryTimer }

  const fail = (msg) => deliver({ t: 'error', msg });

  function newPeer(id) {
    return loadPeerJS().then((Peer) => {
      const p = id ? new Peer(id, peerOpts) : new Peer(peerOpts);
      p.on('disconnected', () => {
        if (p === peer) onStatus(false);
        if (p === peer && !p.destroyed) setTimeout(() => p === peer && !p.destroyed && p.reconnect(), 2000);
      });
      return p;
    });
  }

  function teardown() {
    if (host) {
      clearInterval(host.timer);
      host.hub.destroyAll();
    }
    if (guest) {
      clearInterval(guest.timer);
      clearTimeout(guest.retryTimer);
      guest.conn?.close();
    }
    host = guest = null;
    peer?.destroy();
    peer = null;
    onStatus(true);
  }

  // ----- hosting -----

  // Create (or restore) the room locally, then register its code with the broker
  // so guests can find us. A fresh room retries with a new code if one is taken.
  async function startHosting({ first, snapshot }) {
    teardown();
    const code = snapshot?.code || randomCode();
    const local = { open: true, local: true, send: deliver, close() {} };
    const hub = createHub({
      newCode: () => code,
      canCreate: (c) => c === local,
      onRoomChange: (room) => host?.hub === hub && saveRoom(room.snapshot()),
    });
    host = { code, hub, local, first, clients: new Set() };
    host.timer = setInterval(heartbeat, PING_MS);
    if (snapshot) hub.restore(snapshot);
    openHostPeer(host, () => {
      if (!snapshot && host.hub.rooms.size === 0) hub.receive(local, first);
    }, !snapshot);
    if (snapshot) hub.receive(local, first);
  }

  async function openHostPeer(h, onOpen, fresh, attempt = 0) {
    let p;
    try {
      p = await newPeer(PEER_PREFIX + h.code);
    } catch {
      return fail("Couldn't load the multiplayer bits. Check your connection?");
    }
    if (host !== h) return p.destroy();
    peer = p;
    p.on('open', () => {
      onStatus(true);
      onOpen();
    });
    p.on('connection', (conn) => host === h && wireGuest(h, conn));
    p.on('error', (err) => {
      if (host !== h) return;
      if (err.type === 'unavailable-id') {
        p.destroy();
        if (fresh && h.hub.rooms.size === 0) {
          // Someone somewhere already has this code — roll a new one.
          host = null;
          clearInterval(h.timer);
          return startHosting({ first: h.first });
        }
        // Our own old registration hasn't expired yet (page reload) — keep trying.
        return setTimeout(() => host === h && openHostPeer(h, onOpen, false, attempt + 1), 3000);
      }
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        onStatus(false);
        return;
      }
      if (err.type === 'browser-incompatible') fail("This browser can't do peer-to-peer. Try Chrome or Safari?");
    });
  }

  function wireGuest(h, conn) {
    const client = {
      open: false,
      lastSeen: Date.now(),
      send: (m) => conn.open && conn.send(m),
      close: () => setTimeout(() => conn.close(), 300),
    };
    h.clients.add(client);
    const gone = () => {
      if (!h.clients.delete(client)) return;
      h.hub.disconnect(client);
    };
    conn.on('open', () => (client.open = true));
    conn.on('data', (m) => {
      client.open = true;
      client.lastSeen = Date.now();
      if (m?.t !== 'ping') h.hub.receive(client, m);
    });
    conn.on('close', gone);
    conn.on('error', gone);
    client.drop = () => {
      conn.close();
      gone();
    };
  }

  function heartbeat() {
    if (!host) return;
    const now = Date.now();
    for (const c of host.clients) {
      if (now - c.lastSeen > DEAD_MS) c.drop();
      else c.send({ t: 'ping' });
    }
  }

  // ----- joining -----

  async function joinRoom(code, first, session = null) {
    teardown();
    guest = { code, first, session, joined: !!session, outbox: [], failures: 0, gotState: false, lastSeen: Date.now() };
    const g = guest;
    let p;
    try {
      p = await newPeer();
    } catch {
      return fail("Couldn't load the multiplayer bits. Check your connection?");
    }
    if (guest !== g) return p.destroy();
    peer = p;
    p.on('open', () => connectToHost(g));
    p.on('error', (err) => {
      if (guest !== g) return;
      if (err.type === 'peer-unavailable') {
        g.failures++;
        if (!g.joined) {
          teardown();
          return fail("Can't find that room. Is the host's screen still on?");
        }
        if (!g.gotState && g.failures >= 3) {
          teardown();
          return deliver({ t: 'gone' });
        }
        if (g.failures >= 40) {
          teardown();
          return deliver({ t: 'kicked', msg: 'Lost the host for good. 😢 Start a new room?' });
        }
        return retry(g);
      }
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        onStatus(false);
        return retry(g);
      }
      if (err.type === 'browser-incompatible') fail("This browser can't do peer-to-peer. Try Chrome or Safari?");
    });
    g.timer = setInterval(() => {
      if (!g.conn?.open) return;
      if (Date.now() - g.lastSeen > DEAD_MS) {
        g.conn.close();
        return;
      }
      g.conn.send({ t: 'ping' });
    }, PING_MS);
  }

  function retry(g) {
    onStatus(false);
    clearTimeout(g.retryTimer);
    g.retryTimer = setTimeout(() => guest === g && connectToHost(g), Math.min(5000, 1000 + g.failures * 500));
  }

  function connectToHost(g) {
    if (guest !== g || !peer) return;
    if (peer.disconnected && !peer.destroyed) peer.reconnect();
    const conn = peer.connect(PEER_PREFIX + g.code, { reliable: true, serialization: 'json' });
    g.conn = conn;
    conn.on('open', () => {
      if (guest !== g) return conn.close();
      onStatus(true);
      g.lastSeen = Date.now();
      conn.send(g.joined && g.session ? { t: 'resume', ...g.session } : g.first);
      for (const m of g.outbox) conn.send(m);
      g.outbox = [];
    });
    conn.on('data', (m) => {
      if (guest !== g) return;
      g.lastSeen = Date.now();
      g.failures = 0;
      if (m?.t === 'ping') return;
      if (m.t === 'joined') g.joined = true;
      if (m.t === 'state') g.gotState = true;
      if (m.t === 'kicked' || m.t === 'gone') {
        deliver(m);
        return teardown();
      }
      deliver(m);
    });
    conn.on('close', () => guest === g && g.conn === conn && retry(g));
  }

  return {
    isHost: () => !!host,
    send(msg) {
      if (host) {
        if (msg.t === 'leave') {
          host.hub.closeRoom(host.code, 'The host packed up the dice. 👋');
          clearRoom();
          const h = host;
          host = null; // stop handling messages now; let the goodbyes flush first
          return setTimeout(() => {
            if (host || guest) return clearInterval(h.timer), h.hub.destroyAll();
            host = h;
            teardown();
          }, 400);
        }
        return host.hub.receive(host.local, msg);
      }
      if (msg.t === 'create') return startHosting({ first: msg });
      if (msg.t === 'join') return joinRoom(String(msg.code).toUpperCase(), msg);
      if (!guest) return;
      if (msg.t === 'leave') {
        guest.conn?.open && guest.conn.send(msg);
        const g = guest;
        guest = null;
        return setTimeout(() => {
          guest = g;
          teardown();
        }, 300);
      }
      if (guest.conn?.open) guest.conn.send(msg);
      else guest.outbox.push(msg);
    },
    resume(s) {
      if (s.host) {
        const snapshot = loadRoom();
        if (!snapshot || snapshot.code !== s.code) return deliver({ t: 'gone' });
        return startHosting({ first: { t: 'resume', code: s.code, token: s.token }, snapshot });
      }
      joinRoom(s.code, null, s);
    },
    setSession(s) {
      if (guest) guest.session = s;
      if (!s?.host) clearRoom();
    },
    wake() {
      if (peer?.disconnected && !peer.destroyed) peer.reconnect();
      if (guest && !guest.conn?.open) retry(guest);
    },
  };
}
