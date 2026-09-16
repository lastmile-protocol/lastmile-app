# lastmile-app

An offline-first wallet. Sign a payment with no signal; bank it when signal returns.

**Live:** https://lastmile-protocol.github.io/lastmile-app/

Installs to the home screen, works with the radio off, and the wallet itself has
**no dependencies** — about 40KB in total. That is deliberate. The Stellar JS SDK
is over a megabyte, and an app whose whole premise is *your connection is bad*
cannot ask you to download a megabyte before it will sign anything. strkey, the
XDR encoding of one struct, sha256, ed25519 and a QR encoder are all done here,
directly against Web Crypto.

## What it does

**Pay** — enter an amount and who it is for, tap sign. A QR code comes up. They
point a camera at it. Nothing touches the network.

**Accept** — scan their code, or paste it. The wallet checks the signature
offline and tells you the amount and who it came from before you hand over the
goods. A code altered by even one character is refused.

**Wallet** — what you have accepted, a button to bank each one when you have a
connection, and the cash desk.

**Ramp** — cash in and out through a licensed anchor, when a bank rail is what
you need and a person with a cash box is not. Online by definition; everything
above still is not.

## Cash in, cash out

On and off ramp, in the only form that works where Lastmile is for: a person
with a cash box. The M-Pesa kiosk, the shop on the corner, the trader at the
market. No licence, no bank rail, no API — someone who has cash and wants XLM
standing opposite someone who has XLM and wants cash.

The voucher was already the right instrument for this, which is the neat part.
An agent taking XLM for cash can **check the signature before opening the cash
box**, with no signal at all. Nothing else in a village transaction gives them
that.

Set a currency, a rate and a fee once, and every screen that shows an amount
also shows the cash:

- **Pay** — "Hand over ₦3,920.00 — ₦80.00 fee kept" under the amount.
- **Accept** — the same figure on the voucher before you agree to it, so both
  sides are reading the same number off the same screen.
- **Wallet** — the day's trades, and your own QR so nobody has to type 56
  characters to pay you. That code is a [SEP-7](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md)
  payment request, so other Stellar wallets can read it too.

All of it offline. Rounding goes down in both directions — not to favour the
agent, but because it has to go *somewhere*, and "you are never handed more than
you are owed" is the rule both sides can check.

## The other ramp: banks, through an anchor

The cash desk works because it needs nobody's permission. Bank transfers, mobile
money and cards are the opposite: they need a licence, and Lastmile does not have
one. Stellar's answer is [anchors](https://developers.stellar.org/docs/learn/fundamentals/anchors) —
regulated businesses that take fiat in and issue tokens out — so the **Ramp**
screen integrates one rather than pretending to be one.

Type an anchor's domain, connect, and the wallet shows what that anchor will
take in and pay out, with its published limits. Choosing an amount opens the
anchor's own hosted page for the identity checks and the bank details, which is
exactly where that belongs. The wallet then tracks the transfer in plain words —
"Waiting for you to send the money", "Moving through the bank" — instead of
SEP-24 status strings.

### The part worth being careful about

Authenticating to an anchor ([SEP-10](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md))
means signing a challenge *transaction*. This wallet has no XDR decoder and is
not getting one — it is 300 lines of hand-rolled crypto so it fits on a phone
with no signal. So the protocol runs on the relayer and the relayer hands the
phone 32 bytes to sign.

That is blind signing, unless something stops it being blind. What stops it:

1. The wallet fetches the anchor's `stellar.toml` **itself**, over its own
   connection, and reads `SIGNING_KEY` from it. SEP-1 requires that file to be
   CORS-readable, which is what makes this possible from a browser at all.
2. Every challenge comes back with the anchor's own signature over the exact
   32 bytes in question, and the wallet checks it against *that* key.
3. Only then is the device key asked for anything.

So a relayer that has been got at cannot get a signature out of the phone: a
hash it invented carries no anchor signature, and a signing key it reports that
disagrees with the one the anchor publishes stops the flow before a challenge is
even requested. Both are tested by doing them.

What this does still trust, stated plainly: the **anchor** not to sign something
that is not a challenge. That is the party the user chose when they typed the
domain. The relayer, the network and we ourselves are not trusted with it. On the
server side the SDK checks the challenge properly — sequence 0, the anchor's own
source account, manage_data only, the first operation sourced by the user's
account and naming this home domain — and refuses anything else.

The anchor pays into **this device's own address**, which only this device can
sign for, because the device key is a non-extractable `CryptoKey`.

The relayer will only talk to anchors it has been configured for. A domain
arriving from a browser and being fetched is an SSRF, and the fact that the
target is "just a stellar.toml" is no defence — the URL is the attack.

### The risk an agent is actually taking

Opening a cash box against a voucher is opening it against a cheque. The
signature proves the payer signed; it does not prove they still have the float,
because they may have signed other vouchers to other people on other nonces and
only the first to reach the network gets paid.

What bounds it is the payer's float, and the wallet shows yours with **how old
the reading is** — "checked 3 hours ago", in warning colour once it is stale.
Offline, that number can only ever be a memory. Saying so is the difference
between an informed risk and a surprise.

What this is *not*: a fiat rail. Bank transfers and mobile money mean licensing,
KYC and settlement accounts — a regulated business, not a contract feature.
Stellar's answer to that is [anchors](https://stellar.org/use-cases/ramps) and
the SEP-24 standard, and the right move there is to integrate one rather than
pretend to be one.

## Banking, and who pays for it

When signal is available, each accepted voucher can be submitted directly from
the **Wallet** tab. Banking submits the signed authorization struct to the relayer,
verifies simulation on testnet, and writes the settlement on-chain. On success,
the transaction hash and ledger sequence are displayed.

When the device is offline, the submit button is automatically disabled with
"Bank it — needs a connection", preventing confusing failed submissions.

Failures are explained in plain words rather than numeric codes: 'already banked by
someone else' instead of error code 6, 'this voucher has expired' instead of code 2,
and 'payer vault underfunded' instead of code 4. If a voucher was already redeemed
elsewhere, it is pruned from the queue and a clear notice explains why.

The banking submission path is implemented directly against browser-native `fetch`
with zero external dependencies. Vouchers that fail due to transient errors (like network
drops or rate limits) remain safely in the queue with a 'Try again' button.

The payee is the person least likely to have a funded Stellar account: they are
in the place with no signal, which is usually also the place with no exchange.
So the wallet does not ask them for one. It hands the voucher to a **relayer**
(`api/redeem`) which submits it and pays the Stellar fee.

Redemption is permissionless in the contract — the signature is the authority,
not the sender — so this is not a privileged position. And a voucher **names its
payee**, so the relayer cannot redirect the money to itself or to anyone else.
It can submit the voucher, refuse to, or be slow. That is the entire trust
surface, and it is worth being precise about it rather than vague.

For the same reason, a copied voucher code is not a stolen one: whoever submits
it, the money goes to the payee named inside. The code is not a bearer
instrument, which is why the accepted queue sits in ordinary storage.

## The signing key

Generated non-extractable and kept in IndexedDB as a `CryptoKey`. The browser
will sign with it on request and refuse to hand it over, so a script that gets
onto this origin can spend while it is there but cannot walk away with the key
and spend later, forever, somewhere else.

An earlier version kept the seed in localStorage as plain hex. If you have one
of those, it is moved into protected storage on first load and the readable copy
is wiped.

## Deploying it

The static wallet needs nothing. The relayer needs an account to pay fees from:

| variable | what it is | default |
| --- | --- | --- |
| `LASTMILE_SUBMITTER` | secret seed of a funded account, used only to pay fees | none — banking returns a clear 503 without it |
| `LASTMILE_VAULT` | the vault contract | the deployed testnet vault |
| `LASTMILE_RPC` | Soroban RPC | testnet |
| `LASTMILE_PASSPHRASE` | network passphrase | testnet |
| `LASTMILE_ANCHORS` | comma-separated anchor domains the relayer may fetch | `testanchor.stellar.org` |

```
npx vercel deploy --prod
npx vercel env add LASTMILE_SUBMITTER production
```

On testnet, fund an account at https://friendbot.stellar.org. The submitter
never signs for the payment — only for the transaction envelope that carries it.

## Tests

```
npm test
```

**69 browser checks** through a real browser at phone size: signing, accepting,
tampering, a mistyped address, the key surviving a reload, the whole thing
working with the network switched off, the key being genuinely unexportable, an
old localStorage key being migrated and wiped, every state banking can end in —
including that with no signal the wallet says so rather than pretending — and
the cash desk end to end, with every screen made to agree on the same figure.

**19 ramp checks and 6 relayer checks.** The wallet signs a hash it cannot read,
so these are all attempts to get a signature out of it: a challenge signed by the
wrong key, a genuine anchor signature swapped onto different bytes, a relayer
reporting a signing key the anchor does not publish, a truncated hash. Each has
to be refused *and* to leave the device key untouched. The relayer's own set is
about the allowlist: cloud metadata addresses, suffix games, path traversal, and
an array that stringifies to an allowed domain.

Writing them found two things. The browser checks were passing while verifying
nothing, because `Uint8Array.toString('hex')` is `"147,211,34,…"` and says
nothing about it — so every signature was unreadable and every one was refused,
including the honest one. And the relayer was fetching the anchor before
validating the request, so a malformed post still cost a round trip.

**16 cash checks.** An agent hands over real money against this arithmetic, so
it is all integers in the smallest unit each side: currencies with no minor unit,
fees as basis points, rounding proved to go down in both directions, and a round
trip proved never to invent money.

**113 QR checks.** A QR encoder produces a convincing picture long before it
produces a readable one: a wrong generator polynomial, a reversed format field
or a dropped alignment pattern all look fine to a human and decode as nothing.
Every version from 1 to 20, every mask, and thirty real 246-character vouchers
go through an actual decoder and have to come back byte-identical, with the
error correction checked against a reference implementation.

The browser test also pulls the matrix the page itself drew and decodes that, so
what a scanner sees is what is being tested, not a Node-side copy of it.

## Licence

Apache-2.0.
