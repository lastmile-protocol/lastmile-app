// The ramp, and mostly the one thing in it that matters.
//
// The wallet cannot parse a SEP-10 challenge -- it has no XDR decoder and is not
// getting one. So it signs a 32-byte hash the relayer hands it. The only reason
// that is not blind signing is that the anchor's signature over those same bytes
// is checked first, against a key the wallet read from the anchor itself.
//
// Which means: if these tests pass and that check is wrong, the wallet signs
// whatever a compromised relayer asks it to. They are written accordingly --
// every one of them is an attempt to get a signature out of it.

import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

import {
  RampError, isDomain, signingKeyFromToml, anchorIdentity, anchorSigned,
  useAnchor, plainly, settled, offered, rampAddress,
} from './ramp.js';
import { encodeAddress, hex, unhex } from './lastmile.js';

const subtle = webcrypto.subtle;

// A stand-in anchor with a real ed25519 key, so every signature below is real.
const anchorKeys = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const ANCHOR_RAW = new Uint8Array(await subtle.exportKey('raw', anchorKeys.publicKey));
const ANCHOR = encodeAddress(ANCHOR_RAW);

const otherKeys = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const OTHER = encodeAddress(new Uint8Array(await subtle.exportKey('raw', otherKeys.publicKey)));

const deviceKeys = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const DEVICE_RAW = new Uint8Array(await subtle.exportKey('raw', deviceKeys.publicKey));
const DEVICE = encodeAddress(DEVICE_RAW);

const signWith = async (keys, bytes) =>
  new Uint8Array(await subtle.sign({ name: 'Ed25519' }, keys.privateKey, bytes));

const randomHash = () => webcrypto.getRandomValues(new Uint8Array(32));

const TOML = (key = ANCHOR) => `
VERSION="2.0.0"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
SIGNING_KEY="${key}"
WEB_AUTH_ENDPOINT="https://anchor.test/auth"
TRANSFER_SERVER_SEP0024="https://anchor.test/sep24"
`;

// ------------------------------------------------------------------ SEP-1

test('a home domain is a domain and nothing else', () => {
  assert.ok(isDomain('testanchor.stellar.org'));
  assert.ok(isDomain('anchor.test'));
  for (const bad of [
    'https://anchor.test',          // a URL is not a domain
    'anchor.test/../../etc',        // path traversal
    'anchor.test:8080',             // a port is somebody choosing the socket
    'localhost',                    // no dot, and the wrong side of the network
    '127.0.0.1',                    // an address, and a private one
    'anchor .test',
    '',
    null,
  ]) {
    assert.equal(isDomain(bad), false, `${bad} should not be a home domain`);
  }
});

test('the signing key is read out of a real toml', () => {
  const { signingKey, networkPassphrase } = signingKeyFromToml(TOML());
  assert.equal(signingKey, ANCHOR);
  assert.equal(networkPassphrase, 'Test SDF Network ; September 2015');
});

test('a toml with no signing key stops the flow, it does not default', () => {
  // The alternative -- carry on and trust the relayer's copy -- is how blind
  // signing gets reintroduced by accident.
  assert.throws(() => signingKeyFromToml('VERSION="2.0.0"'), RampError);
  assert.throws(() => signingKeyFromToml(''), RampError);
  assert.throws(() => signingKeyFromToml('<html>404</html>'), RampError);
});

test('anchorIdentity explains a CORS failure instead of saying "failed to fetch"', async () => {
  await assert.rejects(
    () => anchorIdentity('anchor.test', async () => { throw new TypeError('Failed to fetch'); }),
    (e) => e instanceof RampError && /may not allow browsers to read it/.test(e.message),
  );
});

// ----------------------------------------------------------- the one gate

test('a hash the anchor really signed is accepted', async () => {
  const h = randomHash();
  const sig = await signWith(anchorKeys, h);
  assert.equal(
    await anchorSigned({ signingKey: ANCHOR, hashHex: hex(h), signatureHex: hex(sig) }, subtle),
    true,
  );
});

test('a hash signed by somebody else is refused', async () => {
  // The relayer gets a real challenge from a real anchor, then swaps in a hash
  // of its own and signs it with a key it made up.
  const h = randomHash();
  const sig = await signWith(otherKeys, h);
  assert.equal(
    await anchorSigned({ signingKey: ANCHOR, hashHex: hex(h), signatureHex: hex(sig) }, subtle),
    false,
  );
});

test('a real signature over different bytes is refused', async () => {
  // The subtler attack: keep the anchor's genuine signature, change the hash.
  const real = randomHash();
  const sig = await signWith(anchorKeys, real);
  const swapped = randomHash();
  assert.equal(
    await anchorSigned({ signingKey: ANCHOR, hashHex: hex(swapped), signatureHex: hex(sig) }, subtle),
    false,
  );
});

test('a truncated hash or signature is refused before any crypto runs', async () => {
  const h = randomHash();
  const sig = await signWith(anchorKeys, h);
  assert.equal(await anchorSigned({ signingKey: ANCHOR, hashHex: hex(h).slice(0, 62), signatureHex: hex(sig) }, subtle), false);
  assert.equal(await anchorSigned({ signingKey: ANCHOR, hashHex: hex(h), signatureHex: hex(sig).slice(0, 126) }, subtle), false);
  assert.equal(await anchorSigned({ signingKey: ANCHOR, hashHex: '', signatureHex: '' }, subtle), false);
});

test('a mistyped signing key is an error, not a quiet "not signed"', async () => {
  const h = randomHash();
  const sig = await signWith(anchorKeys, h);
  const typo = ANCHOR.slice(0, 40) + 'AAAA' + ANCHOR.slice(44);
  await assert.rejects(
    () => anchorSigned({ signingKey: typo, hashHex: hex(h), signatureHex: hex(sig) }, subtle),
    (e) => e instanceof RampError && /not a usable signing key/.test(e.message),
  );
});

// -------------------------------------------------------------- the flow

/** A relayer that can be told to misbehave in exactly one way at a time. */
function relayer({ signingKey = ANCHOR, hashFrom = null, signHashWith = anchorKeys, onToken } = {}) {
  const calls = [];
  return async (url, opts = {}) => {
    if (String(url).includes('.well-known/stellar.toml')) {
      return { ok: true, status: 200, text: async () => TOML() };
    }
    const body = JSON.parse(opts.body);
    calls.push(body);
    const reply = async (o) => ({ ok: true, status: 200, json: async () => o });

    switch (body.action) {
      case 'connect':
        return reply({
          signingKey,
          networkPassphrase: 'Test SDF Network ; September 2015',
          deposit: { USDC: { enabled: true, min_amount: 1, max_amount: 500 }, SRT: { enabled: false } },
          withdraw: { USDC: { enabled: true } },
          currencies: [{ code: 'USDC' }],
        });
      case 'challenge': {
        const h = hashFrom ?? randomHash();
        const sig = await signWith(signHashWith, h);
        return reply({
          transaction: 'AAAA-pretend-xdr',
          networkPassphrase: 'Test SDF Network ; September 2015',
          hash: hex(h),
          anchorSignature: hex(sig),
          signingKey: ANCHOR,
          account: body.account,
        });
      }
      case 'token':
        onToken?.(body);
        return reply({ token: 'jwt.for.you' });
      case 'start':
        return reply({ url: 'https://anchor.test/i/abc', id: 'tx-1' });
      case 'status':
        return reply({ transaction: { id: 'tx-1', status: 'pending_user_transfer_start' } });
      default:
        return { ok: false, status: 400, json: async () => ({ error: 'no' }) };
    }
  };
}

test('the happy path signs the hash and gets a token', async () => {
  let posted = null;
  const a = await useAnchor('anchor.test', {
    fetchImpl: relayer({ onToken: (b) => { posted = b; } }),
    subtle,
  });
  assert.equal(a.signingKey, ANCHOR);
  assert.deepEqual(offered(a.deposit).map((d) => d.code), ['USDC']); // SRT is disabled

  let asked = null;
  const token = await a.authenticate(DEVICE, async (hash) => {
    asked = hash;
    return signWith(deviceKeys, hash);
  });

  assert.equal(token, 'jwt.for.you');
  assert.equal(asked.length, 32);
  // What went back is a signature by the device over exactly what it was shown.
  assert.ok(await subtle.verify({ name: 'Ed25519' }, deviceKeys.publicKey, unhex(posted.signatureHex), asked));
});

test('a relayer that reports a different signing key is stopped', async () => {
  // It read stellar.toml itself. It does not need the relayer's opinion.
  await assert.rejects(
    () => useAnchor('anchor.test', { fetchImpl: relayer({ signingKey: OTHER }), subtle }),
    (e) => e instanceof RampError && /Stopping here/.test(e.message),
  );
});

test('a relayer that forges a challenge gets no signature', async () => {
  // The attack this whole design exists to stop: the relayer hands over the
  // hash of a payment transaction and calls it a challenge.
  const a = await useAnchor('anchor.test', {
    fetchImpl: relayer({ signHashWith: otherKeys }),
    subtle,
  });

  let everAsked = false;
  await assert.rejects(
    () => a.authenticate(DEVICE, async () => { everAsked = true; return new Uint8Array(64); }),
    (e) => e instanceof RampError && /Nothing was signed on this device/.test(e.message),
  );
  assert.equal(everAsked, false, 'the device key must never have been reached');
});

test('the device is not asked to sign twice for one challenge', async () => {
  let n = 0;
  const a = await useAnchor('anchor.test', { fetchImpl: relayer(), subtle });
  await a.authenticate(DEVICE, async (h) => { n += 1; return signWith(deviceKeys, h); });
  assert.equal(n, 1);
});

test('a relayer error comes through in the anchor own words', async () => {
  const f = async (url, opts) => {
    if (String(url).includes('stellar.toml')) return { ok: true, status: 200, text: async () => TOML() };
    const body = JSON.parse(opts.body);
    if (body.action === 'connect') {
      return { ok: true, status: 200, json: async () => ({ signingKey: ANCHOR, deposit: {}, withdraw: {} }) };
    }
    return { ok: false, status: 502, json: async () => ({ error: 'This account is not allowed to withdraw' }) };
  };
  const a = await useAnchor('anchor.test', { fetchImpl: f, subtle });
  await assert.rejects(
    () => a.start('withdraw', { assetCode: 'USDC', token: 't', account: DEVICE }),
    (e) => e.message === 'This account is not allowed to withdraw',
  );
});

test('start and status carry the home domain the wallet bound to', async () => {
  const seen = [];
  const inner = relayer();
  const f = async (url, opts) => { if (opts?.body) seen.push(JSON.parse(opts.body)); return inner(url, opts); };
  const a = await useAnchor('anchor.test', { fetchImpl: f, subtle });
  await a.start('deposit', { assetCode: 'USDC', token: 't', account: DEVICE, amount: 25 });
  await a.status('tx-1', 't');
  const start = seen.find((b) => b.action === 'start');
  assert.equal(start.homeDomain, 'anchor.test');
  assert.equal(start.assetCode, 'USDC');
  assert.equal(seen.find((b) => b.action === 'status').homeDomain, 'anchor.test');
});

// -------------------------------------------------------------- the words

test('a SEP-24 status is turned into something a person can act on', () => {
  assert.equal(plainly('pending_user_transfer_start'), 'Waiting for you to send the money.');
  assert.equal(plainly('completed'), 'Done.');
  // An unknown status is shown as-is rather than hidden behind "unknown".
  assert.equal(plainly('some_new_status'), 'some_new_status');
});

test('settled says when to stop polling', () => {
  assert.equal(settled('completed'), true);
  assert.equal(settled('expired'), true);
  assert.equal(settled('error'), true);
  assert.equal(settled('pending_anchor'), false);
  assert.equal(settled('incomplete'), false);
});

test('offered keeps the limits and drops what is switched off', () => {
  const list = offered({
    USDC: { enabled: true, min_amount: 1, max_amount: 500, fee_fixed: 0.5 },
    SRT: { enabled: false },
    native: { min_amount: 10 },   // enabled is optional and means yes
  });
  assert.deepEqual(list.map((d) => d.code), ['USDC', 'native']);
  assert.equal(list[0].min, 1);
  assert.equal(list[0].fixedFee, 0.5);
  assert.equal(list[1].min, 10);
  assert.equal(list[1].max, null);
});

test('the ramp address is the device address, which only this device can sign for', () => {
  assert.equal(rampAddress(DEVICE_RAW), DEVICE);
  assert.match(rampAddress(DEVICE_RAW), /^G[A-Z2-7]{55}$/);
});
