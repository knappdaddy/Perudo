// Pure Perudo rules. No I/O, no timers — easy to test.
//
// A bid is { qty, face } where face 1 is an ace ("paco"). Outside a palifico
// round aces are wild: they count toward every other face.

export const FACES = [1, 2, 3, 4, 5, 6];

export function rollDice(n, rng = Math.random) {
  return Array.from({ length: n }, () => 1 + Math.floor(rng() * 6));
}

// How many dice on the table match `face`.
export function countFace(allDice, face, palifico) {
  const wild = !palifico && face !== 1;
  let n = 0;
  for (const d of allDice) if (d === face || (wild && d === 1)) n++;
  return n;
}

// Smallest legal quantity for a bid on `face`, given the previous bid.
// Returns null when `face` can't be bid at all right now.
//   palifico      – this round is a palifico round (aces not wild, face locked)
//   canChangeFace – in palifico, players down to one die may change the face
export function minQty(prev, face, { palifico = false, canChangeFace = false } = {}) {
  if (!FACES.includes(face)) return null;

  if (!prev) {
    // Opening bid: aces are only allowed as an opener in palifico.
    if (face === 1 && !palifico) return null;
    return 1;
  }

  if (palifico) {
    if (face === prev.face) return prev.qty + 1;
    if (!canChangeFace) return null;
    return face > prev.face ? prev.qty : prev.qty + 1;
  }

  const prevAce = prev.face === 1;
  const ace = face === 1;
  if (!prevAce && !ace) return face > prev.face ? prev.qty : prev.qty + 1;
  if (!prevAce && ace) return Math.ceil(prev.qty / 2);
  if (prevAce && ace) return prev.qty + 1;
  return prev.qty * 2 + 1; // from aces back to a regular face
}

export function isValidBid(prev, bid, totalDice, ctx = {}) {
  if (!bid || !Number.isInteger(bid.qty) || !Number.isInteger(bid.face)) return false;
  const min = minQty(prev, bid.face, ctx);
  return min !== null && bid.qty >= min && bid.qty <= totalDice;
}

// Probability that at least k of n unknown dice match (each with chance p).
export function probAtLeast(n, k, p) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let total = 0;
  for (let i = k; i <= n; i++) total += binom(n, i) * p ** i * (1 - p) ** (n - i);
  return Math.min(1, total);
}

export function probExactly(n, k, p) {
  if (k < 0 || k > n) return 0;
  return binom(n, k) * p ** k * (1 - p) ** (n - k);
}

function binom(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}
