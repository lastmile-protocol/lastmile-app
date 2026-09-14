// Shared setup for the two endpoints.

import { connect } from '@lastmile/sdk/chain';
import { unpack, verify } from '@lastmile/sdk';

export const VAULT = process.env.LASTMILE_VAULT ?? 'CA6VTUIFEAG7CFN2KWRIEAKGEBDLP5PPGA5YAURV63JQDGTBDOUSXCDO';
export const RPC = process.env.LASTMILE_RPC ?? 'https://soroban-testnet.stellar.org';
export const PASSPHRASE = process.env.LASTMILE_PASSPHRASE ?? 'Test SDF Network ; September 2015';

export const vault = () => connect({ contractId: VAULT, rpc: RPC, passphrase: PASSPHRASE });

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/**
 * Turn a submitted code into a voucher, refusing anything that fails locally.
 *
 * Checking the signature here costs nothing and means a stream of rubbish
 * cannot make this endpoint pay Stellar fees to discover it is rubbish.
 */
export async function voucherFrom(code) {
  if (typeof code !== 'string' || !code.trim()) {
    return { error: 'Send a voucher code.' };
  }
  let voucher;
  try {
    voucher = unpack(code.trim());
  } catch (e) {
    return { error: `That is not a voucher code. ${e.message}` };
  }
  if (!verify(voucher)) {
    return { error: 'That voucher has been altered. Its signature does not check out.' };
  }
  if (Number(voucher.auth.expires) * 1000 < Date.now()) {
    return { error: 'That voucher has expired.' };
  }
  return { voucher };
}

// A small per-address budget. Serverless instances come and go, so this is a
// speed bump rather than a wall -- enough to stop a loop, not a botnet. The real
// protection is that every voucher is checked and simulated before anything is
// submitted, so a bad one never costs a fee.
const seen = new Map();
export function tooMany(req, limit = 20, windowMs = 60_000) {
  const who = (req.headers['x-forwarded-for'] ?? 'unknown').split(',')[0].trim();
  const now = Date.now();
  const hits = (seen.get(who) ?? []).filter((t) => now - t < windowMs);
  hits.push(now);
  seen.set(who, hits);
  if (seen.size > 5000) seen.clear();
  return hits.length > limit;
}
