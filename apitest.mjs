// The relayer's own refusals.
//
// This endpoint fetches a URL built from something a browser sent. That is the
// shape of an SSRF, and "it's only a stellar.toml" is not a defence -- the URL
// is the attack, and the interesting targets are on the inside of somebody's
// network. So the domain is configuration, and these check that it stays that
// way whatever is posted.

import assert from 'node:assert/strict';
import test from 'node:test';
import handler, { allowed, ANCHORS } from './api/anchor.js';

/** A fake req/res pair, because the handler is an http handler. */
function call(body, headers = {}) {
  const req = { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.1', ...headers }, body };
  let out = null;
  const res = {
    statusCode: 200,
    setHeader() {},
    end(text) { out = { status: this.statusCode, body: JSON.parse(text) }; },
  };
  return handler(req, res).then(() => out);
}

test('the allowlist is where the domain comes from', () => {
  assert.deepEqual(ANCHORS, ['testanchor.stellar.org']);
  assert.equal(allowed('testanchor.stellar.org'), 'testanchor.stellar.org');
  assert.equal(allowed('TESTANCHOR.STELLAR.ORG'), 'testanchor.stellar.org');
  assert.equal(allowed(' testanchor.stellar.org '), 'testanchor.stellar.org');
});

test('everything else is refused, including the interesting ones', () => {
  for (const bad of [
    'evil.example',                       // simply not on the list
    'testanchor.stellar.org.evil.example',// suffix games
    'evil.example/testanchor.stellar.org',// path games
    '169.254.169.254',                    // cloud metadata, the classic target
    '127.0.0.1',
    'localhost',
    '[::1]',
    'a/../testanchor.stellar.org',
    'testanchor.stellar.org:8080',
    'testanchor..stellar.org',
    'https://testanchor.stellar.org',
    '',
    null,
    undefined,
    {},
    ['testanchor.stellar.org'],
  ]) {
    assert.equal(allowed(bad), null, `${JSON.stringify(bad)} must not be allowed`);
  }
});

test('a request for an unlisted anchor never reaches the network', async () => {
  const out = await call({ action: 'connect', homeDomain: '169.254.169.254' });
  assert.equal(out.status, 400);
  assert.match(out.body.error, /will not fetch an arbitrary domain/);
  // And it says what it *will* talk to, so this is a configuration problem the
  // operator can fix rather than a mystery.
  assert.deepEqual(out.body.anchors, ANCHORS);
});

test('an unknown action is refused before anything is fetched', async () => {
  const out = await call({ action: 'drop table', homeDomain: 'testanchor.stellar.org' });
  assert.equal(out.status, 400);
  assert.match(out.body.error, /Unknown action/);
});

test('a signature that is not 64 bytes of hex is refused here too', async () => {
  // ramp.js checks this, but ramp.js is the client. A server that trusts its
  // client to validate is a server with no validation.
  for (const sig of ['', 'zz', 'ab'.repeat(63), 'ab'.repeat(65), 'gg'.repeat(64), null]) {
    const out = await call({
      action: 'token',
      homeDomain: 'testanchor.stellar.org',
      signatureHex: sig,
      account: 'GAAA',
      transaction: 'x',
    });
    assert.equal(out.status, 400, `${sig} should be refused`);
    assert.match(out.body.error, /64 bytes of hex/);
  }
});

test('GET is refused; this endpoint changes things', async () => {
  let out = null;
  const res = { statusCode: 200, setHeader() {}, end(t) { out = { status: this.statusCode, body: JSON.parse(t) }; } };
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(out.status, 405);
});
