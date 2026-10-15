// The app's only link to other players. Two flavours, same interface:
//   server – a WebSocket to the Node server, which runs the rooms.
//   relay  – no server of our own (GitHub Pages): whoever creates a room runs
//            it in their own browser (the same hub/room code the server uses),
//            and phones swap messages through free public MQTT brokers over
//            secure WebSockets, which get through practically any network.
import { createHub, randomCode } from './game/hub.js';
import { connectMqtt } from './mqtt-lite.js';

const TOPIC_ROOT = 'perudo-knappdaddy/v2';
const DEFAULT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://mqtt.eclipseprojects.io/mqtt', // port 443, for networks that block odd ports
];
const PING_MS = 4000;
const DEAD_MS = 15000;
const FIND_HOST_MS = 5000;

export function createNet({ config, onMessage, onStatus }) {
  const deliver = (msg) => queueMicrotask(() => onMessage(msg));
  return config.mode === 'server' ? serverNet(deliver, onStatus) : relayNet(config, deliver, onStatus);
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

function randomId() {
  const a = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Topics: guests write to <room>/host; the host answers each guest on <room>/c/<guestId>.
const hostTopic = (code) => `${TOPIC_ROOT}/${code}/host`;
const guestTopic = (code, id) => `${TOPIC_ROOT}/${code}/c/${id}`;

function relayNet(config, deliver, onStatus) {
  const brokers = config.brokers?.length ? config.brokers : DEFAULT_BROKERS;
  const myId = randomId(); // this tab's address on the relay
  let host = null;
  let guest = null;

  const fail = (msg) => deliver({ t: 'error', msg });

  function teardown() {
    if (host) {
      clearInterval(host.timer);
      host.hub.destroyAll();
      for (const mq of host.conns.values()) mq.close();
    }
    if (guest) {
      clearInterval(guest.timer);
      guest.mq?.close();
    }
    host = guest = null;
    onStatus(true);
  }

  // ----- hosting: run the room here and listen on every broker at once -----

  async function startHosting({ first, snapshot }) {
    teardown();
    const code = snapshot?.code || randomCode();
    const local = { open: true, local: true, send: deliver, close() {} };
    const h = { code, local, conns: new Map(), clients: new Map(), retrying: new Set() };
    h.hub = createHub({
      newCode: () => code,
      canCreate: (c) => c === local,
      onRoomChange: (room) => host === h && saveRoom(room.snapshot()),
    });
    host = h;
    h.timer = setInterval(() => hostHeartbeat(h), PING_MS);
    if (snapshot) {
      h.hub.restore(snapshot);
      h.hub.receive(local, first);
    }
    try {
      // Ready as soon as any broker answers; the rest keep connecting in the background.
      await Promise.any(
        brokers.map((url) =>
          hostBroker(h, url).catch((err) => {
            reconnectHostBroker(h, url);
            throw err;
          }),
        ),
      );
    } catch {
      if (host !== h) return;
      if (!snapshot) {
        teardown();
        return fail("Couldn't reach the game relay. Check your internet and try again?");
      }
      onStatus(false);
    }
    if (host === h && !snapshot) h.hub.receive(local, first);
  }

  async function hostBroker(h, url) {
    const mq = await connectMqtt(url, { clientId: `pk${myId}h` });
    if (host !== h) {
      mq.close();
      throw new Error('stale');
    }
    h.conns.set(url, mq);
    onStatus(true);
    mq.subscribe(hostTopic(h.code));
    mq.onMessage((_topic, text) => hostReceive(h, mq, text));
    mq.onClose(() => {
      h.conns.delete(url);
      if (host === h && h.conns.size === 0) onStatus(false);
      reconnectHostBroker(h, url);
    });
    return mq;
  }

  async function reconnectHostBroker(h, url) {
    if (h.retrying.has(url)) return;
    h.retrying.add(url);
    try {
      for (let delay = 2000; host === h && !h.conns.has(url); delay = Math.min(delay * 2, 30000)) {
        await sleep(delay);
        if (host !== h || h.conns.has(url)) return;
        try {
          await hostBroker(h, url);
        } catch {}
      }
    } finally {
      h.retrying.delete(url);
    }
  }

  function hostReceive(h, mq, text) {
    if (host !== h) return;
    let env;
    try {
      env = JSON.parse(text);
    } catch {
      return;
    }
    const from = env?.from;
    const m = env?.m;
    if (typeof from !== 'string' || from.length > 32 || !m || typeof m !== 'object') return;
    let c = h.clients.get(from);
    if (!c) {
      c = {
        id: from,
        open: true,
        send: (msg) => c.mq.connected && c.mq.publish(guestTopic(h.code, from), JSON.stringify(msg)),
        close: () => h.clients.delete(from),
      };
      h.clients.set(from, c);
    }
    c.mq = mq; // answer on whichever broker they last used
    c.open = true;
    c.lastSeen = Date.now();
    const attached = c.ctx && c.ctx.player.client === c;
    // A slow reply can make a guest repeat its hello on another broker — don't seat them twice.
    if (m.t === 'join' && attached) return;
    if (m.t === 'ping') {
      // A guest we don't know (we reloaded, or they did) — ask them who they are.
      if (!attached) c.send({ t: 'who' });
      return;
    }
    h.hub.receive(c, m);
  }

  function hostHeartbeat(h) {
    const now = Date.now();
    for (const [id, c] of h.clients) {
      if (now - c.lastSeen > DEAD_MS) {
        h.hub.disconnect(c);
        h.clients.delete(id);
      } else c.send({ t: 'ping' });
    }
  }

  // ----- joining: find the host on one of the brokers -----

  async function joinRoom(code, first, session = null) {
    teardown();
    const g = { code, first, session, joined: !!session, gotState: false, lastSeen: 0, mq: null, outbox: [], misses: 0 };
    guest = g;
    g.timer = setInterval(() => guestHeartbeat(g), PING_MS);
    const found = await findHost(g);
    if (guest !== g || found === true) return;
    if (!g.joined) {
      teardown();
      return fail(
        found === 'no-relay'
          ? "Couldn't reach the game relay. Check your internet and try again?"
          : `No room ${code} answered. Check the code, and make sure the host's screen is still on.`,
      );
    }
    onStatus(false); // resuming: keep looking — the host may be reloading
  }

  // Try each broker in turn: connect, say hello, wait briefly for the host.
  async function findHost(g) {
    if (g.searching) return g.searching;
    g.searching = (async () => {
      let anyBroker = false;
      for (const url of brokers) {
        if (guest !== g) return false;
        let mq;
        try {
          mq = await connectMqtt(url, { clientId: `pk${myId}g` });
        } catch {
          continue;
        }
        anyBroker = true;
        if (guest !== g) return mq.close(), false;
        mq.subscribe(guestTopic(g.code, myId));
        mq.onMessage((_t, text) => guestReceive(g, mq, text));
        const heardAt = g.lastSeen;
        const tell = (m) => mq.publish(hostTopic(g.code), JSON.stringify({ from: myId, m }));
        tell(g.joined && g.session ? { t: 'resume', ...g.session } : g.first);
        for (let waited = 0; waited < FIND_HOST_MS && g.lastSeen === heardAt && guest === g; waited += 100) await sleep(100);
        if (guest === g && g.lastSeen !== heardAt) {
          if (g.mq && g.mq !== mq) g.mq.close();
          g.mq = mq;
          mq.onClose(() => guest === g && g.mq === mq && (onStatus(false), findHost(g)));
          for (const m of g.outbox.splice(0)) tell(m);
          return true;
        }
        mq.close();
      }
      return anyBroker ? 'no-host' : 'no-relay';
    })();
    try {
      return await g.searching;
    } finally {
      g.searching = null;
    }
  }

  function guestReceive(g, mq, text) {
    if (guest !== g) return;
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    g.lastSeen = Date.now();
    if (g.mq === mq) onStatus(true);
    if (m.t === 'ping') return;
    if (m.t === 'who') {
      const hello = g.joined && g.session ? { t: 'resume', ...g.session } : g.first;
      if (hello) mq.publish(hostTopic(g.code), JSON.stringify({ from: myId, m: hello }));
      return;
    }
    if (m.t === 'joined') g.joined = true;
    if (m.t === 'state') g.gotState = true;
    deliver(m);
    if (m.t === 'kicked' || m.t === 'gone' || (m.t === 'error' && !g.joined)) teardown();
  }

  function guestHeartbeat(g) {
    if (guest !== g || g.searching) return;
    if (g.mq?.connected) g.mq.publish(hostTopic(g.code), JSON.stringify({ from: myId, m: { t: 'ping' } }));
    const silent = Date.now() - g.lastSeen;
    if (g.mq && silent > DEAD_MS) onStatus(false);
    // Never found the host, or it's gone quiet: maybe it's reloading or on another broker. Go looking.
    if (!g.mq?.connected || silent > DEAD_MS * 2) {
      g.misses++;
      if (!g.gotState && g.misses >= 3) {
        teardown();
        return deliver({ t: 'gone' });
      }
      if (g.misses >= 40) {
        teardown();
        return deliver({ t: 'kicked', msg: 'Lost the host for good. 😢 Start a new room?' });
      }
      findHost(g).then((ok) => ok === true && (g.misses = 0));
    }
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
            clearInterval(h.timer);
            h.hub.destroyAll();
            for (const mq of h.conns.values()) mq.close();
          }, 500);
        }
        return host.hub.receive(host.local, msg);
      }
      if (msg.t === 'create') return startHosting({ first: msg });
      if (msg.t === 'join') return joinRoom(String(msg.code).toUpperCase(), msg);
      const g = guest;
      if (!g) return;
      const wrapped = JSON.stringify({ from: myId, m: msg });
      if (g.mq?.connected && !g.searching) g.mq.publish(hostTopic(g.code), wrapped);
      else g.outbox.push(msg);
      if (msg.t === 'leave') {
        guest = null;
        setTimeout(() => {
          clearInterval(g.timer);
          g.mq?.close();
        }, 500);
      }
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
      if (host) for (const url of brokers) if (!host.conns.has(url)) reconnectHostBroker(host, url);
      if (guest && !guest.searching && !guest.mq?.connected) findHost(guest);
    },
  };
}
