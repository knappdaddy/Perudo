// Routes messages between connected clients and rooms. Transport-agnostic:
// the Node server feeds it WebSockets, and in relay mode the host's
// browser feeds it messages relayed over MQTT. A client is anything shaped like
// { send(msg), close(), open }.
import { Room, GameError } from './room.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O — too easy to misread
export const EMOTES = ['😂', '🤥', '🤨', '🔥', '😱', '🦙', '👏', '💀'];

export function randomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}

export function createHub({ timing, newCode, canCreate = () => true, onRoomChange = () => {} } = {}) {
  const rooms = new Map();

  const send = (client, msg) => client?.open && client.send(msg);

  const broadcast = (room) => {
    for (const p of room.players) send(p.client, { t: 'state', state: room.viewFor(p.id) });
    onRoomChange(room);
  };

  const makeCode = () => {
    for (;;) {
      const code = newCode ? newCode() : randomCode();
      if (!rooms.has(code)) return code;
    }
  };

  const attach = (client, room, player) => {
    if (client.ctx && client.ctx.player !== player && client.ctx.player.client === client) {
      client.ctx.player.client = null;
      client.ctx.room.setConnected(client.ctx.player.id, false);
    }
    if (player.client && player.client !== client) {
      send(player.client, { t: 'kicked', msg: 'You joined from another tab.' });
      player.client.close();
    }
    client.ctx = { room, player };
    player.client = client;
    send(client, { t: 'joined', code: room.code, token: player.token, id: player.id });
    room.setConnected(player.id, true);
  };

  function handle(client, msg) {
    switch (msg.t) {
      case 'create': {
        if (!canCreate(client)) throw new GameError('This table is hosted on another phone.');
        const code = makeCode();
        const room = new Room(code, { onChange: broadcast, timing });
        rooms.set(code, room);
        return attach(client, room, room.addPlayer({ name: msg.name, avatar: msg.avatar }));
      }
      case 'join': {
        const room = rooms.get(String(msg.code || '').toUpperCase().trim());
        if (!room) throw new GameError("Can't find that room. Check the code?");
        const existing = msg.token && room.playerByToken(msg.token);
        return attach(client, room, existing || room.addPlayer({ name: msg.name, avatar: msg.avatar }));
      }
      case 'resume': {
        const room = rooms.get(String(msg.code || '').toUpperCase());
        const player = room?.playerByToken(msg.token);
        if (!player || player.left) return send(client, { t: 'gone' });
        return attach(client, room, player);
      }
    }

    if (!client.ctx) throw new GameError('Join a room first.');
    const { room, player } = client.ctx;
    if (player.client !== client) return;
    switch (msg.t) {
      case 'settings': return room.updateSettings(player.id, msg.settings || {});
      case 'addBot': return room.addBot(player.id);
      case 'kick': {
        const target = room.kick(player.id, msg.id);
        if (target.client) {
          send(target.client, { t: 'kicked', msg: 'The host showed you the door.' });
          target.client.ctx = null;
          target.client.close();
          target.client = null;
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
        player.client = null;
        client.ctx = null;
        if (room.isAbandoned()) closeRoom(room.code);
        return;
      }
      case 'emote': {
        const now = Date.now();
        if (now - (client.lastEmote || 0) < 700) return;
        client.lastEmote = now;
        if (!EMOTES.includes(msg.e)) return;
        for (const p of room.players) send(p.client, { t: 'emote', from: player.id, e: msg.e });
        return;
      }
    }
  }

  function receive(client, msg) {
    if (!msg || typeof msg !== 'object') return;
    try {
      handle(client, msg);
    } catch (err) {
      if (err instanceof GameError) send(client, { t: 'error', msg: err.message });
      else {
        console.error(err);
        send(client, { t: 'error', msg: 'Something went wobbly. Try again?' });
      }
    }
  }

  function disconnect(client) {
    client.open = false;
    const { room, player } = client.ctx || {};
    if (room && player?.client === client) {
      player.client = null;
      room.setConnected(player.id, false);
    }
  }

  function restore(snapshot) {
    const room = Room.restore(snapshot, { onChange: broadcast, timing });
    rooms.set(room.code, room);
    return room;
  }

  function closeRoom(code, msg) {
    const room = rooms.get(code);
    if (!room) return;
    for (const p of room.players) {
      if (!p.client) continue;
      if (msg) send(p.client, { t: 'kicked', msg });
      p.client.ctx = null;
      p.client = null;
    }
    room.destroy();
    rooms.delete(code);
  }

  function sweep(idleMs) {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.isAbandoned() && now - room.lastActivity > idleMs) closeRoom(code);
    }
  }

  function destroyAll() {
    for (const room of rooms.values()) room.destroy();
    rooms.clear();
  }

  return { rooms, receive, disconnect, restore, closeRoom, sweep, destroyAll };
}
