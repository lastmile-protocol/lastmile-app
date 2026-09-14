// The bank ramp, from the phone's side.
//
// The cash desk needs no licence: a person, a cash box, a rate. Banks, mobile
// money and cards need one, and Lastmile does not have one. Stellar's answer is
// anchors -- licensed businesses that take fiat in and issue tokens out -- so
// this wallet integrates one rather than pretending to be one.
//
// The protocol is XDR-shaped and lives on the relayer. The key lives here and
// does not move. That split is only safe because of one thing, and it is worth
// being exact about what it is:
//
//   The relayer hands this file 32 bytes and says "sign this, it is a SEP-10
//   challenge". A relayer that had been got at could hand over the hash of a
//   payment instead. So it is not believed. Every challenge arrives with the
//   anchor's own signature over those exact bytes, and this file checks that
//   signature against a SIGNING_KEY it fetched from the anchor's stellar.toml
//   ITSELF, over the browser's own connection. A hash the relayer invented
//   carries no such signature, and nothing is signed.
//
// What is left, honestly stated: this trusts the *anchor* not to sign a
// transaction that is not a challenge. That is the party the user chose when
// they typed its domain. It does not trust the relayer, the network, or us.

import { hex, unhex, encodeAddress, decodeAddress } from './lastmile.js';

export class RampError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RampError';
  }
}

// ------------------------------------------------------------ stellar.toml
//
// SEP-1 requires this file to be CORS-readable, which is what makes the check
// above possible from a browser at all.

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function isDomain(d) {
  if (typeof d !== 'string' || d.length > 253) return false;
  const v = d.trim().toLowerCase();
  if (!DOMAIN.test(v)) return false;
  // 127.0.0.1 is a domain to that regex and an SSRF target to everyone else. No
  // real top-level domain is all digits, so this costs nothing and closes it.
  return !/^\d+$/.test(v.slice(v.lastIndexOf('.') + 1));
}

/** The two fields a wallet must read for itself, not take somebody's word for. */
export function signingKeyFromToml(text) {
  const m = /^\s*SIGNING_KEY\s*=\s*["']([A-Z2-7]{56})["']/m.exec(String(text));
  const n = /^\s*NETWORK_PASSPHRASE\s*=\s*["']([^"']*)["']/m.exec(String(text));
  if (!m) throw new RampError('That domain publishes no SIGNING_KEY, so nothing it sends can be checked.');
  return { signingKey: m[1], networkPassphrase: n ? n[1] : null };
}

export async function anchorIdentity(homeDomain, fetchImpl = fetch) {
  if (!isDomain(homeDomain)) throw new RampError('Enter a domain like testanchor.stellar.org');
  const url = `https://${homeDomain}/.well-known/stellar.toml`;
  let res;
  try {
    res = await fetchImpl(url);
  } catch {
    // Almost always CORS or no such host. Say which, because "failed to fetch"
    // sends people to the wrong place.
    throw new RampError(`Could not read ${homeDomain}'s stellar.toml. It may not be an anchor, or it may not allow browsers to read it.`);
  }
  if (!res.ok) throw new RampError(`${homeDomain} answered ${res.status} for its stellar.toml.`);
  return signingKeyFromToml(await res.text());
}

// ------------------------------------------------------------ the check
//
// ed25519 verification in the browser, against a raw 32-byte key.

/**
 * Did the anchor sign exactly these bytes?
 *
 * This is the gate. If it returns false the wallet signs nothing, whatever the
 * relayer said the bytes were for.
 */
export async function anchorSigned({ signingKey, hashHex, signatureHex }, subtle = crypto.subtle) {
  const hash = unhex(hashHex);
  const sig = unhex(signatureHex);
  if (hash.length !== 32 || sig.length !== 64) return false;
  // A typo in the address must not read as "the anchor did not sign".
  let raw;
  try {
    raw = decodeAddress(signingKey);
  } catch (e) {
    throw new RampError(`${signingKey} is not a usable signing key: ${e.message}`);
  }
  let key;
  try {
    key = await subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  } catch {
    throw new RampError('This browser cannot check ed25519 signatures, so it will not sign a challenge blind.');
  }
  return subtle.verify({ name: 'Ed25519' }, key, sig, hash);
}

// ------------------------------------------------------------ the flow

const post = async (body, fetchImpl = fetch) => {
  const res = await fetchImpl('api/anchor', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new RampError(out.error ?? `The relayer answered ${res.status}.`);
  return out;
};

/**
 * Bind to an anchor: its identity read first-hand, its limits read through the
 * relayer, and the two cross-checked before either is used.
 */
export async function useAnchor(homeDomain, { fetchImpl = fetch, subtle = crypto.subtle } = {}) {
  const domain = String(homeDomain).trim().toLowerCase();
  const mine = await anchorIdentity(domain, fetchImpl);
  const theirs = await post({ action: 'connect', homeDomain: domain }, fetchImpl);

  if (theirs.signingKey !== mine.signingKey) {
    // Either the relayer is lying or the anchor rotated its key mid-flight.
    // Both end the same way.
    throw new RampError(
      `${domain} publishes signing key ${mine.signingKey.slice(0, 8)}…, but the relayer reports ${String(theirs.signingKey).slice(0, 8)}…. Stopping here.`,
    );
  }

  return {
    homeDomain: domain,
    signingKey: mine.signingKey,
    networkPassphrase: mine.networkPassphrase ?? theirs.networkPassphrase,
    deposit: theirs.deposit ?? {},
    withdraw: theirs.withdraw ?? {},
    currencies: theirs.currencies ?? [],

    /**
     * SEP-10, with the signing done here and the XDR done there.
     *
     * `signHash` is the device: it takes 32 bytes and returns 64. It is only
     * ever reached after the anchor's signature over those same 32 bytes has
     * checked out.
     */
    async authenticate(account, signHash) {
      const c = await post({ action: 'challenge', homeDomain: domain, account }, fetchImpl);

      const ok = await anchorSigned(
        { signingKey: mine.signingKey, hashHex: c.hash, signatureHex: c.anchorSignature },
        subtle,
      );
      if (!ok) {
        throw new RampError(
          `${domain} has not signed the challenge it was supposed to. Nothing was signed on this device.`,
        );
      }

      const sig = await signHash(unhex(c.hash));
      const signatureHex = hex(sig instanceof Uint8Array ? sig : new Uint8Array(sig));
      const { token } = await post(
        {
          action: 'token',
          homeDomain: domain,
          account,
          transaction: c.transaction,
          networkPassphrase: c.networkPassphrase,
          signatureHex,
        },
        fetchImpl,
      );
      return token;
    },

    start: (kind, opts) => post({ action: 'start', homeDomain: domain, kind, ...opts }, fetchImpl),
    status: (id, token) => post({ action: 'status', homeDomain: domain, id, token }, fetchImpl),
  };
}

// ------------------------------------------------------------ presentation

/** What a SEP-24 status word means to somebody who did not write SEP-24. */
export function plainly(status) {
  return {
    incomplete: 'Not finished — open the anchor page again.',
    pending_user_transfer_start: 'Waiting for you to send the money.',
    pending_user_transfer_complete: 'You have sent it. Waiting on the anchor.',
    pending_anchor: 'The anchor is working on it.',
    pending_external: 'Moving through the bank.',
    pending_stellar: 'Settling on Stellar.',
    pending_trust: 'Waiting for you to trust this asset.',
    pending_user: 'The anchor needs something from you.',
    completed: 'Done.',
    refunded: 'Refunded.',
    expired: 'Expired — start again.',
    no_market: 'The anchor cannot trade this right now.',
    too_small: 'Below the anchor’s minimum.',
    too_large: 'Above the anchor’s maximum.',
    error: 'The anchor reported a problem.',
  }[status] ?? status;
}

/** A deposit or withdrawal is finished when there is nothing left to wait for. */
export const settled = (status) =>
  ['completed', 'refunded', 'expired', 'error', 'no_market', 'too_small', 'too_large'].includes(status);

/** Which assets an anchor will actually take, with the limits attached. */
export function offered(table) {
  return Object.entries(table ?? {})
    .filter(([, v]) => v && v.enabled !== false)
    .map(([code, v]) => ({
      code,
      min: v.min_amount ?? null,
      max: v.max_amount ?? null,
      fixedFee: v.fee_fixed ?? null,
      percentFee: v.fee_percent ?? null,
    }));
}

/** The address an anchor pays into: this device's own, which it alone can sign for. */
export const rampAddress = (publicKey) => encodeAddress(publicKey);
