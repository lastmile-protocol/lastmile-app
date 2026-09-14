// Cash, and the arithmetic between cash and XLM.
//
// An agent stands behind a counter with a phone and a cash box. A customer wants
// naira for stroops or stroops for naira. Everything below is integer arithmetic
// in the smallest unit of each — stroops one side, kobo or cents the other —
// because the one thing that must never happen at that counter is the phone and
// the cash drawer disagreeing by a rounding error nobody can explain.
//
// Rounding always goes down, in every direction. Not because it favours the
// agent, but because it has to go *somewhere* and "you are never paid more than
// you are owed" is the rule both sides can check. The UI says which way it went.

const STROOPS = 10_000_000n;

/**
 * Currencies, and how many minor units make one.
 *
 * Kept tiny and explicit rather than pulled from Intl: an offline wallet cannot
 * assume a full ICU build is present, and a wrong exponent here is money.
 */
export const CURRENCIES = {
  NGN: { name: 'Nigerian naira', symbol: '₦', minor: 2 },
  KES: { name: 'Kenyan shilling', symbol: 'KSh', minor: 2 },
  GHS: { name: 'Ghanaian cedi', symbol: 'GH₵', minor: 2 },
  UGX: { name: 'Ugandan shilling', symbol: 'USh', minor: 0 },
  TZS: { name: 'Tanzanian shilling', symbol: 'TSh', minor: 2 },
  ZAR: { name: 'South African rand', symbol: 'R', minor: 2 },
  XOF: { name: 'West African CFA franc', symbol: 'CFA', minor: 0 },
  USD: { name: 'US dollar', symbol: '$', minor: 2 },
  EUR: { name: 'euro', symbol: '€', minor: 2 },
};

export const isCurrency = (code) => Object.hasOwn(CURRENCIES, code);

/** Parse a decimal string into minor units of `code`. Refuses anything odd. */
export function toMinor(text, code) {
  const cur = CURRENCIES[code];
  if (!cur) throw new Error(`Unknown currency ${code}`);
  const m = String(text).trim().replace(/[\s,]/g, '').match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error('Enter an amount in numbers, like 1600 or 1600.50');
  const frac = m[2] ?? '';
  if (frac.length > cur.minor) {
    throw new Error(
      cur.minor === 0
        ? `${code} has no decimal part`
        : `${code} has at most ${cur.minor} decimal place${cur.minor === 1 ? '' : 's'}`,
    );
  }
  return BigInt(m[1]) * 10n ** BigInt(cur.minor) + BigInt(frac.padEnd(cur.minor, '0') || '0');
}

/** Format minor units for display, without a symbol. */
export function fromMinor(minor, code) {
  const cur = CURRENCIES[code];
  if (!cur) throw new Error(`Unknown currency ${code}`);
  const n = BigInt(minor);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const div = 10n ** BigInt(cur.minor);
  const whole = (abs / div).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = cur.minor ? '.' + (abs % div).toString().padStart(cur.minor, '0') : '';
  return `${neg ? '-' : ''}${whole}${rest}`;
}

export const money = (minor, code) => `${CURRENCIES[code]?.symbol ?? ''}${fromMinor(minor, code)}`;

/**
 * A rate: how much cash one whole XLM is worth, in minor units.
 *
 * Stored as an integer so it survives a round trip through storage unchanged.
 * An agent types "1600" and means ₦1,600.00 per XLM; that is 160000 kobo.
 */
export const rateFromText = (text, code) => toMinor(text, code);

/** Basis points, so a 2.5% fee is 250 and stays an integer. */
export function feeFromPercent(text) {
  const m = String(text).trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error('Enter a fee like 2 or 2.5');
  const bps = BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  if (bps > 5000n) throw new Error('A fee over 50% is almost certainly a typo');
  return Number(bps);
}

export const feeToPercent = (bps) => {
  const s = (bps / 100).toFixed(2).replace(/\.?0+$/, '');
  return s === '' ? '0' : s;
};

/**
 * Cash the customer receives for `stroops`, after the agent's fee.
 *
 * Off-ramp: they hand over XLM, they get this much cash.
 */
export function cashForStroops(stroops, ratePerXlmMinor, feeBps = 0) {
  const gross = (BigInt(stroops) * BigInt(ratePerXlmMinor)) / STROOPS;
  const fee = (gross * BigInt(feeBps)) / 10_000n;
  return { gross, fee, net: gross - fee };
}

/**
 * Stroops the customer receives for `cashMinor`, after the agent's fee.
 *
 * On-ramp: they hand over cash, they get this much XLM.
 */
export function stroopsForCash(cashMinor, ratePerXlmMinor, feeBps = 0) {
  const cash = BigInt(cashMinor);
  const rate = BigInt(ratePerXlmMinor);
  if (rate <= 0n) throw new Error('Set a rate first');
  const fee = (cash * BigInt(feeBps)) / 10_000n;
  const spendable = cash - fee;
  return { gross: (cash * STROOPS) / rate, fee, net: (spendable * STROOPS) / rate };
}

/**
 * How stale is this reading of the payer's float?
 *
 * An agent handing over cash for a voucher is taking the same risk a shop takes
 * accepting a cheque: the payer may have signed more than their float covers, on
 * other nonces, to other people, and the first voucher to reach the network wins.
 * The float figure bounds that risk, but only as of when it was last read — and
 * offline, that can be hours. Saying how old it is out loud is the difference
 * between an informed risk and a surprise.
 */
export function freshness(checkedAt, now = Date.now()) {
  if (!checkedAt) return { known: false, text: 'never checked' };
  const secs = Math.max(0, (now - checkedAt) / 1000);
  if (secs < 60) return { known: true, stale: false, text: 'just now' };
  const mins = Math.round(secs / 60);
  if (mins < 60) return { known: true, stale: mins > 30, text: `${mins} min ago` };
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return { known: true, stale: true, text: `${hrs} hour${hrs === 1 ? '' : 's'} ago` };
  const days = Math.round(hrs / 24);
  return { known: true, stale: true, text: `${days} day${days === 1 ? '' : 's'} ago` };
}

// ---- SEP-7, so other Stellar wallets can read our codes and we can read theirs

/** A payment request URI: what an agent shows when they want to be paid. */
export function payUri({ destination, amount, memo }) {
  const q = [`destination=${destination}`];
  if (amount) q.push(`amount=${amount}`);
  if (memo) q.push(`memo=${encodeURIComponent(memo)}`);
  return `web+stellar:pay?${q.join('&')}`;
}

/**
 * Pull an address out of whatever was scanned.
 *
 * A camera gets pointed at all sorts of things: our own SEP-7 code, another
 * wallet's, or someone's bare address written on a card. Accept all three rather
 * than making the person work out which one they have.
 */
export function readAddress(text) {
  const s = String(text ?? '').trim();
  if (/^G[A-Z2-7]{55}$/.test(s.toUpperCase())) return { address: s.toUpperCase() };
  const m = /^web\+stellar:pay\?(.*)$/i.exec(s);
  if (!m) return null;
  const p = new URLSearchParams(m[1]);
  const dest = (p.get('destination') ?? '').toUpperCase();
  if (!/^G[A-Z2-7]{55}$/.test(dest)) return null;
  return { address: dest, amount: p.get('amount') ?? null, memo: p.get('memo') ?? null };
}
