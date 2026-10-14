import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createServer } from '../server/index.js';

function client(port) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    inbox.push(msg);
    for (const w of [...waiters]) if (w.pred(msg)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    }
  });
  return {
    ws,
    ready: new Promise((r) => ws.on('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    // Wait for (and consume) the first message matching pred, skipping older ones.
    waitFor: (pred, label = pred.toString()) => {
      const safe = (m) => {
        try {
          return pred(m);
        } catch {
          return false;
        }
      };
      const idx = inbox.findIndex(safe);
      if (idx >= 0) return Promise.resolve(inbox.splice(0, idx + 1).pop());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 3000);
        waiters.push({ pred: safe, resolve: (m) => (clearTimeout(timer), inbox.length = 0, resolve(m)) });
      });
    },
  };
}

test('two phones create, join, start and bid over websockets', async () => {
  const { server } = createServer({ timing: { botMin: 1e9, botMax: 1e9 } });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();

  const res = await fetch(`http://localhost:${port}/`);
  assert.match(await res.text(), /<title>Perudo!<\/title>/);
  assert.equal((await fetch(`http://localhost:${port}/..%2f..%2fpackage.json`)).status, 403);

  const a = client(port);
  const b = client(port);
  await Promise.all([a.ready, b.ready]);

  a.send({ t: 'create', name: 'Ana', avatar: '🦙' });
  const { code } = await a.waitFor((m) => m.t === 'joined');
  b.send({ t: 'join', code, name: 'Ben', avatar: '🐸' });
  const joinedB = await b.waitFor((m) => m.t === 'joined');
  await a.waitFor((m) => m.t === 'state' && m.state.players.length === 2);

  b.send({ t: 'start' });
  assert.match((await b.waitFor((m) => m.t === 'error')).msg, /host/);

  a.send({ t: 'start' });
  const sa = (await a.waitFor((m) => m.t === 'state' && m.state.phase === 'bidding')).state;
  const sb = (await b.waitFor((m) => m.t === 'state' && m.state.phase === 'bidding')).state;
  assert.equal(sa.players[0].dice.length, 5);
  assert.equal(sa.players[1].dice, null);
  assert.equal(sb.players[0].dice, null);

  const turn = sa.round.turnId === sa.you ? a : b;
  turn.send({ t: 'bid', qty: 2, face: 5 });
  const after = (await a.waitFor((m) => m.t === 'state' && m.state.round.bid)).state;
  assert.deepEqual({ qty: after.round.bid.qty, face: after.round.bid.face }, { qty: 2, face: 5 });

  // Ben's phone drops and comes back with his token.
  b.ws.close();
  await a.waitFor((m) => m.t === 'state' && !m.state.players[1].connected);
  const b2 = client(port);
  await b2.ready;
  b2.send({ t: 'resume', code, token: joinedB.token });
  const back = (await b2.waitFor((m) => m.t === 'state')).state;
  assert.equal(back.you, joinedB.id);
  assert.equal(back.players[1].dice.length, 5);

  a.ws.close();
  b2.ws.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
