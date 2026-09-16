// The wallet. Everything here works with the radio off except banking, which by
// definition cannot.

import {
  newDevice, importDevice, sign, verify, pack, unpack,
  encodeAddress, decodeAddress, hex, unhex,
} from './lastmile.js';
import { loadDevice, saveDevice, forgetDevice } from './store.js';
import { qrSVG } from './qr.js';
import {
  CURRENCIES, isCurrency, toMinor, money, rateFromText, feeFromPercent, feeToPercent,
  cashForStroops, freshness, payUri, readAddress,
} from './cash.js';
import { useAnchor, plainly, settled, offered, rampAddress } from './ramp.js';

const $ = (id) => document.getElementById(id);
const LEGACY = 'lastmile.device.v1'; // where the key used to live, in the clear
const QUEUE = 'lastmile.accepted.v1';
const DESK = 'lastmile.desk.v1';     // an agent's currency, rate and fee
const TRADES = 'lastmile.trades.v1'; // cash that changed hands
const FLOAT = 'lastmile.float.v1';   // last reading of our own offline float
const RAMPS = 'lastmile.ramps.v1';   // anchor deposits and withdrawals in flight
const ANCHOR = 'lastmile.anchor.v1'; // the anchor domain this wallet last used
const NOTICES = 'lastmile.notices.v1'; // transient UI notices (e.g. vouchers banked elsewhere)

let device = null;

// ---- storage for things that are not secret.
// A voucher names its payee, so a copied code cannot pay anyone else -- it is
// not a bearer instrument, and keeping the queue here costs nobody anything.
// localStorage can throw in private windows, so never assume it.
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ---- money. Stroops are integers; never let a float near them.
const toStroops = (s) => {
  const m = String(s).trim().match(/^(\d+)(?:\.(\d{1,7}))?$/);
  if (!m) throw new Error('Enter an amount like 2.5');
  return (BigInt(m[1]) * 10000000n + BigInt((m[2] ?? '').padEnd(7, '0'))).toString();
};
const toXLM = (stroops) => {
  const n = BigInt(stroops), whole = n / 10000000n, frac = (n % 10000000n).toString().padStart(7, '0');
  return `${whole}.${frac}`.replace(/0+$/, '').replace(/\.$/, '');
};
const short = (g) => `${g.slice(0, 8)}…${g.slice(-6)}`;

// ---- online indicator
function net() {
  const on = navigator.onLine;
  $('net').textContent = on ? 'online · testnet' : 'no signal — still works';
  $('net').classList.toggle('off', !on);
  renderQueue();
  if ($('floatamt')) renderFloat();
}
addEventListener('online', net); addEventListener('offline', net);

// ---- device key
async function restore() {
  device = await loadDevice();

  // An older version of this app kept the seed in localStorage as plain hex.
  // Move it somewhere it cannot be read back, then wipe the old copy. Done once;
  // after this the key exists only as a CryptoKey the browser will not export.
  if (!device) {
    const legacy = load(LEGACY, null);
    if (legacy?.seed && legacy?.pub) {
      try {
        device = { key: await importDevice(unhex(legacy.seed)), publicKey: unhex(legacy.pub) };
        await saveDevice(device);
        $('devline').textContent = 'Signing key moved into protected storage.';
      } catch {
        device = null;
      }
    }
    try { localStorage.removeItem(LEGACY); } catch {}
  }
  if (device) showDevice();
}

function showDevice() {
  $('devline').textContent =
    $('devline').textContent.startsWith('Signing key moved')
      ? $('devline').textContent
      : 'Signing key ready on this device.';
  $('mkdev').classList.add('hide');
  $('payform').classList.remove('hide');
  $('devkey').textContent = encodeAddress(device.publicKey);
  showMyCode();
}

$('mkdev').onclick = async () => {
  try {
    device = await newDevice();
    await saveDevice(device);
    showDevice();
  } catch (e) {
    $('devline').textContent =
      `This browser cannot make an Ed25519 key (${e.message}). Try Chrome, or Safari 17 and up.`;
  }
};

$('forget').onclick = async () => {
  if (!confirm('Forget this key? Any voucher you signed that nobody has banked yet becomes worthless.')) return;
  await forgetDevice();
  try { localStorage.removeItem(LEGACY); } catch {}
  location.reload();
};

// ---- paying
$('signbtn').onclick = async () => {
  const out = $('payout'), summary = $('paysummary');
  try {
    const payee = $('payee').value.trim().toUpperCase();
    decodeAddress(payee); // throws on a typo, which is the point
    const amount = toStroops($('amount').value);
    if (BigInt(amount) <= 0n) throw new Error('Amount must be more than zero');

    const auth = {
      payer: encodeAddress(device.publicKey),
      payee,
      amount,
      // Milliseconds since the epoch: unique per device without needing to ask
      // the chain what we have already spent, which we cannot do offline.
      nonce: String(Date.now()),
      expires: String(Math.floor(Date.now() / 1000) + 7 * 86400),
    };
    const code = pack(await sign(auth, device));
    $('code').value = code;
    out.classList.remove('hide');

    // The code is drawn, not read. Nobody is retyping 246 characters.
    try {
      $('qr').innerHTML = qrSVG(code);
      $('qr').hidden = false;
      $('qrnote').hidden = false;
      $('code').hidden = true;
      $('showcode').hidden = false;
      $('showcode').textContent = 'Show the text';
    } catch {
      $('qr').hidden = true;
      $('qrnote').hidden = true;
      $('code').hidden = false;
      $('showcode').hidden = true;
    }
    summary.textContent = `${toXLM(amount)} XLM · expires in 7 days · ${code.length} characters`;
  } catch (e) {
    out.classList.remove('hide');
    $('code').value = '';
    $('code').hidden = false;
    $('qr').hidden = true;
    $('qrnote').hidden = true;
    $('showcode').hidden = true;
    summary.textContent = e.message;
  }
};

$('showcode').onclick = () => {
  const hidden = $('code').hidden;
  $('code').hidden = !hidden;
  $('showcode').textContent = hidden ? 'Hide the text' : 'Show the text';
};

$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('code').value); $('copy').textContent = 'Copied'; }
  catch { $('code').hidden = false; $('code').select(); }
  setTimeout(() => ($('copy').textContent = 'Copy'), 1500);
};

// Web NFC is Android Chrome only. Say so rather than failing silently.
$('nfc').onclick = async () => {
  if (!('NDEFReader' in window)) return alert('This phone cannot send by tap. Show the QR code instead.');
  try {
    await new NDEFReader().write({ records: [{ recordType: 'text', data: $('code').value }] });
    alert('Hold the phones together.');
  } catch (e) { alert(`Tap failed: ${e.message}`); }
};

// ---- scanning
//
// One camera routine, two jobs: reading a voucher someone is paying you with,
// and reading the address of someone you are paying. Both beat typing.

let scanStop = null;

async function startScan({ video, panel, hint, onText }) {
  scanStop?.();
  if (!('BarcodeDetector' in window)) {
    alert(
      'This browser cannot read QR codes from the camera. ' +
      'Paste or type the code instead, or use Chrome on Android.',
    );
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) {
    alert(`No camera: ${e.message}`);
    return;
  }
  video.srcObject = stream;
  await video.play();
  panel.hidden = false;
  if (hint) hint.textContent = 'Hold the code steady in the frame.';

  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  let running = true;
  scanStop = () => {
    running = false;
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
    panel.hidden = true;
    scanStop = null;
  };

  const tick = async () => {
    if (!running) return;
    try {
      const found = await detector.detect(video);
      if (found.length) {
        const text = found[0].rawValue;
        scanStop();
        onText(text);
        return;
      }
    } catch {
      // A frame the detector cannot read is normal; keep looking.
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

$('scan').onclick = () =>
  startScan({
    video: $('cam'),
    panel: $('camera'),
    hint: $('scanhint'),
    onText: (text) => {
      $('inp').value = text;
      $('check').click();
    },
  });

$('stopscan').onclick = () => scanStop?.();

$('scanpayee').onclick = () =>
  startScan({
    video: $('paycamv'),
    panel: $('paycam'),
    onText: (text) => {
      const got = readAddress(text);
      if (!got) {
        $('paysummary').textContent = 'That code is not a Stellar address.';
        $('payout').classList.remove('hide');
        return;
      }
      $('payee').value = got.address;
      // A SEP-7 code can carry the amount too, which saves a step at a counter.
      if (got.amount) {
        $('amount').value = got.amount;
        renderPayCash();
      }
    },
  });

$('stoppaycam').onclick = () => scanStop?.();

// ---- accepting
$('check').onclick = async () => {
  const box = $('result');
  box.innerHTML = '';
  try {
    const v = unpack($('inp').value);
    const good = await verify(v);
    const when = Number(v.auth.expires) * 1000;
    const expired = Date.now() > when;

    if (!good) {
      box.innerHTML = `<div class="msg bad">This voucher has been altered. Do not accept it.</div>`;
      return;
    }
    const d = desk();
    let handOver = '';
    if (d && !expired) {
      const { net, fee } = cashForStroops(BigInt(v.auth.amount), BigInt(d.rate), d.feeBps);
      handOver = `<p class="cashline">Hand over ${money(net, d.currency)}${
        d.feeBps ? ` — ${money(fee, d.currency)} fee kept` : ''
      }</p>`;
    }
    box.innerHTML = `
      <div class="msg ${expired ? 'bad' : 'ok'}">
        <div class="big">${toXLM(v.auth.amount)} XLM</div>
        <div class="sub">signature checks out${expired ? ' — but it expired ' + new Date(when).toLocaleDateString() : ''}</div>
      </div>
      ${handOver}
      <p class="note mono">from ${short(v.auth.payer)}<br>to ${short(v.auth.payee)}</p>`;
    if (!expired) {
      const b = document.createElement('button');
      b.textContent = d ? 'Accept it and hand over the cash' : 'Accept it';
      b.onclick = () => {
        const code = $('inp').value.trim();
        const q = load(QUEUE, []);
        if (q.some((x) => x.code === code)) return alert('Already accepted.');
        q.push({ code, amount: v.auth.amount, at: Date.now(), state: 'held' });
        save(QUEUE, q);
        if (d) recordTrade(v.auth.amount);
        $('inp').value = ''; box.innerHTML = '';
        document.querySelector('nav button[data-v=wallet]').click();
      };
      box.append(b);
    }
  } catch (e) {
    box.innerHTML = `<div class="msg bad">${e.message}</div>`;
  }
};

$('nfcread').onclick = async () => {
  if (!('NDEFReader' in window)) return alert('This phone cannot receive by tap. Scan the QR code or paste it.');
  try {
    const r = new NDEFReader();
    await r.scan();
    r.onreading = (e) => {
      for (const rec of e.message.records) {
        if (rec.recordType === 'text') {
          $('inp').value = new TextDecoder(rec.encoding || 'utf-8').decode(rec.data);
          $('check').click();
        }
      }
    };
    alert('Hold the phones together.');
  } catch (e) { alert(`Tap failed: ${e.message}`); }
};

// ---- banking
//
// The payee is the person least likely to have a funded Stellar account, so the
// wallet does not ask them for one. It hands the voucher to a relayer that
// submits it and pays the fee. The voucher names its payee, so the relayer can
// only submit it, refuse, or be slow -- it cannot send the money anywhere else.
// The app has no dependencies and uses direct fetch rather than an SDK bundle.

/**
 * Turn a raw API error into a sentence a non-developer can act on.
 *
 * The contract speaks in numeric codes. The server translates the most common
 * ones into messages, but those messages were written for logs, not for people
 * holding phones. We translate further here so nobody ever reads "error code 6".
 *
 * Codes come from the Lastmile Soroban contract. The mapping below was verified
 * against the deployed contract's error enum at the time this was written;
 * unknown codes fall through to a generic message that still beats a raw number.
 */
function humanError(body, httpStatus) {
  // The server already caught the most common contract refusals and wrote a
  // message. Check for the "already spent" pattern before any fallthrough.
  const raw = (body.error ?? '').toLowerCase();
  const code = body.code;   // numeric contract error code, when present

  // Contract error 1 = AlreadyRedeemed: the nonce has been consumed.
  // Contract error 2 = VoucherExpired: we already check expiry locally.
  // Contract error 3 = BadSignature: the bytes were mangled in transit.
  // Contract error 4 = UnderFunded: the payer's vault does not cover this.
  // Contract error 5 = WrongPayee: the address on the voucher is not ours.
  // Contract error 6 = NonceReplay: same nonce, different voucher -- fork.
  //
  // 1 and 6 both mean someone else got there first. Remove, do not retry.
  if (code === 1 || code === 6 ||
      raw.includes('already redeemed') || raw.includes('already spent') ||
      raw.includes('nonce') || raw.includes('spent') || raw.includes('replay') ||
      raw.includes('duplicate')) {
    return { plain: 'already banked by someone else', alreadyBanked: true };
  }
  if (code === 2 || raw.includes('expired')) {
    return { plain: 'this voucher has expired and can no longer be banked' };
  }
  if (code === 3 || raw.includes('signature') || raw.includes('bad sig')) {
    return { plain: 'the voucher signature did not check out — it may have been altered' };
  }
  if (code === 4 || raw.includes('underfund') || raw.includes('insufficient') || raw.includes('balance')) {
    return { plain: "the payer's vault does not have enough XLM to cover this voucher" };
  }
  if (code === 5 || raw.includes('wrong payee') || raw.includes('payee')) {
    return { plain: 'this voucher was written for a different address' };
  }
  if (httpStatus === 429 || raw.includes('too many')) {
    return { plain: 'too many requests in a row — wait a minute and try again' };
  }
  if (httpStatus === 503 || raw.includes('not configured') || raw.includes('no submitting')) {
    return { plain: 'this relay is not yet set up to settle vouchers — try another' };
  }
  if (httpStatus >= 500) {
    return { plain: `the relay could not reach the network (${httpStatus}) — keep the voucher and try later` };
  }
  // Fall back to whatever the server said, trimmed, with a lower-case first letter.
  const msg = body.error ?? `the relay answered ${httpStatus}`;
  return { plain: msg.charAt(0).toLowerCase() + msg.slice(1) };
}
}

async function bank(index) {
  // Guard: re-read the queue at call-time so an interleaved update cannot cause
  // us to act on stale data. index is stable within a single render pass.
  const q = load(QUEUE, []);
  const item = q[index];
  if (!item || item.state === 'banked' || item.state === 'banking') return;

  item.state = 'banking';
  delete item.error;
  save(QUEUE, q);
  renderQueue();

  try {
    const res = await fetch('api/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: item.code }),
    });
    const body = await res.json().catch(() => ({}));

    // Re-load the queue after the await; another bank() call may have run
    // concurrently (unlikely but possible on a slow connection with taps).
    const now = load(QUEUE, []);
    const target = now[index];
    if (!target) return; // removed by a concurrent call -- nothing to do

    if (res.ok) {
      // Success: record the on-chain transaction details and mark banked.
      target.state = 'banked';
      target.hash = body.hash;
      target.ledger = body.ledger;
      save(QUEUE, now);
    } else {
      const { plain, alreadyBanked } = humanError(body, res.status);
      if (alreadyBanked) {
        // The nonce has already been consumed on chain -- this voucher is
        // settled. Remove it from the queue rather than leaving it as an
        // error the user cannot fix. We store a brief notice so the screen
        // updates meaningfully rather than just disappearing.
        now.splice(index, 1);
        save(QUEUE, now);
        // Surface a one-time notice in the pending section so the removal is
        // not silent. The notice lives in sessionStorage so it survives a
        // renderQueue() call but is gone once the user navigates away.
        try {
          const notices = JSON.parse(sessionStorage.getItem(NOTICES) ?? '[]');
          notices.push({
            text: `A ${toXLM(target.amount)} XLM voucher was already banked by someone else and has been removed.`,
            at: Date.now(),
          });
          sessionStorage.setItem(NOTICES, JSON.stringify(notices.slice(-5)));
        } catch { /* sessionStorage may be unavailable in private mode */ }
      } else {
        // Any other refusal: keep the voucher so the user can retry later.
        target.state = 'refused';
        target.error = plain;
        save(QUEUE, now);
      }
    }
  } catch (e) {
    // Network-level failure (fetch itself threw). The voucher is intact.
    const now = load(QUEUE, []);
    if (now[index]) {
      now[index].state = 'refused';
      now[index].error = navigator.onLine
        ? `could not reach the relay — check your connection and try again`
        : 'no signal — the voucher is safe here, bank it when you are back online';
      save(QUEUE, now);
    }
  }
  renderQueue();
}

function renderQueue() {
  const q = load(QUEUE, []);
  const el = $('pending');
  if (!el) return;

  // Show any one-time notices from the bank() function (e.g. "already banked
  // elsewhere") before we render the queue. Each notice is shown once.
  let noticeHtml = '';
  try {
    const notices = JSON.parse(sessionStorage.getItem(NOTICES) ?? '[]');
    if (notices.length) {
      noticeHtml = notices
        .map((n) => `<div class="msg bad" style="margin-bottom:10px">${n.text}</div>`)
        .join('');
      sessionStorage.removeItem(NOTICES);
    }
  } catch { /* ignore */ }

  if (!q.length) {
    el.innerHTML = noticeHtml + '<p class="sub">Nothing accepted yet.</p>';
    return;
  }

  // Only count vouchers that are still in flight for the running total.
  // Banked vouchers have left the phone; 'banked-elsewhere' is gone too.
  const pending = q.filter((x) => x.state !== 'banked');
  const total = pending.reduce((a, x) => a + BigInt(x.amount), 0n);

  const label = {
    held:    'not yet banked',
    banking: 'banking…',
    banked:  'banked',
    refused: 'not banked',
  };
  const tone = { held: '', banking: 'busy', banked: 'ok', refused: 'bad' };

  // When offline the button is rendered disabled with the reason in its label
  // rather than as a tooltip, because tooltips do not appear on touch screens.
  const online = navigator.onLine;

  el.innerHTML =
    noticeHtml +
    `<div class="big">${toXLM(total)} XLM</div>
     <div class="sub">${pending.length} voucher${pending.length === 1 ? '' : 's'} held on this phone</div>` +
    q.map((x, i) => {
      const state = x.state ?? 'held';
      const canBank = state === 'held' || state === 'refused';
      const btnLabel = online
        ? (state === 'refused' ? 'Try again' : 'Bank it')
        : 'Bank it — needs a connection';
      return `<div class="queued">
        <div class="head">
          <strong>${toXLM(x.amount)} XLM</strong>
          <span class="state ${tone[state] ?? ''}">` +
            (label[state] ?? state) +
          `</span>
        </div>
        // 16 hex chars is enough to identify the tx on an explorer without card overflow
        ${x.hash ? `<p class="note mono">ledger ${x.ledger} · ${x.hash.slice(0, 16)}…</p>` : ''}
        ${x.error ? `<p class="note">${x.error}</p>` : ''}
        ${canBank ? `<button data-bank="${i}"${online ? '' : ' disabled aria-disabled="true"'}>${btnLabel}</button>` : ''}
      </div>`;
    }).join('');

  for (const b of el.querySelectorAll('[data-bank]')) {
    b.onclick = () => bank(Number(b.dataset.bank));
  }
}

// ---- the cash desk
//
// An agent with a phone and a cash box. Two directions, one instrument: the
// customer signs a voucher and walks away with cash, or hands over cash and
// walks away with a voucher. Neither needs a network at the counter, which is
// the point -- the counter is where there isn't one.

const desk = () => load(DESK, null);

function fillCurrencies() {
  const sel = $('cur');
  if (!sel || sel.options.length) return;
  for (const [code, c] of Object.entries(CURRENCIES)) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = `${code} — ${c.name}`;
    sel.append(o);
  }
}

function showDesk() {
  fillCurrencies();
  const d = desk();
  const state = $('deskstate');
  if (d) {
    $('cur').value = d.currency;
    $('rate').value = String(Number(d.rate) / 10 ** CURRENCIES[d.currency].minor);
    $('fee').value = feeToPercent(d.feeBps);
    state.textContent =
      `Open. One XLM buys ${money(d.rate, d.currency)}, your fee is ${feeToPercent(d.feeBps)}%.`;
    state.classList.remove('warn');
  } else {
    state.textContent = 'Set a rate and this phone can trade cash for XLM.';
  }
  renderPayCash();
  renderTrades();
}

$('savedesk').onclick = () => {
  const err = $('deskerr');
  err.textContent = '';
  try {
    const currency = $('cur').value;
    if (!isCurrency(currency)) throw new Error('Pick a currency');
    const rate = rateFromText($('rate').value, currency);
    if (rate <= 0n) throw new Error('A rate has to be more than nothing');
    const feeBps = feeFromPercent($('fee').value || '0');
    save(DESK, { currency, rate: rate.toString(), feeBps });
    showDesk();
  } catch (e) {
    err.textContent = e.message;
  }
};

$('cleardesk').onclick = () => {
  try { localStorage.removeItem(DESK); } catch {}
  $('rate').value = ''; $('fee').value = '';
  showDesk();
};

/** What the agent hands over for the amount currently typed in. */
function renderPayCash() {
  const el = $('paycash');
  if (!el) return;
  const d = desk();
  const raw = $('amount').value.trim();
  if (!d || !raw) { el.hidden = true; return; }
  try {
    const stroops = toStroops(raw);
    const { net, fee } = cashForStroops(stroops, BigInt(d.rate), d.feeBps);
    el.hidden = false;
    el.classList.remove('muted');
    el.textContent = d.feeBps
      ? `Hand over ${money(net, d.currency)} — ${money(fee, d.currency)} fee kept`
      : `Hand over ${money(net, d.currency)}`;
  } catch {
    el.hidden = true;
  }
}
$('amount').addEventListener('input', renderPayCash);

// ---- getting paid: show a code instead of reading out 56 characters
function showMyCode() {
  if (!device) return;
  const g = encodeAddress(device.publicKey);
  $('myaddr').textContent = g;
  try {
    // SEP-7, so another Stellar wallet can read this too, not only ours.
    $('myqr').innerHTML = qrSVG(payUri({ destination: g }));
    $('myqr').hidden = false;
  } catch {
    $('myqr').hidden = true;
  }
}

$('copyaddr').onclick = async () => {
  try {
    await navigator.clipboard.writeText(encodeAddress(device.publicKey));
    $('copyaddr').textContent = 'Copied';
    setTimeout(() => ($('copyaddr').textContent = 'Copy my address'), 1500);
  } catch { /* the address is on screen either way */ }
};

$('myqrtoggle').onclick = () => {
  const hidden = $('myqr').hidden;
  $('myqr').hidden = !hidden;
  $('myqrtoggle').textContent = hidden ? 'Hide the code' : 'Show the code';
};

// ---- our own float, and how old the reading is
function renderFloat() {
  const f = load(FLOAT, null);
  const fresh = freshness(f?.at);
  $('floatamt').textContent = f ? `${toXLM(f.float)} XLM` : '—';
  $('floatwhen').textContent = f ? `checked ${fresh.text}` : 'never checked';
  $('floatwhen').classList.toggle('warn', !f || fresh.stale);
  $('checkfloat').disabled = !navigator.onLine;
  $('checkfloat').textContent = navigator.onLine ? 'Check it now' : 'Checking needs a connection';
}

$('checkfloat').onclick = async () => {
  const btn = $('checkfloat');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const res = await fetch('api/vault?payer=' + encodeURIComponent(encodeAddress(device.publicKey)));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `The relayer answered ${res.status}.`);
    save(FLOAT, { float: body.float, bond: body.bond, at: Date.now() });
  } catch (e) {
    $('floatwhen').textContent = e.message;
    $('floatwhen').classList.add('warn');
    btn.disabled = false;
    btn.textContent = 'Try again';
    return;
  }
  renderFloat();
};

// ---- the day's cash trades
function renderTrades() {
  const t = load(TRADES, []);
  const card = $('tradecard');
  if (!card) return;
  card.hidden = t.length === 0;
  if (!t.length) return;
  $('trades').innerHTML = t
    .slice()
    .reverse()
    .map(
      (x) => `<div class="trade">
        <span><strong>${toXLM(x.amount)} XLM</strong> for ${x.cash}</span>
        <span class="when">${new Date(x.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>`,
    )
    .join('');
}

$('cleartrades').onclick = () => {
  if (!confirm('Clear the cash log? The vouchers themselves are not affected.')) return;
  try { localStorage.removeItem(TRADES); } catch {}
  renderTrades();
};

function recordTrade(amountStroops) {
  const d = desk();
  if (!d) return;
  const { net } = cashForStroops(BigInt(amountStroops), BigInt(d.rate), d.feeBps);
  const t = load(TRADES, []);
  t.push({ amount: String(amountStroops), cash: money(net, d.currency), at: Date.now() });
  save(TRADES, t.slice(-200));
  renderTrades();
}


// ---- the bank ramp
//
// Everything here is online by definition: an anchor is a business with a bank
// account. The wallet's own half stays offline, which is why this is a separate
// screen and not a step in the pay flow.

let anchor = null;       // the bound anchor, if Connect has succeeded
let rampKind = 'deposit';

const rampErr = (el, msg) => { const e = $(el); e.textContent = msg ?? ''; e.className = msg ? 'note bad' : 'note'; };

async function signWithDevice(hash) {
  if (!device) throw new Error('Create a signing key first.');
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, device.key, hash));
}

$('anchorgo').onclick = async () => {
  const domain = $('anchordom').value.trim().toLowerCase();
  rampErr('anchorerr', '');
  $('anchorgo').disabled = true;
  $('anchorgo').textContent = 'Connecting…';
  try {
    anchor = await useAnchor(domain);
    save(ANCHOR, domain);
    $('anchordomshow').textContent = domain;
    $('anchorkey').textContent = anchor.signingKey;
    $('anchorwho').hidden = false;
    $('rampform').hidden = false;
    fillAssets();
  } catch (e) {
    anchor = null;
    $('anchorwho').hidden = true;
    $('rampform').hidden = true;
    rampErr('anchorerr', e.message);
  } finally {
    $('anchorgo').disabled = false;
    $('anchorgo').textContent = 'Connect';
  }
};

function fillAssets() {
  const list = offered(rampKind === 'deposit' ? anchor.deposit : anchor.withdraw);
  const sel = $('rampasset');
  sel.innerHTML = '';
  for (const a of list) {
    const o = document.createElement('option');
    o.value = a.code;
    o.textContent = a.code === 'native' ? 'XLM' : a.code;
    sel.append(o);
  }
  if (!list.length) {
    const o = document.createElement('option');
    o.textContent = `This anchor does not ${rampKind === 'deposit' ? 'take money in' : 'pay money out'}`;
    sel.append(o);
  }
  sel.disabled = !list.length;
  $('rampgo').disabled = !list.length;
  showLimits();
}

function showLimits() {
  if (!anchor) return;
  const code = $('rampasset').value;
  const a = offered(rampKind === 'deposit' ? anchor.deposit : anchor.withdraw).find((x) => x.code === code);
  if (!a) { $('ramplimits').textContent = ''; return; }
  const bits = [];
  if (a.min != null) bits.push(`at least ${a.min}`);
  if (a.max != null) bits.push(`at most ${a.max}`);
  if (a.fixedFee != null) bits.push(`fee ${a.fixedFee}`);
  if (a.percentFee != null) bits.push(`fee ${a.percentFee}%`);
  $('ramplimits').textContent = bits.length ? bits.join(' · ') : 'No limits published.';
}
$('rampasset').onchange = showLimits;

function pickKind(kind) {
  rampKind = kind;
  $('depbtn').className = kind === 'deposit' ? '' : 'ghost';
  $('wdrbtn').className = kind === 'withdraw' ? '' : 'ghost';
  $('rampgo').textContent = 'Open the anchor';
  if (anchor) fillAssets();
}
$('depbtn').onclick = () => pickKind('deposit');
$('wdrbtn').onclick = () => pickKind('withdraw');

$('rampgo').onclick = async () => {
  rampErr('ramperr', '');
  if (!anchor) return rampErr('ramperr', 'Connect to an anchor first.');
  if (!device) return rampErr('ramperr', 'Create a signing key first — the anchor pays into it.');

  const account = rampAddress(device.publicKey);
  const assetCode = $('rampasset').value;
  const amount = $('rampamt').value.trim();

  $('rampgo').disabled = true;
  $('rampgo').textContent = 'Proving who you are…';
  try {
    // The device key signs a hash it was shown, and only after the anchor's own
    // signature over that hash checked out. See ramp.js.
    const token = await anchor.authenticate(account, signWithDevice);

    $('rampgo').textContent = 'Opening…';
    const { url, id } = await anchor.start(rampKind, {
      assetCode, token, account, amount: amount || undefined,
    });

    const jobs = load(RAMPS, []);
    jobs.unshift({
      id, url, kind: rampKind, assetCode, amount,
      homeDomain: anchor.homeDomain, token, at: Date.now(), status: 'incomplete',
    });
    save(RAMPS, jobs.slice(0, 30));
    renderRamps();

    // A popup blocker is not an error worth a red box: the link is in the list.
    window.open(url, '_blank', 'noopener');
  } catch (e) {
    rampErr('ramperr', e.message);
  } finally {
    $('rampgo').disabled = false;
    $('rampgo').textContent = 'Open the anchor';
  }
};

function renderRamps() {
  const jobs = load(RAMPS, []);
  $('rampjobs').hidden = jobs.length === 0;
  const box = $('rampqueue');
  box.innerHTML = '';
  for (const [i, j] of jobs.entries()) {
    const el = document.createElement('div');
    el.className = 'anchorjob';
    const done = j.status === 'completed';
    const bad = ['error', 'expired', 'no_market', 'too_small', 'too_large'].includes(j.status);
    el.innerHTML = `
      <div class="head">
        <strong>${j.kind === 'deposit' ? 'Cash in' : 'Cash out'} ${j.amount ? j.amount + ' ' : ''}${j.assetCode === 'native' ? 'XLM' : j.assetCode}</strong>
        <span class="state ${done ? 'ok' : bad ? 'bad' : ''}">${plainly(j.status)}</span>
      </div>
      <p class="note">${j.homeDomain} · ${freshness(j.at).text}</p>`;
    if (!settled(j.status)) {
      const a = document.createElement('a');
      a.href = j.url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = 'Open the anchor page';
      a.className = 'note';
      el.append(a);
    }
    const b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = 'Forget this one';
    b.onclick = () => {
      const now = load(RAMPS, []);
      now.splice(i, 1);
      save(RAMPS, now);
      renderRamps();
    };
    el.append(b);
    box.append(el);
  }
}

$('ramprefresh').onclick = async () => {
  const jobs = load(RAMPS, []);
  $('ramprefresh').disabled = true;
  $('ramprefresh').textContent = 'Checking…';
  try {
    for (const j of jobs) {
      if (settled(j.status) || !j.token) continue;
      try {
        const { transaction } = await anchorFor(j.homeDomain).then((a) => a.status(j.id, j.token));
        if (transaction?.status) j.status = transaction.status;
        if (transaction?.amount_in) j.amountIn = transaction.amount_in;
      } catch (e) {
        j.note = e.message;
      }
    }
    save(RAMPS, jobs);
    renderRamps();
  } finally {
    $('ramprefresh').disabled = false;
    $('ramprefresh').textContent = 'Check again';
  }
};

// Polling a job may outlive the binding that created it -- the wallet was
// closed, the anchor was changed. Rebind on demand rather than lose the job.
const bindings = new Map();
async function anchorFor(homeDomain) {
  if (anchor?.homeDomain === homeDomain) return anchor;
  if (!bindings.has(homeDomain)) bindings.set(homeDomain, useAnchor(homeDomain));
  return bindings.get(homeDomain);
}

function restoreRamp() {
  const last = load(ANCHOR, null);
  if (typeof last === 'string' && last) $('anchordom').value = last;
  pickKind('deposit');
  renderRamps();
}

// ---- views
for (const b of document.querySelectorAll('nav button')) {
  b.onclick = () => {
    for (const o of document.querySelectorAll('nav button')) o.removeAttribute('aria-current');
    b.setAttribute('aria-current', 'page');
    for (const v of ['pay', 'recv', 'wallet', 'ramp']) $(`v-${v}`).classList.toggle('hide', v !== b.dataset.v);
    if (b.dataset.v !== 'recv' && b.dataset.v !== 'pay') scanStop?.();
    if (b.dataset.v === 'wallet') {
      renderQueue();
      showDesk();
      showMyCode();
      renderFloat();
    }
    if (b.dataset.v === 'ramp') renderRamps();
  };
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
net();
restore();
renderQueue();
showDesk();
renderFloat();
restoreRamp();
