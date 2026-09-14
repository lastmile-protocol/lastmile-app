// The arithmetic at the counter.
//
// An agent gives out real cash against these numbers. Every case here is one
// where a float, a silent rounding, or a currency with the wrong number of
// decimal places would put the drawer and the phone out of step.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CURRENCIES, toMinor, fromMinor, money, rateFromText, feeFromPercent, feeToPercent,
  cashForStroops, stroopsForCash, freshness, payUri, readAddress, isCurrency,
} from './cash.js';

const NGN = 'NGN';

test('cash parses into minor units and back unchanged', () => {
  assert.equal(toMinor('1600', NGN), 160000n);
  assert.equal(toMinor('1600.50', NGN), 160050n);
  assert.equal(toMinor('0.01', NGN), 1n);
  assert.equal(toMinor('1,600.50', NGN), 160050n);   // typed with a separator
  assert.equal(toMinor(' 1600 ', NGN), 160000n);
  assert.equal(fromMinor(160050n, NGN), '1,600.50');
  assert.equal(fromMinor(1n, NGN), '0.01');
  assert.equal(fromMinor(0n, NGN), '0.00');
  assert.equal(money(160050n, NGN), '₦1,600.50');
});

test('a currency with no minor unit has no decimal part', () => {
  assert.equal(CURRENCIES.UGX.minor, 0);
  assert.equal(toMinor('4200', 'UGX'), 4200n);
  assert.equal(fromMinor(4200n, 'UGX'), '4,200');
  assert.throws(() => toMinor('4200.50', 'UGX'), /no decimal part/);
});

test('nonsense in the amount box is refused, not guessed at', () => {
  for (const bad of ['', 'abc', '-5', '1.2.3', '1600.999', '1e5', '.5']) {
    assert.throws(() => toMinor(bad, NGN), undefined, `accepted ${JSON.stringify(bad)}`);
  }
});

test('an unknown currency is refused rather than defaulted', () => {
  assert.equal(isCurrency('NGN'), true);
  assert.equal(isCurrency('XXX'), false);
  assert.throws(() => toMinor('10', 'XXX'), /Unknown currency/);
});

test('fees are basis points, so they stay integers', () => {
  assert.equal(feeFromPercent('2'), 200);
  assert.equal(feeFromPercent('2.5'), 250);
  assert.equal(feeFromPercent('0'), 0);
  assert.equal(feeFromPercent('0.25'), 25);
  assert.equal(feeToPercent(250), '2.5');
  assert.equal(feeToPercent(200), '2');
  assert.equal(feeToPercent(0), '0');
  assert.throws(() => feeFromPercent('60'), /typo/);   // a 60% fee is a slip
  assert.throws(() => feeFromPercent('abc'), /fee like/);
});

test('off-ramp: XLM in, cash out', () => {
  const rate = rateFromText('1600', NGN);          // ₦1,600 per XLM
  const { gross, fee, net } = cashForStroops(25_000_000n, rate, 200); // 2.5 XLM, 2%
  assert.equal(gross, 400000n);                     // ₦4,000.00
  assert.equal(fee, 8000n);                         // ₦80.00
  assert.equal(net, 392000n);                       // ₦3,920.00
  assert.equal(money(net, NGN), '₦3,920.00');
});

test('on-ramp: cash in, XLM out', () => {
  const rate = rateFromText('1600', NGN);
  const { net } = stroopsForCash(toMinor('4000', NGN), rate, 200);
  // ₦4,000 less 2% is ₦3,920, which at ₦1,600/XLM is 2.45 XLM.
  assert.equal(net, 24_500_000n);
});

test('a round trip never invents money', () => {
  const rate = rateFromText('1600', NGN);
  for (const xlm of [1n, 7n, 13n, 999n]) {
    const stroops = xlm * 10_000_000n;
    const out = cashForStroops(stroops, rate, 0).net;
    const back = stroopsForCash(out, rate, 0).net;
    assert.ok(back <= stroops, `${xlm} XLM round-tripped up to ${back}`);
  }
});

test('rounding always goes down, in both directions', () => {
  // A rate that does not divide evenly, so the remainder has to go somewhere.
  const rate = rateFromText('1333.33', NGN);
  const { net } = cashForStroops(1n, rate, 0);       // one stroop
  assert.equal(net, 0n, 'a stroop is worth less than a kobo, and is not rounded up');

  const s = stroopsForCash(1n, rate, 0);             // one kobo
  assert.ok(s.net < 10_000_000n / 1333n, 'a kobo does not buy more than it should');
});

test('a fee of zero takes nothing', () => {
  const rate = rateFromText('1600', NGN);
  const { gross, fee, net } = cashForStroops(10_000_000n, rate, 0);
  assert.equal(fee, 0n);
  assert.equal(gross, net);
  assert.equal(net, 160000n);
});

test('a rate of zero is refused rather than dividing by it', () => {
  assert.throws(() => stroopsForCash(100n, 0n, 0), /Set a rate/);
});

test('very large amounts stay exact', () => {
  const rate = rateFromText('1600', NGN);
  const big = 92_233_720_368_547_758n;               // near the wire format's limit
  const { net } = cashForStroops(big, rate, 0);
  assert.equal(net, (big * 160000n) / 10_000_000n);
  assert.equal(typeof net, 'bigint');
});

test('staleness is stated, not hidden', () => {
  const now = Date.parse('2026-09-14T12:00:00Z');
  assert.equal(freshness(null, now).known, false);
  assert.equal(freshness(now - 30_000, now).text, 'just now');
  assert.equal(freshness(now - 5 * 60_000, now).text, '5 min ago');
  assert.equal(freshness(now - 5 * 60_000, now).stale, false);
  assert.equal(freshness(now - 45 * 60_000, now).stale, true);
  assert.equal(freshness(now - 3 * 3600_000, now).text, '3 hours ago');
  assert.equal(freshness(now - 50 * 3600_000, now).text, '2 days ago');
});

test('a payment request is a SEP-7 URI other wallets understand', () => {
  const g = 'GDHY33WC627BSZJGU3G6CHXTERUCFDZ72THUPCQWIXQTS56X7T2ZERCV';
  assert.equal(payUri({ destination: g }), `web+stellar:pay?destination=${g}`);
  assert.ok(payUri({ destination: g, amount: '2.5' }).includes('amount=2.5'));
});

test('the scanner accepts anything an address can arrive as', () => {
  const g = 'GDHY33WC627BSZJGU3G6CHXTERUCFDZ72THUPCQWIXQTS56X7T2ZERCV';
  assert.equal(readAddress(g).address, g);                       // bare
  assert.equal(readAddress(g.toLowerCase()).address, g);         // written in lower case
  assert.equal(readAddress(`  ${g}  `).address, g);              // padded
  assert.equal(readAddress(payUri({ destination: g })).address, g);
  const withAmount = readAddress(payUri({ destination: g, amount: '2.5' }));
  assert.equal(withAmount.amount, '2.5');
});

test('the scanner refuses what is not an address', () => {
  for (const bad of ['', 'hello', 'web+stellar:pay?destination=NOPE', 'G' + 'A'.repeat(54),
                     'http://example.com', null, undefined]) {
    assert.equal(readAddress(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});
