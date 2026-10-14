import { minQty } from './rules.js';

const AVATARS = ['🦙', '🦜', '🐸', '🐙', '🦊', '🐼', '🦖', '🐌', '🦩', '🌵', '🌶️', '👽', '🐧', '🦔', '🐝', '🍄'];
const EMOTES = ['😂', '🤥', '🤨', '🔥', '😱', '🦙', '👏', '💀'];
const SEAT_COLORS = ['#ffbe0b', '#ff5c8a', '#18c6b3', '#b8f13c', '#6ec5ff', '#c9a7ff', '#ff9f43', '#7bed9f'];
const PIPS = { 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

const $app = document.getElementById('app');
const $toasts = document.getElementById('toasts');
const $conn = document.getElementById('conn');

// ---------- persistence ----------

const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem('perudo:' + k);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      if (v === null) localStorage.removeItem('perudo:' + k);
      else localStorage.setItem('perudo:' + k, JSON.stringify(v));
    } catch {}
  },
};

const me = {
  name: store.get('name', ''),
  avatar: store.get('avatar', AVATARS[Math.floor(Math.random() * AVATARS.length)]),
};
let session = store.get('session', null); // { code, token }
let state = null;
const ui = {
  joinCode: '',
  pick: null,
  pickKey: null,
  hideDice: store.get('hideDice', false),
  muted: store.get('muted', false),
  confirm: null,
  confirmTimer: null,
  rolledRound: null,
  revealKey: null,
  myTurnKey: null,
  modal: null, // 'rules'
  wasWinner: null,
};

// ---------- networking ----------

let ws = null;
let retry = 0;
let outbox = [];

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 0;
    $conn.hidden = true;
    if (session) ws.send(JSON.stringify({ t: 'resume', ...session }));
    for (const m of outbox) ws.send(JSON.stringify(m));
    outbox = [];
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onclose = () => {
    if (state) $conn.hidden = false;
    setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else {
    outbox.push(msg);
    connect();
  }
}

function onMessage(msg) {
  switch (msg.t) {
    case 'joined':
      session = { code: msg.code, token: msg.token };
      store.set('session', session);
      history.replaceState(null, '', `/?room=${msg.code}`);
      break;
    case 'state': {
      const prev = state;
      state = msg.state;
      effects(prev, state);
      render();
      break;
    }
    case 'error':
      toast(msg.msg);
      break;
    case 'gone':
    case 'kicked':
      if (msg.t === 'kicked' || state) toast(msg.msg || 'That game is over — start a new one!');
      leaveLocal();
      break;
    case 'emote':
      floatEmote(msg.from, msg.e);
      break;
  }
}

function leaveLocal() {
  session = null;
  store.set('session', null);
  state = null;
  history.replaceState(null, '', '/');
  render();
}

// Sounds, buzzes and screen wake-lock when the game changes under us.
function effects(prev, next) {
  const myTurn = next.phase === 'bidding' && next.round.turnId === next.you;
  const turnKey = myTurn ? `${next.round.number}:${next.round.history.length}` : null;
  if (turnKey && turnKey !== ui.myTurnKey) {
    sfx.turn();
    navigator.vibrate?.([60, 40, 60]);
  }
  ui.myTurnKey = turnKey;
  if (next.phase === 'bidding' && prev?.round?.number !== next.round.number) sfx.roll();
  if (next.phase === 'reveal' && prev?.phase !== 'reveal') {
    sfx.call(next.result.type);
    navigator.vibrate?.(120);
  }
  if (next.phase !== 'lobby') wakeLock();
}

// ---------- actions ----------

const actions = {
  avatar: (el) => {
    me.avatar = el.dataset.v;
    store.set('avatar', me.avatar);
    render();
  },
  create: () => {
    if (!checkName()) return;
    send({ t: 'create', name: me.name, avatar: me.avatar });
  },
  join: () => {
    if (!checkName()) return;
    const code = ui.joinCode.trim().toUpperCase();
    if (code.length !== 4) return toast('Room codes are 4 letters.');
    send({ t: 'join', code, name: me.name, avatar: me.avatar });
  },
  rules: () => {
    ui.modal = 'rules';
    render();
  },
  closeModal: () => {
    ui.modal = null;
    render();
  },
  share: async () => {
    const url = `${location.origin}/?room=${state.code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Perudo!', text: `Come lie to me. Room ${state.code} 🎲`, url });
      else {
        await navigator.clipboard.writeText(url);
        toast('Invite link copied! 📋');
      }
    } catch {}
  },
  addBot: () => send({ t: 'addBot' }),
  kick: (el) => send({ t: 'kick', id: el.dataset.id }),
  setting: (el) => {
    const key = el.dataset.k;
    let v;
    if (key === 'startDice') v = state.settings.startDice + Number(el.dataset.d);
    else v = !state.settings[key];
    send({ t: 'settings', settings: { [key]: v } });
  },
  start: () => send({ t: 'start' }),
  face: (el) => {
    const face = Number(el.dataset.f);
    const min = minQty(state.round.bid, face, bidCtx());
    ui.pick = { face, qty: Math.max(min, ui.pick?.qty ?? min) };
    if (state.round.bid && (face === 1) !== (state.round.bid.face === 1)) ui.pick.qty = min;
    render();
  },
  qty: (el) => {
    ui.pick.qty += Number(el.dataset.d);
    render();
  },
  bid: () => send({ t: 'bid', qty: ui.pick.qty, face: ui.pick.face }),
  dudo: () => confirmThen('dudo', () => send({ t: 'dudo' })),
  calza: () => confirmThen('calza', () => send({ t: 'calza' })),
  hide: () => {
    ui.hideDice = !ui.hideDice;
    store.set('hideDice', ui.hideDice);
    render();
  },
  emote: (el) => send({ t: 'emote', e: el.dataset.e }),
  ready: () => send({ t: 'ready' }),
  lobby: () => send({ t: 'lobby' }),
  mute: () => {
    ui.muted = !ui.muted;
    store.set('muted', ui.muted);
    render();
  },
  leave: () => {
    const msg = state?.phase === 'lobby' || state?.phase === 'gameover'
      ? 'Leave this room?'
      : 'Leave the game? Your dice go back in the bag for good.';
    if (!confirm(msg)) return;
    send({ t: 'leave' });
    leaveLocal();
  },
};

function confirmThen(key, fn) {
  clearTimeout(ui.confirmTimer);
  if (ui.confirm === key) {
    ui.confirm = null;
    fn();
  } else {
    ui.confirm = key;
    ui.confirmTimer = setTimeout(() => {
      ui.confirm = null;
      render();
    }, 2500);
  }
  render();
}

function checkName() {
  me.name = me.name.trim();
  if (!me.name) {
    toast('First, what should we call you?');
    document.querySelector('[name=name]')?.focus();
    return false;
  }
  store.set('name', me.name);
  return true;
}

$app.addEventListener('click', (e) => {
  sfx.unlock();
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  if ('self' in el.dataset && e.target !== el) return;
  actions[el.dataset.act]?.(el);
});
$app.addEventListener('input', (e) => {
  if (e.target.name === 'name') me.name = e.target.value;
  if (e.target.name === 'code') {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
    ui.joinCode = e.target.value;
  }
});
$app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.name === 'code') actions.join();
  if (e.target.name === 'name') ui.joinCode.length === 4 ? actions.join() : actions.create();
});

// ---------- rendering ----------

function render() {
  const view = !state ? homeView() : { lobby: lobbyView, bidding: gameView, reveal: gameView, gameover: gameoverView }[state.phase]();
  const modal = ui.modal === 'rules' ? rulesModal() : '';
  $app.innerHTML = view + modal;
  if (state?.phase === 'lobby') drawQR();
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const P = (id) => state.players.find((p) => p.id === id);
const color = (id) => SEAT_COLORS[Math.max(0, state.players.findIndex((p) => p.id === id)) % SEAT_COLORS.length];
const ava = (p, cls = '') => `<div class="ava ${cls}" style="--c:${color(p.id)}">${p.avatar}</div>`;
const amHost = () => state.hostId === state.you;

function die(face, cls = '', i = 0) {
  if (face === 1) return `<div class="die ace ${cls}" style="--i:${i}"><i class="llama">🦙</i></div>`;
  const on = PIPS[face] || [];
  let pips = '';
  for (let k = 0; k < 9; k++) pips += `<i class="${on.includes(k) ? 'p' : ''}"></i>`;
  return `<div class="die ${cls}" style="--i:${i}">${pips}</div>`;
}

function logo() {
  const colors = ['#ff5c8a', '#ffbe0b', '#18c6b3', '#b8f13c', '#6ec5ff', '#ff5c8a'];
  return `<h1 class="logo" aria-label="Perudo">${[...'PERUDO']
    .map((ch, i) => `<span style="--c:${colors[i]};--i:${i}">${ch}</span>`)
    .join('')}</h1>`;
}

function homeView() {
  const params = new URLSearchParams(location.search);
  if (!ui.joinCode && params.get('room')) ui.joinCode = params.get('room').toUpperCase().slice(0, 4);
  const invited = !!ui.joinCode && params.get('room');
  return `
    <div class="mascot" aria-hidden="true"><span>🎲</span><span>🦙</span><span>🎲</span></div>
    ${logo()}
    <p class="tagline">Liar's dice for <b>liars</b> &amp; <b>llamas</b>.</p>

    <section class="card tilt-l stack">
      <label class="label" for="name">Your name</label>
      <input class="field" id="name" name="name" maxlength="16" autocomplete="nickname" placeholder="e.g. Sneaky Pete" value="${esc(me.name)}">
      <span class="label" style="margin-top:14px">Pick your critter</span>
      <div class="avatars">${AVATARS.map((a) => `<button data-act="avatar" data-v="${a}" class="${a === me.avatar ? 'on' : ''}" aria-label="avatar ${a}">${a}</button>`).join('')}</div>
    </section>

    ${invited ? '' : `
    <section class="card tilt-r">
      <h2>Start a table</h2>
      <button class="btn pink big block" data-act="create">🎲 New room</button>
    </section>`}

    <section class="card ${invited ? 'tilt-r' : 'tilt-l'}">
      <h2>${invited ? "You've been invited!" : 'Got a code?'}</h2>
      <div class="row">
        <input class="field code grow" name="code" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="ABCD" value="${esc(ui.joinCode)}">
        <button class="btn teal" data-act="join">Join →</button>
      </div>
      ${invited ? `<p class="small muted center" style="margin:12px 0 0">…or <a href="/" onclick="history.replaceState(null,'','/')">start your own room</a></p>` : ''}
    </section>

    <p class="center"><button class="btn paper sm" data-act="rules">📜 How to play</button></p>
  `;
}

function topbar(extra = '') {
  return `
    <div class="topbar">
      <span class="chip mango">ROOM ${state.code}</span>
      ${extra}
      <span class="grow"></span>
      <button class="iconbtn" data-act="rules" aria-label="Rules">📜</button>
      <button class="iconbtn" data-act="mute" aria-label="Sound">${ui.muted ? '🔇' : '🔊'}</button>
      <button class="iconbtn" data-act="leave" aria-label="Leave">🚪</button>
    </div>`;
}

function lobbyView() {
  const host = amHost();
  const s = state.settings;
  const tileColors = ['#ff5c8a', '#ffbe0b', '#18c6b3', '#b8f13c'];
  return `
    ${topbar()}
    ${logo().replace('class="logo"', 'class="logo" style="font-size:44px;margin:4px 0"')}
    <section class="card tilt-r center">
      <h2>Room code</h2>
      <div class="codebox">${[...state.code].map((c, i) => `<span style="--c:${tileColors[i]}">${c}</span>`).join('')}</div>
      <div class="qr" id="qr" hidden></div>
      <button class="btn sky block" data-act="share">📣 Invite your friends</button>
    </section>

    <section class="card tilt-l">
      <h2>Players (${state.players.length}/8)</h2>
      <ul class="plist">
        ${state.players.map((p) => `
          <li>
            ${ava(p, 'sm')}
            <span class="nm">${esc(p.name)}${p.id === state.you ? ' <span class="chip pink">you</span>' : ''}</span>
            ${p.id === state.hostId ? '<span class="chip mango">👑 host</span>' : ''}
            ${p.isBot ? '<span class="chip teal">🤖 bot</span>' : ''}
            ${!p.isBot && !p.connected ? '<span class="chip">💤</span>' : ''}
            ${host && p.id !== state.you ? `<button class="kick" data-act="kick" data-id="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button>` : ''}
          </li>`).join('')}
      </ul>
      ${host && state.players.length < 8 ? `<button class="btn ghost sm" data-act="addBot" style="margin-top:8px">+ Add a bot 🤖</button>` : ''}
    </section>

    <section class="card tilt-r">
      <h2>House rules</h2>
      <div class="setting">
        <div class="grow"><b>Dice each</b><small>Classic is 5</small></div>
        <div class="stepper">
          <button data-act="setting" data-k="startDice" data-d="-1" ${!host || s.startDice <= 1 ? 'disabled' : ''}>–</button>
          <output>${s.startDice}</output>
          <button data-act="setting" data-k="startDice" data-d="1" ${!host || s.startDice >= 6 ? 'disabled' : ''}>+</button>
        </div>
      </div>
      <div class="setting">
        <div class="grow"><b>Calza</b><small>Call “exactly right” to win a die back</small></div>
        <button class="toggle ${s.calza ? 'on' : ''}" data-act="setting" data-k="calza" ${host ? '' : 'disabled'} aria-label="Calza"></button>
      </div>
      <div class="setting">
        <div class="grow"><b>Palifico</b><small>Special round when someone hits 1 die</small></div>
        <button class="toggle ${s.palifico ? 'on' : ''}" data-act="setting" data-k="palifico" ${host ? '' : 'disabled'} aria-label="Palifico"></button>
      </div>
    </section>

    <div class="dock">
      ${host
        ? `<button class="btn pink big block" data-act="start" ${state.players.length < 2 ? 'disabled' : ''}>${state.players.length < 2 ? 'Need 2+ players' : '🎲 Roll the bones!'}</button>`
        : `<div class="who">Waiting for ${esc(P(state.hostId)?.name ?? 'the host')} to start… ⏳</div>`}
    </div>
  `;
}

function bidCtx() {
  const mine = P(state.you);
  return { palifico: state.round.palifico, canChangeFace: mine.diceCount === 1 };
}

function seatsView() {
  const r = state.round;
  const lastBy = {};
  for (const h of r.history) lastBy[h.by] = h;
  const showTurn = state.phase === 'bidding';
  return `<div class="seats">${state.players.map((p) => {
    const out = p.diceCount === 0;
    const said = lastBy[p.id] && showTurn ? `<span class="said">${lastBy[p.id].qty}×${die(lastBy[p.id].face, 'xs')}</span>` : '';
    const cups = out ? (p.left ? '<span class="small">left 👋</span>' : '<span class="small">out 💀</span>')
      : Array.from({ length: Math.max(p.diceCount, state.settings.startDice) }, (_, i) => `<i class="${i < p.diceCount ? '' : 'gone'}"></i>`).join('');
    const cls = [showTurn && r.turnId === p.id && 'turn', p.id === state.you && 'me', out && 'out', !p.isBot && !p.connected && !p.left && 'away'].filter(Boolean).join(' ');
    return `<div class="seat ${cls}" data-pid="${p.id}">${said}${ava(p)}<div class="nm">${esc(p.name)}</div><div class="cups">${cups}</div></div>`;
  }).join('')}</div>`;
}

function gameView() {
  const r = state.round;
  const mine = P(state.you);
  const bid = r.bid;
  const starter = P(r.starterId);
  const myTurn = state.phase === 'bidding' && r.turnId === state.you;

  const table = bid
    ? `<div class="label">Current bid</div>
       <div class="bidline">${bid.qty}<span class="x">×</span>${die(bid.face, 'lg')}</div>
       <div class="bidby">by ${esc(P(bid.by)?.name)} · ${r.totalDice} dice in play</div>`
    : `<div class="label">Round ${r.number}</div>
       <div class="fresh">${starter?.id === state.you ? 'You open the bidding!' : `${esc(starter?.name)} opens…`}</div>
       <div class="bidby">${r.totalDice} dice in play · 🦙 aces are ${r.palifico ? '<u>not</u> ' : ''}wild</div>`;

  const pali = r.palifico ? `
    <div class="palibanner"><b>🌶️ Palifico round!</b>
      ${esc(starter?.name)} is down to one die. Aces aren't wild, and once the face is set it's locked${mine.diceCount === 1 ? ' — except for you, one-dicer!' : '.'}
    </div>` : '';

  // While bidding, your dice live in the dock so they're always on screen next to the controls.
  const hand = mine.diceCount === 0 && state.phase === 'bidding'
    ? `<section class="card hand center"><b>👻 You're out of dice — enjoy the show.</b></section>`
    : '';

  const log = r.history.length ? `
    <section class="card">
      <details>
        <summary>Bid log (${r.history.length})</summary>
        <ul class="log">${[...r.history].reverse().map((h) => `<li>${ava(P(h.by), 'sm')} ${esc(P(h.by)?.name)} <span class="grow"></span> ${h.qty} × ${die(h.face, 'sm')}</li>`).join('')}</ul>
      </details>
    </section>` : '';

  return `
    ${topbar(`<span class="chip">Round ${r.number}</span>${r.palifico ? '<span class="chip pink">PALIFICO</span>' : ''}`)}
    ${seatsView()}
    ${pali}
    <section class="card table tilt-r">${table}</section>
    ${hand}
    ${log}
    ${state.phase === 'bidding' ? dockView(myTurn) : ''}
    ${state.phase === 'reveal' ? revealView() : ''}
  `;
}

function myCup() {
  const mine = P(state.you);
  if (mine.diceCount === 0) return '';
  const r = state.round;
  const roll = ui.rolledRound !== r.number;
  if (roll) ui.rolledRound = r.number;
  return `<div class="mycup">
    <span class="label">Your cup</span>
    ${ui.hideDice
      ? `<div class="covered">🥤 ${mine.diceCount} dice hiding</div>`
      : `<div class="dice tight">${(mine.dice || []).map((d, i) => die(d, `md ${roll ? 'rolling' : ''}`, i)).join('')}</div>`}
    <button class="btn sm paper" data-act="hide" aria-label="${ui.hideDice ? 'Show dice' : 'Hide dice'}">${ui.hideDice ? '👀' : '🙈'}</button>
  </div>`;
}

function dockView(myTurn) {
  const r = state.round;
  const mine = P(state.you);
  const bid = r.bid;
  const canCalza = state.settings.calza && bid && bid.by !== state.you && mine.diceCount > 0;
  const emotes = `<div class="emotes">${EMOTES.map((e) => `<button data-act="emote" data-e="${e}">${e}</button>`).join('')}</div>`;
  const calzaBtn = (cls = '') => `<button class="btn teal ${cls} ${ui.confirm === 'calza' ? 'confirm' : ''}" data-act="calza">${ui.confirm === 'calza' ? 'Sure? Tap!' : '🎯 CALZA!'}</button>`;

  if (!myTurn) {
    const who = P(r.turnId);
    return `<div class="dock">
      ${myCup()}
      <div class="who">${mine.diceCount === 0 ? '👻 ' : ''}${esc(who?.name)} is ${who?.isBot ? 'computing lies' : 'thinking'}… 🤔</div>
      ${canCalza ? `<div class="calls one">${calzaBtn()}</div>` : ''}
      ${emotes}
    </div>`;
  }

  const ctx = bidCtx();
  const key = `${r.number}:${r.history.length}`;
  if (ui.pickKey !== key || !ui.pick) {
    ui.pickKey = key;
    ui.pick = defaultPick(bid, ctx, mine.dice || [], r.totalDice);
  }
  const pick = ui.pick;
  const min = pick ? minQty(bid, pick.face, ctx) : null;
  const faces = [1, 2, 3, 4, 5, 6].map((f) => {
    const m = minQty(bid, f, ctx);
    const ok = m !== null && m <= r.totalDice;
    return `<button data-act="face" data-f="${f}" class="${pick?.face === f ? 'on' : ''}" ${ok ? '' : 'disabled'} aria-label="face ${f}">${die(f)}</button>`;
  }).join('');

  let hint = '';
  if (pick && bid && !r.palifico) {
    if (pick.face === 1 && bid.face !== 1) hint = '🦙 Switching to aces: halve the count (round up).';
    else if (pick.face !== 1 && bid.face === 1) hint = '🦙 Leaving aces: double the count, plus one.';
  }
  if (!bid && !r.palifico) hint = "You can't open on aces — they're wild!";

  return `<div class="dock">
    ${myCup()}
    <div class="who">🫵 Your move!${bid ? ` <span class="beat">Beat ${bid.qty} × ${die(bid.face, 'xs')}</span>` : ''}</div>
    ${pick ? `
      <div class="faces">${faces}</div>
      <div class="bidrow">
        <div class="stepper">
          <button data-act="qty" data-d="-1" ${pick.qty <= min ? 'disabled' : ''} aria-label="fewer">–</button>
          <output>${pick.qty}</output>
          <button data-act="qty" data-d="1" ${pick.qty >= r.totalDice ? 'disabled' : ''} aria-label="more">+</button>
        </div>
        <button class="btn pink" data-act="bid">Bid ${pick.qty} × ${die(pick.face, 'xs')}</button>
      </div>` : '<p class="center"><b>No bid can top that. Call it!</b></p>'}
    ${bid ? `<div class="calls ${canCalza ? '' : 'one'}">
      <button class="btn red ${ui.confirm === 'dudo' ? 'confirm' : ''}" data-act="dudo">${ui.confirm === 'dudo' ? 'Sure? Tap!' : '🤥 DUDO!'}</button>
      ${canCalza ? calzaBtn() : ''}
    </div>` : ''}
    <div class="hint">${hint}</div>
  </div>`;
}

// Start the picker on a sensible bid: the minimum raise on whatever face you hold most of.
function defaultPick(bid, ctx, dice, total) {
  const wild = !ctx.palifico;
  let best = null;
  for (const f of [2, 3, 4, 5, 6, 1]) {
    const m = minQty(bid, f, ctx);
    if (m === null || m > total) continue;
    const have = dice.filter((d) => d === f || (wild && f !== 1 && d === 1)).length;
    const score = have * 10 - m * 3 + (bid && f === bid.face ? 2 : 0);
    if (!best || score > best.score) best = { face: f, qty: m, score };
  }
  return best && { face: best.face, qty: best.qty };
}

const LINES = {
  bluff: ['Busted! {b} was bluffing.', 'Liar, liar, poncho on fire! 🔥', '{b} got caught with their hoof in the cup.', 'Nice try, {b}. Nobody believed you.'],
  holds: ['The bid holds! {c} doubted wrong.', 'Oof. {b} was telling the truth!', '{c} smelled a lie that wasn’t there.', 'Honesty pays, {b}. 🦙'],
  calzaWin: ['Bullseye! {c} called it exactly. 🎯', 'Psychic llama alert! 🔮', '{c} counted every pip. Spooky.'],
  calzaLose: ['Not quite, {c}. Close but no cigar.', '{c} swung for exact and missed.', 'The dice gods laugh at {c}.'],
};
const line = (kind, r, n) => LINES[kind][n % LINES[kind].length].replaceAll('{b}', esc(P(r.bidderId)?.name)).replaceAll('{c}', esc(P(r.callerId)?.name));

function revealView() {
  const r = state.result;
  const key = `${state.round.number}`;
  const anim = ui.revealKey !== key;
  ui.revealKey = key;
  const wild = !r.palifico && r.bid.face !== 1;
  const caller = P(r.callerId);
  const bidder = P(r.bidderId);
  const n = state.round.number;

  const rows = state.players.filter((p) => r.dice[p.id]).map((p) => `
    <div class="reveal-row">
      <div class="who">${ava(p, 'sm')}${esc(p.name)}</div>
      <div class="dice tight">${r.dice[p.id].map((d, i) => {
        const hit = d === r.bid.face || (wild && d === 1);
        return die(d, `sm ${hit ? 'hit' : 'miss'} ${anim ? 'pop' : ''}`, i);
      }).join('')}</div>
    </div>`).join('');

  let verdict;
  if (r.type === 'dudo') verdict = r.success ? line('bluff', r, n) : line('holds', r, n);
  else verdict = r.success ? line('calzaWin', r, n) : line('calzaLose', r, n);
  const loser = r.loserId && P(r.loserId);
  const gainer = r.gainerId && P(r.gainerId);
  let consequence = '';
  if (loser) consequence = r.eliminated ? `💀 ${esc(loser.name)} is out of dice!` : `${esc(loser.name)} loses a die.`;
  if (gainer) consequence = `${esc(gainer.name)} wins a die back! 🎁`;
  else if (r.type === 'calza' && r.success) consequence = `${esc(caller.name)} is already maxed out — bragging rights only.`;
  if (r.gameOver) consequence += ` 🏆 ${esc(P(state.winnerId)?.name)} wins the game!`;

  const humans = state.players.filter((p) => !p.isBot && !p.left && p.connected);
  const imReady = state.ready.includes(state.you);
  const readyCount = humans.filter((p) => state.ready.includes(p.id)).length;

  return `<div class="overlay ${anim ? 'anim' : ''}">
    <div class="sheet">
      <div class="stamp ${r.type}">${r.type === 'dudo' ? 'DUDO!' : 'CALZA!'}</div>
      <div class="claim">${esc(caller.name)} ${r.type === 'dudo' ? 'doubts' : 'says exactly'} ${esc(bidder?.name)}'s<br><span class="claimbid">${r.bid.qty} × ${die(r.bid.face, 'sm')}</span></div>
      <section class="card">${rows}</section>
      <section class="card tilt-r" style="background:var(--mango)">
        <div class="tally">There ${r.count === 1 ? 'was' : 'were'} <span class="n">${r.count}</span> × ${die(r.bid.face, 'md')}</div>
        <div class="verdict"><span class="big">${verdict}</span>${consequence}</div>
      </section>
      <button class="btn ${imReady ? 'paper' : 'lime'} big block" data-act="ready" ${imReady ? 'disabled' : ''}>
        ${imReady ? `Waiting for others… (${readyCount}/${humans.length})` : r.gameOver ? 'And the winner is… →' : `Next round → ${humans.length > 1 ? `(${readyCount}/${humans.length})` : ''}`}
      </button>
    </div>
  </div>`;
}

function gameoverView() {
  const w = P(state.winnerId);
  const iWon = state.winnerId === state.you;
  if (ui.wasWinner !== state.winnerId) {
    ui.wasWinner = state.winnerId;
    confetti();
    if (iWon) sfx.win();
  }
  return `
    ${topbar()}
    <div class="winner">
      ${w ? ava(w) : ''}
      <h1>${iWon ? 'YOU WIN!' : w ? `${esc(w.name)} wins!` : 'Game over'}</h1>
      <p class="tagline">${iWon ? 'Lord of lies. Master of dice. 🦙👑' : 'The most convincing liar at the table.'}</p>
    </div>
    <section class="card tilt-l">
      <h2>Final standings</h2>
      <ul class="plist">${[...state.players].sort((a, b) => b.diceCount - a.diceCount).map((p) => `
        <li>${ava(p, 'sm')}<span class="nm">${esc(p.name)}</span>${p.id === state.winnerId ? `<span class="chip lime">🏆 ${p.diceCount} ${p.diceCount === 1 ? 'die' : 'dice'} left</span>` : '<span class="chip">💀</span>'}</li>`).join('')}
      </ul>
    </section>
    <div class="dock">
      ${amHost() ? '<button class="btn pink big block" data-act="lobby">🔁 Play again</button>' : `<div class="who">Waiting for ${esc(P(state.hostId)?.name ?? 'the host')} to rack ’em up…</div>`}
    </div>`;
}

function rulesModal() {
  return `<div class="overlay" data-act="closeModal" data-self>
    <div class="sheet">
      <section class="card rules">
        <div class="row"><h2 class="grow" style="margin:0">How to play</h2><button class="iconbtn" data-act="closeModal" aria-label="Close">✕</button></div>
        <p>Everyone shakes their dice in secret. Then you take turns bidding on how many dice <b>on the whole table</b> show a face — like “seven 4s”.</p>
        <ul>
          <li><b>Raise</b> the bid: more dice, or the same number on a higher face.</li>
          <li>🦙 <b>Aces are wild</b> — they count as every face. Bidding on aces? Halve the count (round up). Leaving aces? Double it plus one.</li>
          <li>🤥 <b>Dudo!</b> — call the last bid a lie. Everyone reveals. Wrong guess? You lose a die. Right? The bidder does.</li>
          <li>🎯 <b>Calza!</b> — anyone (except the bidder) can claim the bid is <i>exactly</i> right. Nailed it? Win a die back. Missed? Lose one.</li>
          <li>🌶️ <b>Palifico</b> — the first time someone drops to one die, that round aces aren't wild and the face can't change.</li>
        </ul>
        <p>Lose all your dice and you're out. Last llama standing wins.</p>
      </section>
    </div>
  </div>`;
}

// ---------- little extras ----------

function drawQR() {
  const el = document.getElementById('qr');
  if (!el || !window.qrcode) return;
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(`${location.origin}/?room=${state.code}`);
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    el.hidden = false;
  } catch {}
}
window.addEventListener('load', () => state?.phase === 'lobby' && drawQR());

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $toasts.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function floatEmote(pid, e) {
  const anchor = document.querySelector(`.seat[data-pid="${pid}"] .ava`) || document.querySelector('.topbar');
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'floater';
  el.textContent = e;
  el.style.left = `${rect.left + rect.width / 2 - 19 + (Math.random() * 20 - 10)}px`;
  el.style.top = `${rect.top - 10}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1900);
}

function confetti() {
  const box = document.createElement('div');
  box.className = 'confetti';
  for (let i = 0; i < 60; i++) {
    const c = document.createElement('i');
    c.style.left = `${Math.random() * 100}%`;
    c.style.background = SEAT_COLORS[i % SEAT_COLORS.length];
    c.style.animationDuration = `${2 + Math.random() * 2.5}s`;
    c.style.animationDelay = `${Math.random() * 0.8}s`;
    c.style.rotate = `${Math.random() * 360}deg`;
    box.appendChild(c);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 5500);
}

let lock = null;
async function wakeLock() {
  if (lock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => (lock = null));
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  connect();
  if (state && state.phase !== 'lobby') wakeLock();
});

// Tiny synth sounds — no audio files needed.
const sfx = (() => {
  let ctx = null;
  const tone = (freq, dur, type = 'square', vol = 0.06, when = 0, slide = 0) => {
    if (ui.muted || !ctx) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur);
  };
  return {
    unlock() {
      if (ctx) return;
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {}
    },
    turn: () => { tone(660, 0.12, 'triangle', 0.12); tone(990, 0.18, 'triangle', 0.12, 0.12); },
    roll: () => { for (let i = 0; i < 7; i++) tone(180 + Math.random() * 500, 0.04, 'square', 0.04, i * 0.05); },
    call: (type) => type === 'dudo'
      ? tone(420, 0.5, 'sawtooth', 0.08, 0, 90)
      : (tone(520, 0.15, 'triangle', 0.1), tone(780, 0.3, 'triangle', 0.1, 0.15)),
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, 'triangle', 0.1, i * 0.13)),
  };
})();

// ---------- boot ----------

// An invite link for a different room beats an old saved seat.
const urlRoom = new URLSearchParams(location.search).get('room')?.toUpperCase();
if (session && urlRoom && urlRoom !== session.code) {
  session = null;
  store.set('session', null);
}

render();
connect();
