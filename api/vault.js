// How much float does this payer have left, and how old is the answer?
//
// An agent about to hand over cash wants to know the voucher can actually be
// paid. The float is what bounds that: sign past it and the last voucher to
// reach the network is not paid. Simulated, so it costs nobody anything.

import { json, readBody, tooMany, vault, VAULT } from './_lib.js';

const G = /^G[A-Z2-7]{55}$/;

export default async function handler(req, res) {
  if (tooMany(req, 60)) return json(res, 429, { error: 'Too many requests. Try again shortly.' });

  let payer = null;
  if (req.method === 'GET') {
    payer = new URL(req.url, 'http://localhost').searchParams.get('payer');
  } else if (req.method === 'POST') {
    payer = (await readBody(req).catch(() => ({}))).payer;
  } else {
    return json(res, 405, { error: 'GET or POST a payer address.' });
  }

  payer = String(payer ?? '').trim().toUpperCase();
  if (!G.test(payer)) return json(res, 400, { error: 'Pass a Stellar address as ?payer=G…' });

  try {
    const v = await vault().vaultOf(payer);
    return json(res, 200, {
      payer,
      float: String(v.float),
      bond: String(v.bond),
      token: String(v.token),
      vault: VAULT,
      at: Date.now(),
    });
  } catch (e) {
    // A payer with no vault is a fact, not a failure: say so in words the
    // agent can act on rather than a stack trace.
    if (e?.code === 1) {
      return json(res, 404, { error: 'That payer has no vault, so nothing they sign can be paid.' });
    }
    return json(res, 502, { error: `Could not reach the network: ${e.message}` });
  }
}
