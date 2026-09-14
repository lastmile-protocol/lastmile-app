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

**Wallet** — what you have accepted, and a button to bank each one when you have
a connection.

## Banking, and who pays for it

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

**32 browser checks** through a real browser at phone size: signing, accepting,
tampering, a mistyped address, the key surviving a reload, the whole thing
working with the network switched off, the key being genuinely unexportable, an
old localStorage key being migrated and wiped, and every state banking can end
in — including that with no signal the wallet says so rather than pretending.

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
