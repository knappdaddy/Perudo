import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, GameError } from '../public/game/room.js';

// Deterministic RNG so tests are repeatable.
function seeded(seed = 42) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

const NO_TIMERS = { botMin: 1e9, botMax: 1e9, afk: 1e9, reveal: 1e9 };

function setup(n = 3) {
  const room = new Room('TEST', { timing: NO_TIMERS, rng: seeded() });
  const ps = Array.from({ length: n }, (_, i) => room.addPlayer({ name: `P${i}`, avatar: '🦙' }));
  ps.forEach((p) => room.setConnected(p.id, true));
  return { room, ps };
}

const forceDice = (room, hands) => room.players.forEach((p, i) => (p.dice = hands[i]));

test('first player is host and only host can start', () => {
  const { room, ps } = setup();
  assert.equal(room.hostId, ps[0].id);
  assert.throws(() => room.start(ps[1].id), GameError);
  room.start(ps[0].id);
  assert.equal(room.phase, 'bidding');
  assert.ok(room.players.every((p) => p.dice.length === 5));
  room.destroy();
});

test('turn order, bid validation and a losing dudo', () => {
  const { room } = setup();
  room.start(room.hostId);
  room.round.turn = 0;
  forceDice(room, [[2, 2, 3, 4, 5], [1, 2, 6, 6, 6], [3, 3, 3, 4, 4]]);
  const [a, b, c] = room.players;

  assert.throws(() => room.bid(b.id, 2, 2), /not your turn/);
  assert.throws(() => room.bid(a.id, 2, 1), /aces/);
  room.bid(a.id, 3, 2);
  assert.throws(() => room.bid(b.id, 3, 2), GameError);
  room.bid(b.id, 3, 6);
  // There are 3 sixes + 1 ace = 4 ≥ 3, so c's dudo fails and c loses a die.
  room.dudo(c.id);
  assert.equal(room.phase, 'reveal');
  assert.equal(room.result.count, 4);
  assert.equal(room.result.loserId, c.id);
  assert.equal(c.diceCount, 4);

  // Everyone ready → next round, loser starts.
  room.players.forEach((p) => room.markReady(p.id));
  assert.equal(room.phase, 'bidding');
  assert.equal(room.currentPlayer().id, c.id);
  assert.equal(c.dice.length, 4);
  room.destroy();
});

test('successful calza wins a die back (capped at start count)', () => {
  const { room } = setup();
  room.start(room.hostId);
  room.round.turn = 0;
  const [a, b, c] = room.players;
  c.diceCount = 3;
  forceDice(room, [[4, 4, 2, 2, 2], [1, 5, 5, 6, 6], [4, 3, 3]]);
  room.bid(a.id, 4, 4); // 4s: three 4s + one ace = 4
  room.calza(c.id); // not c's turn — calza is allowed anyway
  assert.equal(room.result.success, true);
  assert.equal(c.diceCount, 4);
  assert.equal(b.diceCount, 5);
  room.destroy();
});

test('bidder cannot calza their own bid', () => {
  const { room } = setup();
  room.start(room.hostId);
  room.round.turn = 0;
  const [a] = room.players;
  room.bid(a.id, 2, 3);
  assert.throws(() => room.calza(a.id), /own bid/);
  room.destroy();
});

test('dropping to one die triggers palifico, once', () => {
  const { room } = setup();
  room.start(room.hostId);
  room.round.turn = 0;
  const [a, b] = room.players;
  a.diceCount = 2;
  forceDice(room, [[2, 3], [4, 4, 4, 4, 4], [5, 5, 5, 5, 5]]);
  room.bid(a.id, 9, 2); // there are only 1-ish 2s
  room.dudo(b.id);
  assert.equal(room.result.loserId, a.id);
  room.advance();
  assert.equal(room.round.palifico, true);
  assert.equal(room.currentPlayer().id, a.id);
  // In palifico the opener may bid aces.
  room.bid(a.id, 1, 1);
  room.destroy();
});

test('leaving mid-game passes the turn, last one standing wins', () => {
  const { room, ps } = setup(2);
  room.start(room.hostId);
  room.round.turn = 0;
  room.leave(ps[0].id);
  assert.equal(room.phase, 'gameover');
  assert.equal(room.winnerId, ps[1].id);
  room.destroy();
});

test("other players' dice are hidden until the reveal", () => {
  const { room, ps } = setup();
  room.start(room.hostId);
  const view = room.viewFor(ps[0].id);
  assert.equal(view.players[0].dice.length, 5);
  assert.equal(view.players[1].dice, null);
  assert.equal(view.players[2].dice, null);
  room.destroy();
});

test('a table of bots plays a full game to the end', async () => {
  const room = new Room('BOTS', { timing: { botMin: 0, botMax: 1, afk: 1, reveal: 1 }, rng: seeded(7) });
  const host = room.addPlayer({ name: 'Host' });
  room.setConnected(host.id, true);
  for (let i = 0; i < 4; i++) room.addBot(host.id);
  room.start(host.id);
  room.setConnected(host.id, false); // the host goes AFK, autopilot takes over

  const deadline = Date.now() + 20000;
  while (room.phase !== 'gameover' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  assert.equal(room.phase, 'gameover');
  assert.equal(room.activePlayers().length, 1);
  assert.equal(room.winnerId, room.activePlayers()[0].id);
  room.destroy();
});
