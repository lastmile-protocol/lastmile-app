// Would this voucher be paid, right now?
//
// For a payee with one bar of signal and a long walk back: it simulates, submits
// nothing, costs nobody anything, and answers before they hand over the goods.

import { json, readBody, tooMany, vault, voucherFrom, VAULT } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST a voucher code.' });
  if (tooMany(req, 60)) return json(res, 429, { error: 'Too many requests. Try again shortly.' });

  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: 'Send JSON: { "code": "..." }' });
  }

  const { voucher, error } = await voucherFrom(body.code);
  if (error) return json(res, 400, { error, good: false });

  try {
    const v = vault();
    const [good, spent] = await Promise.all([
      v.wouldRedeem(voucher),
      v.isSpent(voucher.auth.payer, voucher.auth.nonce).catch(() => null),
    ]);
    return json(res, 200, {
      good,
      spent,
      amount: voucher.auth.amount,
      payer: voucher.auth.payer,
      payee: voucher.auth.payee,
      vault: VAULT,
    });
  } catch (e) {
    return json(res, 502, { error: `Could not reach the network: ${e.message}` });
  }
}
