// The anchor side of the ramp.
//
// SEP-10 and SEP-24 are XDR-shaped, and the wallet is deliberately a wallet: no
// stellar-sdk, no bundler, three hundred lines of hand-rolled crypto so it fits
// on a phone with no signal. So the protocol lives here and the *key* does not.
//
// What this endpoint never sees: the device key. The browser signs a 32-byte
// hash and sends back 64 bytes. What it therefore cannot do: authenticate as
// anybody, move anybody's money, or keep a session it was not given.
//
// What it could try, and why it fails: hand the browser a hash of something
// other than a challenge and hope it gets signed. Every challenge comes back
// with the anchor's own signature over that exact hash, and the browser checks
// it against a SIGNING_KEY it read from the anchor's stellar.toml itself, not
// from here. A hash this server invents carries no such signature.

import { connectAnchor, AnchorError } from '@lastmile/sdk/anchor';
import { json, readBody, tooMany } from './_lib.js';

// An open proxy to an arbitrary host is an SSRF hole, and "it's only a
// stellar.toml" is not a defence -- the URL is the attack. So the set of
// anchors this relayer will talk to is configuration, not user input.
export const ANCHORS = (process.env.LASTMILE_ANCHORS ?? 'testanchor.stellar.org')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function allowed(homeDomain) {
  // A string, and only a string. ["testanchor.stellar.org"] stringifies to the
  // allowed domain, and an object can stringify to anything at all -- so the
  // type is checked before the value, not after.
  if (typeof homeDomain !== 'string') return null;
  const d = homeDomain.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(d) || d.includes('..')) return null;
  return ANCHORS.includes(d) ? d : null;
}

// One connection per anchor per warm instance. stellar.toml changes rarely and
// re-fetching it on every keystroke is rude to somebody else's server.
const bound = new Map();
const TTL = 10 * 60_000;
async function anchorFor(homeDomain) {
  const hit = bound.get(homeDomain);
  if (hit && Date.now() - hit.at < TTL) return hit.a;
  const a = await connectAnchor({ homeDomain });
  bound.set(homeDomain, { a, at: Date.now() });
  return a;
}

const HEX64 = /^[0-9a-f]{128}$/i;
const ACTIONS = ['connect', 'challenge', 'token', 'start', 'status'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only.' });
  if (tooMany(req, 30)) return json(res, 429, { error: 'Slow down a moment.' });

  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: 'Send JSON.' });
  }

  const homeDomain = allowed(body.homeDomain);
  if (!homeDomain) {
    return json(res, 400, {
      error: `This relayer is configured for ${ANCHORS.join(', ')}. It will not fetch an arbitrary domain.`,
      anchors: ANCHORS,
    });
  }

  // Everything that can be judged from the request alone is judged now, before
  // a single packet leaves this machine. An endpoint that reaches the network to
  // discover the request was malformed has paid for the attacker's traffic and
  // told them the host is reachable.
  if (!ACTIONS.includes(body.action)) {
    return json(res, 400, { error: `Unknown action ${body.action}.`, actions: ACTIONS });
  }
  if (body.action === 'token' && !HEX64.test(String(body.signatureHex ?? ''))) {
    return json(res, 400, { error: 'A signature is 64 bytes of hex.' });
  }

  try {
    const a = await anchorFor(homeDomain);

    switch (body.action) {
      case 'connect': {
        // The browser reads stellar.toml itself as well, and uses its own copy
        // of SIGNING_KEY. This is here so the wallet can show the limits in one
        // round trip, not so it can be believed about who the anchor is.
        const info = await a.info();
        return json(res, 200, {
          homeDomain,
          signingKey: a.signingKey,
          networkPassphrase: a.networkPassphrase,
          currencies: a.currencies,
          deposit: info.deposit ?? {},
          withdraw: info.withdraw ?? {},
          fee: info.fee ?? null,
        });
      }

      case 'challenge': {
        const c = await a.challenge(String(body.account ?? ''));
        return json(res, 200, c);
      }

      case 'token': {
        const token = await a.token({
          transaction: body.transaction,
          networkPassphrase: body.networkPassphrase,
          account: body.account,
          signatureHex: body.signatureHex,
        });
        return json(res, 200, { token });
      }

      case 'start': {
        const out = await a.start(body.kind, {
          assetCode: body.assetCode,
          token: body.token,
          account: body.account,
          amount: body.amount,
          lang: body.lang,
        });
        return json(res, 200, out);
      }

      case 'status': {
        const t = await a.transaction(String(body.id ?? ''), body.token);
        return json(res, 200, { transaction: t });
      }

      /* c8 ignore next 2 -- unreachable: the action was checked above */
      default:
        return json(res, 400, { error: `Unknown action ${body.action}.` });
    }
  } catch (e) {
    // An anchor's own words are more use than a status code, and an
    // AnchorError already carries them.
    const status = e instanceof AnchorError ? 502 : 500;
    return json(res, status, { error: e.message ?? 'The anchor could not be reached.' });
  }
}
