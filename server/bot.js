// A simple probabilistic Perudo bot. It only knows its own dice and the
// number of dice on the table, like a human would.
import { FACES, minQty, probAtLeast, probExactly } from '../public/rules.js';

export const BOT_NAMES = [
  'Señor Bluff', 'Lady Paco', 'Dice Daddy', 'Count Dudo', 'Captain Cup',
  'Professor Pips', 'Llamarama', 'El Sneako', 'Bonita Bones', 'Rattlesnake',
];

// Returns { type: 'bid', qty, face } | { type: 'dudo' } | { type: 'calza' }.
export function decide({ myDice, totalDice, bid, palifico, calzaAllowed, rng = Math.random }) {
  const unknown = totalDice - myDice.length;
  const ctx = { palifico, canChangeFace: myDice.length === 1 };

  const odds = (b) => {
    const wild = !palifico && b.face !== 1;
    const mine = myDice.filter((d) => d === b.face || (wild && d === 1)).length;
    const p = wild ? 1 / 3 : 1 / 6;
    return { mine, p, atLeast: probAtLeast(unknown, b.qty - mine, p), exact: probExactly(unknown, b.qty - mine, p) };
  };

  // Candidate raises: the minimum legal bid for each face, plus one step above.
  const options = [];
  for (const face of FACES) {
    const min = minQty(bid, face, ctx);
    if (min === null) continue;
    for (const qty of [min, min + 1]) {
      if (qty > totalDice) continue;
      const o = odds({ qty, face });
      // Prefer faces we actually hold, with a pinch of chaos so bots aren't predictable.
      const score = o.atLeast + o.mine * 0.04 + (rng() - 0.5) * 0.18;
      options.push({ qty, face, p: o.atLeast, score });
    }
  }
  options.sort((a, b) => b.score - a.score);
  const best = options[0];

  if (bid) {
    const cur = odds(bid);
    if (calzaAllowed && cur.exact > 0.32 && rng() < 0.6) return { type: 'calza' };
    const nerve = 0.3 + (rng() - 0.5) * 0.15;
    if (!best || (cur.atLeast < nerve && best.p < 0.55)) return { type: 'dudo' };
  }

  if (!best) return { type: 'dudo' };
  return { type: 'bid', qty: best.qty, face: best.face };
}
