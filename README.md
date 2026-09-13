# lastmile-app

An offline-first wallet. Sign a payment with no signal; bank it when signal returns.

Installs to the home screen, works with the radio off, and has **no dependencies** —
about 25KB in total. That is deliberate: the Stellar JS SDK is over a megabyte, and
an app whose whole premise is *your connection is bad* cannot ask you to download a
megabyte before it will sign anything. strkey, the XDR encoding of one struct, sha256
and ed25519 are done directly against Web Crypto.

## What it does

**Pay** — enter an amount and who it is for, tap sign. A 246-character code comes out.
Copy it, or send it by NFC tap. Nothing touches the network.

**Accept** — paste the code you were given. The app checks the signature offline and
tells you the amount and who it came from before you hand over the goods. A code that
has been altered by even one character is refused.

**Wallet** — what you have accepted and not yet banked.

## Hand-rolled crypto, checked three ways

Hand-rolled crypto nobody compared to a reference is how people lose money, so:

- **Against the reference SDK** — strkey round-trips over 200 random keys, and the XDR
  and payload match byte-for-byte across six shapes including the i128 and u64 maximums.
- **Interop, both directions** — a signature made here verifies in `@stellar/stellar-sdk`
  and vice versa, from the same seed, producing identical bytes.
- **In a real browser** — `node uitest.cjs` drives the actual UI in phone-sized Chromium.
  14 checks, two of which switch the network off and confirm the app still loads and
  still signs.

The SDK is in turn checked against the deployed contract, so the chain agrees with all
of it.

## Keys

The signing key is generated on the phone and never leaves it. It is **not** your
Stellar account key — if the phone is stolen you revoke a device, you do not lose an
account. It is held in `localStorage`, which is fine for a testnet float and not fine
for real money; hardware-backed storage is the obvious next step.

## What is not built

**Banking a voucher.** Accepted vouchers sit on the phone and the app says so plainly.
The SDK can submit them; the button is not wired up. A screen that spun forever would
be worse than one that admits what it does not do.

**QR codes.** Generating one needs a library, which would be the app's first dependency.
Reading is closer — Android Chrome has `BarcodeDetector` built in. For now: copy the
code, or tap phones over NFC.

**Spoken codes.** 246 characters is too long to read down a phone line. That needs a
scheme that looks the payee up rather than carrying them, and it does not exist yet.

## Status

Testnet. Unaudited. No real money.

- contract `CB5ZYVSQY2XF3BSCD4KMCQY2IJI23LQMTNBT3DO7Q4RKUDGTWDORWVPS`
- contracts — https://github.com/lastmile-protocol/lastmile-contracts
- sdk — https://github.com/lastmile-protocol/lastmile-sdk

Apache-2.0.
