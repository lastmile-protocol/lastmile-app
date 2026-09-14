// Does a code this encoder draws actually scan?
//
// A QR encoder is the kind of thing that produces a convincing picture long
// before it produces a readable one: a wrong generator polynomial, a reversed
// format field or a dropped alignment pattern all look fine to a human and
// decode as nothing. So every case here goes through a real decoder and has to
// come back byte-identical.

import { encodeQR, __internals } from './qr.js';
import jsQRmod from 'jsqr';
import QRCode from 'qrcode';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const RS = require('qrcode/lib/core/reed-solomon-encoder.js');
const jsQR = jsQRmod.default ?? jsQRmod;

function imageOf(modules, n, scale = 3, quiet = 4) {
  const dim = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      if (!modules[r][c]) continue;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const i = (((r + quiet) * scale + dy) * dim + (c + quiet) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
    }
  return { data, width: dim, height: dim };
}

let bad = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) bad++;
  if (!cond || process.env.VERBOSE) console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const randomText = (n) => Array.from({ length: n }, () => ALPHABET[Math.floor(rand() * 64)]).join('');

// 1. Error correction must match a reference implementation exactly.
for (const n of [7, 10, 13, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30]) {
  const data = Array.from({ length: 40 }, (_, i) => (i * 37 + 11) & 0xff);
  const mine = Buffer.from(__internals.ecc(data, n)).toString('hex');
  const theirs = Buffer.from(new RS(n).encode(Buffer.from(data))).toString('hex');
  ok(`error correction with ${n} codewords matches the reference`, mine === theirs);
}

// 2. The smallest version that fits must be the one a reference encoder picks.
for (const len of [1, 10, 20, 34, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362]) {
  const text = randomText(len);
  const mine = encodeQR(text);
  const ref = QRCode.create(text, { errorCorrectionLevel: 'M' });
  ok(`version for ${len} bytes agrees with the reference`, mine.version === ref.version,
     `mine v${mine.version}, theirs v${ref.version}`);
}

// 3. Every version this encoder claims to support must round-trip.
for (let v = 1; v <= 20; v++) {
  const cap = __internals.capacity(v);
  for (const len of [cap, Math.max(1, cap - 1), Math.max(1, Math.floor(cap / 2))]) {
    const text = randomText(len);
    const { size, modules, version } = encodeQR(text);
    if (version !== v) continue; // a shorter string may fit a smaller version
    const img = imageOf(modules, size);
    const got = jsQR(img.data, img.width, img.height);
    ok(`v${v} at ${len} bytes decodes back identically`, got && got.data === text,
       got ? (got.data === text ? '' : 'decoded something else') : 'decoded nothing');
  }
}

// 4. Every mask must produce a readable code, not just the one scoring best.
const maskText = randomText(100);
for (let mask = 0; mask < 8; mask++) {
  const { size, modules } = encodeQR(maskText, mask);
  const img = imageOf(modules, size);
  const got = jsQR(img.data, img.width, img.height);
  ok(`mask ${mask} decodes`, got && got.data === maskText);
}

// 5. The real thing: 246 base64url characters, which is what a voucher is.
for (let i = 0; i < 30; i++) {
  const voucher = randomText(246);
  const { size, modules, version } = encodeQR(voucher);
  const img = imageOf(modules, size);
  const got = jsQR(img.data, img.width, img.height);
  ok(`voucher ${i} (v${version}) decodes`, got && got.data === voucher);
}

// 6. Awkward input must not be silently mangled.
for (const text of ['', 'a', 'éèê', '🚀 rocket', 'line\nbreak', '  spaces  ']) {
  if (text === '') continue; // an empty code is meaningless; nothing asks for one
  const { size, modules } = encodeQR(text);
  const img = imageOf(modules, size);
  const got = jsQR(img.data, img.width, img.height);
  ok(`${JSON.stringify(text)} survives`, got && got.data === text, got ? got.data : 'nothing');
}

// 7. Too much data must be refused, not truncated.
try {
  encodeQR('x'.repeat(__internals.capacity(20) + 1));
  ok('oversized input is refused', false, 'it was accepted');
} catch (e) {
  ok('oversized input is refused', /version 20/.test(e.message));
}

console.log(bad ? `\n${bad} FAILURES` : '\nEVERY CODE DECODED BACK TO EXACTLY WHAT WENT IN');
process.exit(bad ? 1 : 0);
