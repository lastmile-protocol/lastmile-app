// Where the signing key lives.
//
// It used to live in localStorage as plain hex. Any script that reached this
// origin could read it, and it sat there in the clear on disk. A key that can
// spend money should not be a string anything can copy.
//
// IndexedDB can store a CryptoKey object itself. Paired with a non-extractable
// key, that means the browser will sign with it on request and refuse to export
// it: a script on this origin can still spend while it is running, but it
// cannot take the key away and spend later, anywhere, forever.

const DB = 'lastmile';
const STORE = 'keys';
const ID = 'device';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, run) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

/** The stored device, or null. `key` comes back as a CryptoKey, not bytes. */
export async function loadDevice() {
  try {
    const got = await tx('readonly', (s) => s.get(ID));
    if (!got?.key || !got?.publicKey) return null;
    return { key: got.key, publicKey: new Uint8Array(got.publicKey) };
  } catch {
    // Private windows and locked-down profiles can refuse IndexedDB outright.
    return null;
  }
}

export async function saveDevice(device) {
  await tx('readwrite', (s) =>
    s.put({ key: device.key, publicKey: device.publicKey }, ID),
  );
}

export async function forgetDevice() {
  try {
    await tx('readwrite', (s) => s.delete(ID));
  } catch {
    /* nothing stored, or storage unavailable; either way it is gone */
  }
}

/** Does this browser do what the wallet needs? Checked before promising anything. */
export async function storageWorks() {
  if (typeof indexedDB === 'undefined') return false;
  try {
    await tx('readonly', (s) => s.get('__probe'));
    return true;
  } catch {
    return false;
  }
}
