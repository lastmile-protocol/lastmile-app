// The wallet. Everything here works with the radio off except banking, which by
// definition cannot.

import {
  newDevice, importDevice, sign, verify, pack, unpack,
  encodeAddress, decodeAddress, hex, unhex,
} from './lastmile.js';
import { loadDevice, saveDevice, forgetDevice } from './store.js';
import { qrSVG } from './qr.js';

const $ = (id) => document.getElementById(id);
const LEGACY = 'lastmile.device.v1'; // where the key used to live, in the clear
const QUEUE = 'lastmile.accepted.v1';

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
let scanStop = null;

$('scan').onclick = async () => {
  if (!('BarcodeDetector' in window)) {
    return alert(
      'This browser cannot read QR codes from the camera. ' +
      'Paste the code instead, or use Chrome on Android.',
    );
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) {
    return alert(`No camera: ${e.message}`);
  }
  const video = $('cam');
  video.srcObject = stream;
  await video.play();
  $('camera').hidden = false;
  $('scanhint').textContent = 'Hold the code steady in the frame.';

  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  let running = true;
  scanStop = () => {
    running = false;
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
    $('camera').hidden = true;
    scanStop = null;
  };

  const tick = async () => {
    if (!running) return;
    try {
      const found = await detector.detect(video);
      if (found.length) {
        const text = found[0].rawValue;
        scanStop();
        $('inp').value = text;
        $('check').click();
        return;
      }
    } catch {
      // A frame the detector cannot read is normal; keep looking.
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

$('stopscan').onclick = () => scanStop?.();

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
    box.innerHTML = `
      <div class="msg ${expired ? 'bad' : 'ok'}">
        <div class="big">${toXLM(v.auth.amount)} XLM</div>
        <div class="sub">signature checks out${expired ? ' — but it expired ' + new Date(when).toLocaleDateString() : ''}</div>
      </div>
      <p class="note mono">from ${short(v.auth.payer)}<br>to ${short(v.auth.payee)}</p>`;
    if (!expired) {
      const b = document.createElement('button');
      b.textContent = 'Accept it';
      b.onclick = () => {
        const code = $('inp').value.trim();
        const q = load(QUEUE, []);
        if (q.some((x) => x.code === code)) return alert('Already accepted.');
        q.push({ code, amount: v.auth.amount, at: Date.now(), state: 'held' });
        save(QUEUE, q);
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
async function bank(index) {
  const q = load(QUEUE, []);
  const item = q[index];
  if (!item || item.state === 'banked') return;

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
    const now = load(QUEUE, []);
    const target = now[index];
    if (!target) return;

    if (res.ok) {
      target.state = 'banked';
      target.hash = body.hash;
      target.ledger = body.ledger;
    } else {
      target.state = 'refused';
      target.error = body.error ?? `The relayer answered ${res.status}.`;
    }
    save(QUEUE, now);
  } catch (e) {
    const now = load(QUEUE, []);
    if (now[index]) {
      now[index].state = 'refused';
      now[index].error = navigator.onLine
        ? `Could not reach the relayer: ${e.message}`
        : 'No signal. The voucher is safe here; bank it when you have a connection.';
      save(QUEUE, now);
    }
  }
  renderQueue();
}

function renderQueue() {
  const q = load(QUEUE, []);
  const el = $('pending');
  if (!el) return;
  if (!q.length) { el.innerHTML = '<p class="sub">Nothing accepted yet.</p>'; return; }

  const held = q.filter((x) => x.state !== 'banked');
  const total = held.reduce((a, x) => a + BigInt(x.amount), 0n);

  const label = {
    held: 'not yet banked',
    banking: 'banking…',
    banked: 'banked',
    refused: 'not banked',
  };
  const tone = { held: '', banking: 'busy', banked: 'ok', refused: 'bad' };

  el.innerHTML =
    `<div class="big">${toXLM(total)} XLM</div>
     <div class="sub">${held.length} voucher${held.length === 1 ? '' : 's'} held on this phone</div>` +
    q.map((x, i) => {
      const state = x.state ?? 'held';
      const canBank = state === 'held' || state === 'refused';
      return `<div class="queued">
        <div class="head">
          <strong>${toXLM(x.amount)} XLM</strong>
          <span class="state ${tone[state]}">${label[state]}</span>
        </div>
        ${x.hash ? `<p class="note mono">ledger ${x.ledger} · ${x.hash.slice(0, 16)}…</p>` : ''}
        ${x.error ? `<p class="note">${x.error}</p>` : ''}
        ${canBank ? `<button data-bank="${i}"${navigator.onLine ? '' : ' disabled'}>
          ${navigator.onLine ? (state === 'refused' ? 'Try again' : 'Bank it') : 'Bank it — needs a connection'}
        </button>` : ''}
      </div>`;
    }).join('');

  for (const b of el.querySelectorAll('[data-bank]')) {
    b.onclick = () => bank(Number(b.dataset.bank));
  }
}

// ---- views
for (const b of document.querySelectorAll('nav button')) {
  b.onclick = () => {
    for (const o of document.querySelectorAll('nav button')) o.removeAttribute('aria-current');
    b.setAttribute('aria-current', 'page');
    for (const v of ['pay', 'recv', 'wallet']) $(`v-${v}`).classList.toggle('hide', v !== b.dataset.v);
    if (b.dataset.v !== 'recv') scanStop?.();
    if (b.dataset.v === 'wallet') renderQueue();
  };
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
net();
restore();
renderQueue();
