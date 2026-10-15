// A tiny MQTT 3.1.1 client over WebSocket — just enough for the game relay:
// connect, subscribe, publish and keepalive, all at QoS 0. (The full mqtt.js
// library is ~300 KB; this is all we need.)

const enc = new TextEncoder();
const dec = new TextDecoder();

const utf8 = (s) => {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 255, ...b];
};

function packet(header, body) {
  const len = [];
  let n = body.length;
  do {
    let digit = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) digit |= 128;
    len.push(digit);
  } while (n > 0);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = header;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}

export function connectMqtt(url, { clientId, keepalive = 30, timeout = 7000 } = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url, 'mqtt');
    } catch (err) {
      return reject(err);
    }
    ws.binaryType = 'arraybuffer';
    let buf = new Uint8Array(0);
    let nextId = 1;
    let pinger = null;
    let settled = false;
    const messageHandlers = [];
    const closeHandlers = [];

    const client = {
      url,
      connected: false,
      subscribe(topic) {
        const id = (nextId = (nextId % 65535) + 1);
        send(packet(0x82, [id >> 8, id & 255, ...utf8(topic), 0]));
      },
      publish(topic, text) {
        send(packet(0x30, [...utf8(topic), ...enc.encode(text)]));
      },
      onMessage: (fn) => messageHandlers.push(fn),
      onClose: (fn) => closeHandlers.push(fn),
      close() {
        try {
          send(new Uint8Array([0xe0, 0])); // DISCONNECT
        } catch {}
        ws.close();
      },
    };

    function send(bytes) {
      if (ws.readyState === 1) ws.send(bytes);
    }

    const timer = setTimeout(() => fail(new Error('timeout')), timeout);
    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      reject(err);
    }

    ws.onopen = () => {
      const body = [...utf8('MQTT'), 4, 0x02, keepalive >> 8, keepalive & 255, ...utf8(clientId)];
      send(packet(0x10, body));
    };

    ws.onerror = () => fail(new Error('websocket error'));

    ws.onclose = () => {
      clearInterval(pinger);
      const wasConnected = client.connected;
      client.connected = false;
      fail(new Error('closed'));
      if (wasConnected) for (const fn of closeHandlers) fn();
    };

    ws.onmessage = (ev) => {
      const chunk = new Uint8Array(ev.data);
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf);
      merged.set(chunk, buf.length);
      buf = merged;

      // A WebSocket frame may hold several MQTT packets, or part of one.
      for (;;) {
        if (buf.length < 2) break;
        let len = 0;
        let mult = 1;
        let i = 1;
        let complete = false;
        while (i < buf.length && i <= 4) {
          const d = buf[i++];
          len += (d & 127) * mult;
          mult *= 128;
          if (!(d & 128)) {
            complete = true;
            break;
          }
        }
        if (!complete || buf.length < i + len) break;
        const type = buf[0] >> 4;
        const qos = (buf[0] >> 1) & 3;
        const body = buf.subarray(i, i + len);
        buf = buf.slice(i + len);
        handle(type, qos, body);
      }
    };

    function handle(type, qos, body) {
      if (type === 2) {
        // CONNACK
        if (body[1] !== 0) return fail(new Error(`refused (${body[1]})`));
        settled = true;
        clearTimeout(timer);
        client.connected = true;
        pinger = setInterval(() => send(new Uint8Array([0xc0, 0])), (keepalive * 1000) / 2);
        resolve(client);
      } else if (type === 3) {
        // PUBLISH
        const tlen = (body[0] << 8) | body[1];
        const topic = dec.decode(body.subarray(2, 2 + tlen));
        const payload = dec.decode(body.subarray(2 + tlen + (qos > 0 ? 2 : 0)));
        for (const fn of messageHandlers) fn(topic, payload);
      }
      // SUBACK (9) and PINGRESP (13) need no handling.
    }
  });
}
