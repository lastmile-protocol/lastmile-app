// A QR encoder, written out rather than imported.
//
// The wallet's whole claim is that it works with the radio off, so it cannot
// fetch a library to draw a code. This is byte mode only, which is what a
// base64url voucher needs, and it picks the smallest version that fits.
//
// Structure follows ISO/IEC 18004: encode the data, append error correction,
// interleave the blocks, lay them out on the grid, then try all eight masks and
// keep whichever scores best. Scanners are unforgiving about the last part; a
// code with a bad mask reads as noise on half the phones that try it.

// ---- Galois field GF(256), the arithmetic Reed-Solomon is defined over ----

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // the field's generator polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/**
 * The generator polynomial for `n` error-correction codewords.
 *
 * Coefficients run in *descending* degree: poly[0] is the x^n term, which is
 * always 1. The division below reads it that way round, and building it the
 * other way produces error correction that is wrong in a way nothing complains
 * about until a scanner refuses the finished code.
 */
function generator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]; // raise the degree
      next[j + 1] ^= mul(poly[j], EXP[i]); // and pick up the a^i term
    }
    poly = next;
  }
  return poly;
}

/** Remainder of `data` divided by the generator — the EC codewords. */
function ecc(data, n) {
  const gen = generator(n);
  const out = new Uint8Array(n);
  for (const byte of data) {
    const factor = byte ^ out[0];
    out.copyWithin(0, 1);
    out[n - 1] = 0;
    for (let j = 0; j < n; j++) out[j] ^= mul(gen[j + 1], factor);
  }
  return out;
}

// ---- version tables ----
//
// Only what byte mode at error level M needs. M corrects about 15% of the code,
// which is the right trade for something photographed off a cracked phone
// screen in daylight: L is too fragile, Q and H make the code denser than the
// camera can resolve.
//
// [ total codewords, EC codewords per block, group1 blocks, group2 blocks ]
const VERSIONS = {
  1: [26, 10, 1, 0],
  2: [44, 16, 1, 0],
  3: [70, 26, 1, 0],
  4: [100, 18, 2, 0],
  5: [134, 24, 2, 0],
  6: [172, 16, 4, 0],
  7: [196, 18, 4, 0],
  8: [242, 22, 2, 2],
  9: [292, 22, 3, 2],
  10: [346, 26, 4, 1],
  11: [404, 30, 1, 4],
  12: [466, 22, 6, 2],
  13: [532, 22, 8, 1],
  14: [581, 24, 4, 5],
  15: [655, 24, 5, 5],
  16: [733, 28, 7, 3],
  17: [815, 28, 10, 1],
  18: [901, 26, 9, 4],
  19: [991, 26, 3, 11],
  20: [1085, 26, 3, 13],
};

/** Where the alignment patterns go, per version. */
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
  15: [6, 26, 48, 70], 16: [6, 26, 50, 74], 17: [6, 30, 54, 78],
  18: [6, 30, 56, 82], 19: [6, 30, 58, 86], 20: [6, 34, 62, 90],
};

const size = (v) => v * 4 + 17;

/** Data capacity in bytes, after the mode indicator and length field. */
function capacity(v) {
  const [total, ecPerBlock, g1, g2] = VERSIONS[v];
  const dataCodewords = total - ecPerBlock * (g1 + g2);
  const headerBits = 4 + (v < 10 ? 8 : 16);
  return Math.floor((dataCodewords * 8 - headerBits) / 8);
}

function smallestVersion(len) {
  for (let v = 1; v <= 20; v++) if (capacity(v) >= len) return v;
  throw new Error(`${len} bytes is more than a version 20 QR code holds`);
}

// ---- bit assembly ----

class Bits {
  constructor() {
    this.bytes = [];
    this.n = 0;
  }
  push(value, width) {
    for (let i = width - 1; i >= 0; i--) {
      const bit = (value >> i) & 1;
      if (this.n % 8 === 0) this.bytes.push(0);
      if (bit) this.bytes[this.bytes.length - 1] |= 0x80 >> this.n % 8;
      this.n++;
    }
  }
}

function codewords(data, version) {
  const [total, ecPerBlock, g1, g2] = VERSIONS[version];
  const blocks = g1 + g2;
  const dataCodewords = total - ecPerBlock * blocks;

  const bits = new Bits();
  bits.push(0b0100, 4); // byte mode
  bits.push(data.length, version < 10 ? 8 : 16);
  for (const b of data) bits.push(b, 8);
  // Terminator, then pad to a whole byte, then the two alternating pad bytes.
  bits.push(0, Math.min(4, dataCodewords * 8 - bits.n));
  while (bits.n % 8 !== 0) bits.push(0, 1);
  const out = Array.from(bits.bytes);
  for (let i = 0; out.length < dataCodewords; i++) out.push(i % 2 ? 0x11 : 0xec);

  // Split into blocks. Group 2's blocks are one codeword longer than group 1's.
  const shortLen = Math.floor(dataCodewords / blocks);
  const dataBlocks = [];
  const ecBlocks = [];
  let at = 0;
  for (let i = 0; i < blocks; i++) {
    const len = shortLen + (i >= g1 ? 1 : 0);
    const block = out.slice(at, at + len);
    at += len;
    dataBlocks.push(block);
    ecBlocks.push(ecc(block, ecPerBlock));
  }

  // Interleave, so a scratch across the code damages a little of every block
  // rather than destroying one outright.
  const seq = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) {
    for (const b of dataBlocks) if (i < b.length) seq.push(b[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const b of ecBlocks) seq.push(b[i]);
  }
  return seq;
}

// ---- the grid ----

function blank(version) {
  const n = size(version);
  const m = Array.from({ length: n }, () => new Int8Array(n).fill(-1)); // -1 = free
  const set = (r, c, v) => {
    if (r >= 0 && r < n && c >= 0 && c < n) m[r][c] = v;
  };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const on =
          r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(r0 + r, c0 + c, on ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);

  for (let i = 8; i < n - 8; i++) {
    const on = i % 2 === 0 ? 1 : 0;
    m[6][i] = on;
    m[i][6] = on;
  }

  // Alignment patterns sit at every pairing of the version's coordinates except
  // the three that would land on a finder. Testing "is this cell already taken"
  // instead looks equivalent and is not: the timing row and column run through
  // coordinate 6, so that test silently drops the patterns at (6, middle) and
  // (middle, 6) on every version from 7 up.
  const coords = ALIGN[version];
  const first = coords[0];
  const last = coords[coords.length - 1];
  for (const r of coords) {
    for (const c of coords) {
      const onFinder =
        (r === first && c === first) ||
        (r === first && c === last) ||
        (r === last && c === first);
      if (onFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
          set(r + dr, c + dc, on);
        }
      }
    }
  }

  // Reserve the format areas; they are written after the mask is chosen.
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === -1) m[8][i] = 0;
    if (m[i][8] === -1) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][n - 1 - i] === -1) m[8][n - 1 - i] = 0;
    if (m[n - 1 - i][8] === -1) m[n - 1 - i][8] = 0;
  }
  m[n - 8][8] = 1; // always dark

  if (version >= 7) {
    // 18 bits: the version number and a BCH(18,6) check over it.
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
    const info = ((version << 12) | rem) & 0x3ffff;
    for (let i = 0; i < 18; i++) {
      const bit = (info >> i) & 1;
      m[Math.floor(i / 3)][n - 11 + (i % 3)] = bit;
      m[n - 11 + (i % 3)][Math.floor(i / 3)] = bit;
    }
  }
  return m;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function place(reserved, seq, mask) {
  const n = reserved.length;
  const m = reserved.map((row) => Int8Array.from(row));
  let bit = 0;
  const total = seq.length * 8;

  // Up the rightmost pair of columns, down the next, and so on. The direction
  // flips per pair *processed*, not per column index: the vertical timing column
  // is skipped, and deriving the direction from the index instead gets every
  // column left of it backwards.
  let upward = true;
  for (let right = n - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is not a data column
    for (let step = 0; step < n; step++) {
      const r = upward ? n - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (m[r][c] !== -1) continue;
        let value = 0;
        if (bit < total) value = (seq[bit >> 3] >> (7 - (bit % 8))) & 1;
        bit++;
        m[r][c] = MASKS[mask](r, c) ? value ^ 1 : value;
      }
    }
    upward = !upward;
  }
  return m;
}

/** Format information: error level M, the mask, BCH-protected and XOR-masked. */
function writeFormat(m, mask) {
  const n = m.length;
  let v = (0b00 << 3) | mask; // 00 = level M
  let rem = v << 10;
  for (let i = 0; i < 5; i++) rem ^= ((rem >> (14 - i)) & 1) * (0x537 << (4 - i));
  const bits = ((v << 10) | (rem & 0x3ff)) ^ 0x5412;

  // `i` counts placement positions, not bit significance: the most significant
  // bit goes first. Writing them the other way round produces a code that looks
  // perfectly well formed and decodes as nothing.
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> (14 - i)) & 1;
    // Around the top-left finder, skipping the two timing cells.
    if (i < 6) m[8][i] = bit;
    else if (i === 6) m[8][7] = bit;
    else if (i === 7) m[8][8] = bit;
    else if (i === 8) m[7][8] = bit;
    else m[14 - i][8] = bit;
    // And the copy split across the other two finders.
    if (i < 7) m[n - 1 - i][8] = bit;
    else m[8][n - 15 + i] = bit;
  }
  m[n - 8][8] = 1;
}

/** The standard's penalty score. Lower is easier for a scanner to read. */
function penalty(m) {
  const n = m.length;
  let score = 0;

  const run = (get) => {
    for (let a = 0; a < n; a++) {
      let last = -1;
      let len = 0;
      for (let b = 0; b < n; b++) {
        const v = get(a, b);
        if (v === last) {
          len++;
          if (len === 5) score += 3;
          else if (len > 5) score += 1;
        } else {
          last = v;
          len = 1;
        }
      }
    }
  };
  run((r, c) => m[r][c]);
  run((c, r) => m[r][c]);

  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const s = m[r][c] + m[r][c + 1] + m[r + 1][c] + m[r + 1][c + 1];
      if (s === 0 || s === 4) score += 3;
    }
  }

  // The 1:1:3:1:1 pattern a scanner mistakes for a finder.
  const bad = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const badRev = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const look = (get) => {
    for (let a = 0; a < n; a++) {
      for (let b = 0; b + 11 <= n; b++) {
        let hit1 = true;
        let hit2 = true;
        for (let k = 0; k < 11; k++) {
          const v = get(a, b + k);
          if (v !== bad[k]) hit1 = false;
          if (v !== badRev[k]) hit2 = false;
        }
        if (hit1 || hit2) score += 40;
      }
    }
  };
  look((r, c) => m[r][c]);
  look((c, r) => m[r][c]);

  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

/**
 * Encode a string as a QR matrix of 0s and 1s.
 * @param {string} text
 * @returns {{ size: number, modules: Int8Array[], version: number }}
 */
/** Exposed for the test that compares against a reference encoder. */
export const __internals = { codewords, ecc, smallestVersion, capacity };

export function encodeQR(text, forceMask = null) {
  const data = new TextEncoder().encode(text);
  const version = smallestVersion(data.length);
  const seq = codewords(data, version);
  const reserved = blank(version);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask !== null && mask !== forceMask) continue;
    const m = place(reserved, seq, mask);
    writeFormat(m, mask);
    const score = penalty(m);
    if (!best || score < best.score) best = { m, score, mask };
  }
  return { size: size(version), modules: best.m, version, mask: best.mask };
}

/** Draw a QR matrix as an SVG string. Scales to whatever box it is put in. */
export function qrSVG(text, { quiet = 4, dark = '#000', light = '#fff' } = {}) {
  const { size: n, modules } = encodeQR(text);
  const dim = n + quiet * 2;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (modules[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="Voucher QR code">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}
