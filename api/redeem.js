// Settle a voucher on chain on the payee's behalf.
//
// The payee is the person least likely to have a funded Stellar account: they
// are in the place with no signal, which is usually also the place with no
// exchange. Redemption is permissionless in the contract -- the signature is
// the authority, not the sender -- so anyone can carry a voucher in. This
// endpoint is that anyone.
//
// What it can and cannot do, plainly: a voucher names its payee, so this
// service cannot redirect the money to itself or to anyone else. It can only
// submit the voucher, refuse to, or be slow. That is the whole trust surface.

import { LastmileError } from '@lastmile/sdk';
import { json, readBody, tooMany, vault, voucherFrom, VAULT, RPC } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST a voucher code.' });
  if (tooMany(req)) return json(res, 429, { error: 'Too many requests. Try again shortly.' });

  const submitter = process.env.LASTMILE_SUBMITTER;
  if (!submitter) {
    return json(res, 503, {
      error:
        'This deployment has no submitting account, so it cannot pay the Stellar fee ' +
        'to settle a voucher. Set LASTMILE_SUBMITTER to a funded secret seed.',
      configured: false,
    });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: 'Send JSON: { "code": "..." }' });
  }

  const { voucher, error } = await voucherFrom(body.code);
  if (error) return json(res, 400, { error });

  try {
    const { hash, ledger } = await vault().redeem(voucher, submitter);
    return json(res, 200, {
      hash,
      ledger,
      amount: voucher.auth.amount,
      payee: voucher.auth.payee,
      vault: VAULT,
    });
  } catch (e) {
    if (e instanceof LastmileError) {
      // The contract's own refusal, in its own words.
      return json(res, 409, { error: e.message, code: e.code });
    }
    return json(res, 502, { error: `Could not reach ${RPC}: ${e.message}` });
  }
}
