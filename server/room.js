import { randomUUID } from 'node:crypto';
import { countFace, isValidBid, minQty, rollDice } from '../public/rules.js';
import { decide, BOT_NAMES } from './bot.js';

export const MAX_PLAYERS = 8;
export const AVATARS = ['🦙', '🦜', '🐸', '🐙', '🦊', '🐼', '🦖', '🐌', '🦩', '🌵', '🌶️', '👽', '🐧', '🦔', '🐝', '🍄'];

const DEFAULT_TIMING = {
  botMin: 1100, // bots "think" for a random time in [botMin, botMax]
  botMax: 2600,
  afk: 40000, // a disconnected player's turn is auto-played after this
  reveal: 20000, // the reveal screen auto-advances after this
};

export class GameError extends Error {}
const fail = (msg) => {
  throw new GameError(msg);
};

export class Room {
  constructor(code, { onChange = () => {}, timing = {}, rng = Math.random } = {}) {
    this.code = code;
    this.onChange = onChange;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.rng = rng;
    this.players = [];
    this.hostId = null;
    this.phase = 'lobby'; // lobby | bidding | reveal | gameover
    this.settings = { startDice: 5, calza: true, palifico: true };
    this.round = null;
    this.result = null;
    this.winnerId = null;
    this.ready = new Set();
    this.timer = null;
    this.lastActivity = Date.now();
  }

  // ---------- players ----------

  addPlayer({ name, avatar, isBot = false }) {
    if (this.phase !== 'lobby') fail('That game has already started.');
    if (this.players.length >= MAX_PLAYERS) fail('That room is full.');
    const player = {
      id: randomUUID().slice(0, 8),
      token: randomUUID(),
      name: cleanName(name) || 'Mystery Guest',
      avatar: AVATARS.includes(avatar) ? avatar : AVATARS[this.players.length % AVATARS.length],
      isBot,
      connected: isBot,
      left: false,
      diceCount: 0,
      dice: [],
      palificoUsed: false,
    };
    this.players.push(player);
    if (!this.hostId && !isBot) this.hostId = player.id;
    this.changed();
    return player;
  }

  addBot(byId) {
    this.requireHost(byId);
    const taken = new Set(this.players.map((p) => p.name));
    const name = BOT_NAMES.find((n) => !taken.has(n)) || `Bot ${this.players.length + 1}`;
    const usedAvatars = new Set(this.players.map((p) => p.avatar));
    const avatar = AVATARS.find((a) => !usedAvatars.has(a)) || '🤖';
    return this.addPlayer({ name, avatar, isBot: true });
  }

  kick(byId, targetId) {
    this.requireHost(byId);
    if (this.phase !== 'lobby') fail('You can only kick players in the lobby.');
    if (targetId === byId) fail("You can't kick yourself.");
    const target = this.player(targetId);
    if (!target) fail('No such player.');
    this.players = this.players.filter((p) => p !== target);
    this.changed();
    return target;
  }

  setConnected(id, connected) {
    const p = this.player(id);
    if (!p || p.isBot) return;
    p.connected = connected;
    if (connected && !this.player(this.hostId)) this.hostId = id;
    this.changed();
  }

  leave(id) {
    const p = this.player(id);
    if (!p) return;
    if (this.phase === 'lobby') {
      this.players = this.players.filter((x) => x !== p);
    } else {
      p.left = true;
      p.connected = false;
      p.diceCount = 0;
      p.dice = [];
      this.ready.delete(id);
      if (this.phase === 'bidding') {
        if (this.activePlayers().length <= 1) this.endGame();
        else if (this.currentPlayer() === p) this.round.turn = this.nextActive(this.round.turn);
      } else if (this.phase === 'reveal' && this.activePlayers().length <= 1) {
        this.result.gameOver = true;
        this.winnerId = this.activePlayers()[0]?.id ?? null;
      }
    }
    if (this.hostId === id) this.reassignHost();
    this.changed();
  }

  reassignHost() {
    const next =
      this.players.find((p) => !p.isBot && !p.left && p.connected) ||
      this.players.find((p) => !p.isBot && !p.left);
    this.hostId = next ? next.id : null;
  }

  humans() {
    return this.players.filter((p) => !p.isBot && !p.left);
  }

  isAbandoned() {
    return !this.humans().some((p) => p.connected);
  }

  updateSettings(byId, s) {
    this.requireHost(byId);
    if (this.phase !== 'lobby') fail('Settings are locked once the game starts.');
    if (s.startDice !== undefined) {
      const n = Number(s.startDice);
      if (!Number.isInteger(n) || n < 1 || n > 6) fail('Starting dice must be 1–6.');
      this.settings.startDice = n;
    }
    if (s.calza !== undefined) this.settings.calza = !!s.calza;
    if (s.palifico !== undefined) this.settings.palifico = !!s.palifico;
    this.changed();
  }

  // ---------- game flow ----------

  start(byId) {
    this.requireHost(byId);
    if (this.phase !== 'lobby') fail('The game is already running.');
    if (this.players.length < 2) fail('You need at least 2 players (add a bot!).');
    for (const p of this.players) {
      p.diceCount = this.settings.startDice;
      p.palificoUsed = false;
    }
    this.winnerId = null;
    this.result = null;
    this.startRound(Math.floor(this.rng() * this.players.length), false);
  }

  startRound(starterIdx, palifico) {
    for (const p of this.players) p.dice = rollDice(p.diceCount, this.rng).sort((a, b) => a - b);
    const prevNumber = this.round?.number ?? 0;
    const starter = this.players[starterIdx]?.diceCount > 0 ? starterIdx : this.nextActive(starterIdx);
    this.round = { number: prevNumber + 1, turn: starter, starter, bid: null, palifico, history: [] };
    this.phase = 'bidding';
    this.ready.clear();
    this.changed();
  }

  bid(id, qty, face) {
    const p = this.requireTurn(id);
    const bid = { qty: Number(qty), face: Number(face) };
    if (!isValidBid(this.round.bid, bid, this.totalDice(), this.bidCtx(p))) {
      fail(this.explainBadBid(p, bid));
    }
    this.round.bid = { ...bid, by: p.id };
    this.round.history.push({ ...bid, by: p.id });
    this.round.turn = this.nextActive(this.round.turn);
    this.changed();
  }

  dudo(id) {
    const p = this.requireTurn(id);
    const bid = this.round.bid;
    if (!bid) fail('There is no bid to doubt yet.');
    const count = this.count(bid.face);
    const bidder = this.player(bid.by);
    const bidHolds = count >= bid.qty;
    const loser = bidHolds ? p : bidder;
    this.resolve({ type: 'dudo', callerId: p.id, bidderId: bid.by, bid, count, success: !bidHolds, loserId: loser.id });
  }

  calza(id) {
    if (!this.settings.calza) fail('Calza is switched off in this game.');
    if (this.phase !== 'bidding') fail('Not now!');
    const p = this.player(id);
    if (!p || p.diceCount === 0) fail("You're out of this game.");
    const bid = this.round.bid;
    if (!bid) fail('There is no bid to call yet.');
    if (bid.by === id) fail("You can't calza your own bid.");
    const count = this.count(bid.face);
    const exact = count === bid.qty;
    this.resolve({
      type: 'calza', callerId: id, bidderId: bid.by, bid, count, success: exact,
      loserId: exact ? null : id,
      gainerId: exact && p.diceCount < this.settings.startDice ? id : null,
    });
  }

  resolve(result) {
    result.dice = Object.fromEntries(this.players.filter((p) => p.diceCount > 0).map((p) => [p.id, p.dice]));
    result.palifico = this.round.palifico;
    if (result.loserId) {
      const loser = this.player(result.loserId);
      loser.diceCount = Math.max(0, loser.diceCount - 1);
      result.eliminated = loser.diceCount === 0;
    }
    if (result.gainerId) this.player(result.gainerId).diceCount += 1;
    const actives = this.activePlayers();
    result.gameOver = actives.length <= 1;
    if (result.gameOver) this.winnerId = actives[0]?.id ?? null;
    this.result = result;
    this.phase = 'reveal';
    this.ready.clear();
    this.changed();
  }

  markReady(id) {
    if (this.phase !== 'reveal') return;
    if (!this.player(id)) return;
    this.ready.add(id);
    const waiting = this.humans().filter((p) => p.connected && !this.ready.has(p.id));
    if (waiting.length === 0) this.advance();
    else this.changed();
  }

  advance() {
    if (this.phase !== 'reveal') return;
    const r = this.result;
    if (r.gameOver) return this.endGame();
    const nextStarterId = r.loserId || r.callerId;
    const idx = this.players.findIndex((p) => p.id === nextStarterId);
    const starter = this.players[idx];
    let palifico = false;
    if (this.settings.palifico && starter.diceCount === 1 && !starter.palificoUsed && r.loserId === starter.id &&
        this.activePlayers().length > 2) {
      starter.palificoUsed = true;
      palifico = true;
    }
    this.startRound(idx, palifico);
  }

  endGame() {
    this.phase = 'gameover';
    this.winnerId = this.activePlayers()[0]?.id ?? this.winnerId;
    this.changed();
  }

  backToLobby(byId) {
    this.requireHost(byId);
    if (this.phase !== 'gameover') fail('Finish the game first.');
    this.players = this.players.filter((p) => !p.left);
    for (const p of this.players) {
      p.diceCount = 0;
      p.dice = [];
    }
    this.phase = 'lobby';
    this.round = null;
    this.result = null;
    this.changed();
  }

  // ---------- automation (bots, AFK players, reveal timeout) ----------

  changed() {
    this.lastActivity = Date.now();
    this.schedule();
    this.onChange(this);
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.phase === 'bidding') {
      const p = this.currentPlayer();
      if (p.isBot) {
        const { botMin, botMax } = this.timing;
        this.timer = setTimeout(() => this.autoplay(p.id), botMin + this.rng() * (botMax - botMin));
      } else if (!p.connected) {
        this.timer = setTimeout(() => this.autoplay(p.id), this.timing.afk);
      }
    } else if (this.phase === 'reveal') {
      this.timer = setTimeout(() => this.advance(), this.timing.reveal);
    }
    this.timer?.unref?.();
  }

  autoplay(id) {
    if (this.phase !== 'bidding' || this.currentPlayer()?.id !== id) return;
    const p = this.player(id);
    const move = decide({
      myDice: p.dice,
      totalDice: this.totalDice(),
      bid: this.round.bid,
      palifico: this.round.palifico,
      calzaAllowed: this.settings.calza && !!this.round.bid,
      rng: this.rng,
    });
    try {
      if (move.type === 'bid') this.bid(id, move.qty, move.face);
      else if (move.type === 'calza') this.calza(id);
      else this.dudo(id);
    } catch {
      if (this.round.bid) this.dudo(id);
    }
  }

  destroy() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  // ---------- helpers ----------

  player(id) {
    return this.players.find((p) => p.id === id);
  }

  playerByToken(token) {
    return this.players.find((p) => p.token === token && !p.isBot);
  }

  activePlayers() {
    return this.players.filter((p) => p.diceCount > 0);
  }

  currentPlayer() {
    return this.round ? this.players[this.round.turn] : null;
  }

  nextActive(idx) {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const j = (idx + i) % n;
      if (this.players[j].diceCount > 0) return j;
    }
    return idx;
  }

  totalDice() {
    return this.players.reduce((s, p) => s + p.diceCount, 0);
  }

  count(face) {
    return countFace(this.players.flatMap((p) => p.dice), face, this.round.palifico);
  }

  bidCtx(p) {
    return { palifico: this.round.palifico, canChangeFace: p.diceCount === 1 };
  }

  // The host keeps their crown through a flaky connection, but if they've
  // gone quiet anyone still here can take over rather than being stuck.
  requireHost(id) {
    if (id === this.hostId) return;
    const host = this.player(this.hostId);
    const me = this.player(id);
    if ((!host || !host.connected || host.left) && me && !me.isBot && me.connected) {
      this.hostId = id;
      return;
    }
    fail('Only the host can do that.');
  }

  requireTurn(id) {
    if (this.phase !== 'bidding') fail('Not now!');
    if (this.currentPlayer()?.id !== id) fail("Hold your llamas — it's not your turn.");
    return this.currentPlayer();
  }

  explainBadBid(p, bid) {
    const prev = this.round.bid;
    if (bid.qty > this.totalDice()) return `There are only ${this.totalDice()} dice on the table.`;
    const min = minQty(prev, bid.face, this.bidCtx(p));
    if (min === null) {
      if (!prev && bid.face === 1) return "You can't open with aces (except in palifico).";
      if (this.round.palifico) return 'Palifico! The face is locked this round.';
      return 'Invalid face.';
    }
    return `You need at least ${min} × that face.`;
  }

  // What a given player is allowed to see.
  viewFor(viewerId) {
    const showAll = this.phase === 'reveal' || this.phase === 'gameover';
    const revealed = this.result?.dice ?? {};
    return {
      code: this.code,
      you: viewerId,
      hostId: this.hostId,
      phase: this.phase,
      settings: this.settings,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        isBot: p.isBot,
        connected: p.connected,
        left: p.left,
        diceCount: p.diceCount,
        dice: p.id === viewerId && this.phase === 'bidding' ? p.dice : showAll ? revealed[p.id] ?? null : null,
      })),
      round: this.round && {
        number: this.round.number,
        turnId: this.players[this.round.turn]?.id,
        starterId: this.players[this.round.starter]?.id,
        bid: this.round.bid,
        palifico: this.round.palifico,
        history: this.round.history,
        totalDice: this.totalDice(),
      },
      result: showAll ? this.result : null,
      ready: [...this.ready],
      winnerId: this.winnerId,
    };
  }
}

function cleanName(name) {
  return String(name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
}
