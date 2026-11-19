// IndexedDB persistence for machined parts (Z-map heights and shading are typed arrays, too big and too
// binary for localStorage). One database 'milllab-game', object store 'parts', keyed by slot:
// 'vise' (blank / part clamped in the machine), 'carry' (part in the player's hands), 'plate' (part on
// the inspection plate, with its report and measurement log). Every call degrades to a no-op when
// IndexedDB is unavailable or blocked (private mode, storage disabled): the game then just does not
// remember machined parts across reloads.
const DB = 'milllab-game';
const STORE = 'parts';

let dbp = null;
let handle = null; // the open database once ready (lets pagehide start a write synchronously)
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore(STORE); } catch { /* exists */ }
      };
      req.onsuccess = () => {
        const d = req.result;
        d.onversionchange = () => { d.close(); handle = null; };
        handle = d;
        resolve(d);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

function txn(d, mode, fn, resolve) {
  try {
    const tx = d.transaction(STORE, mode);
    const st = tx.objectStore(STORE);
    const req = fn(st);
    tx.oncomplete = () => resolve(req ? req.result ?? null : true);
    tx.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
    // writes: hand the transaction to the database right away (survives a page unload better)
    if (mode === 'readwrite' && typeof tx.commit === 'function') tx.commit();
  } catch {
    resolve(null);
  }
}

function run(mode, fn) {
  if (handle) return new Promise((resolve) => txn(handle, mode, fn, resolve));
  return db().then((d) => new Promise((resolve) => {
    if (!d) return resolve(null);
    txn(d, mode, fn, resolve);
  })).catch(() => null);
}

export const partStore = {
  get: (key) => run('readonly', (st) => st.get(key)),
  put: (key, value) => run('readwrite', (st) => st.put(value, key)),
  del: (key) => run('readwrite', (st) => st.delete(key)),
};

// ---- Z-map (de)serialisation: plain object with the typed arrays (structured clone keeps them)
const ZFIELDS = ['x0', 'y0', 'lx', 'ly', 'top', 'bottom', 'nx', 'ny', 'dx', 'dy', 'cell', 'cellArea', 'T', 'tilesX', 'tilesY', 'initialVolume', 'removedTotal', 'lowest'];

export function zmapState(z) {
  const o = {};
  for (const k of ZFIELDS) o[k] = z[k];
  o.h = z.h.slice();
  o.shade = z.shade.slice();
  return o;
}

// Copy a saved state into an existing ZMap of the same grid (returns false if the grid differs).
export function applyZMapState(z, s) {
  if (!s || z.nx !== s.nx || z.ny !== s.ny || Math.abs(z.x0 - s.x0) > 1e-6 || Math.abs(z.y0 - s.y0) > 1e-6 || Math.abs(z.top - s.top) > 1e-6 || Math.abs(z.bottom - s.bottom) > 1e-6) return false;
  if (!(s.h instanceof Float32Array) || s.h.length !== z.h.length || !(s.shade instanceof Uint8Array) || s.shade.length !== z.shade.length) return false;
  z.h.set(s.h);
  z.shade.set(s.shade);
  z.removedTotal = s.removedTotal || 0;
  z.lowest = s.lowest ?? z.top;
  z.shankExcess = 0;
  z.markAllDirty();
  return true;
}

// Build a standalone ZMap-like object (ZMap prototype) from a saved state.
export function zmapFromState(proto, s) {
  if (!s || !(s.h instanceof Float32Array) || !(s.shade instanceof Uint8Array) || s.h.length !== s.nx * s.ny) return null;
  const z = Object.create(proto);
  for (const k of ZFIELDS) z[k] = s[k];
  z.h = s.h;
  z.shade = s.shade;
  z.dirty = new Uint8Array(s.tilesX * s.tilesY).fill(1);
  z.anyDirty = true;
  z.edgeDirty = true;
  z.shankExcess = 0;
  return z;
}
