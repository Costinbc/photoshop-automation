// Template storage + user context — the two seams the plan calls out for later
// expansion. Everything here is a thin interface over a LOCAL implementation
// (browser IndexedDB) today; the signatures are chosen so a server-backed
// version drops in without callers changing:
//
//   saveTemplate({id, manifest, psdBytes, thumbBytes})  -> POST /api/templates (R2 + KV/D1)
//   listSavedTemplates()                                 -> GET  /api/templates
//   currentUser()                                        -> a real user; scope by ownerId
//
// Locally-saved templates live only in the browser that made them. The dev then
// commits the PSD + manifest to the repo for everyone (the download bundle from
// the prep page). Server storage (phase 4) makes them shared automatically.

const DB_NAME = "cardmaker";
const STORE = "templates";

// Anonymous, single shared workspace for now. When auth lands this returns a
// real user and the storage calls below scope by `user.id` (ownerId). Keeping
// callers written against this today means the scoping change stays local.
export function currentUser() {
  return null;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

// Persist a prepped template (its manifest + cleaned PSD + thumbnail) so it's
// usable immediately in this browser. `psdBytes`/`thumbBytes` are Uint8Arrays;
// IndexedDB stores them as-is (no base64). Returns the stored record.
export async function saveTemplate({ id, label, category, manifest, psdBytes, thumbBytes }) {
  if (!id) throw new Error("saveTemplate: id is required");
  const record = {
    id,
    ownerId: currentUser()?.id ?? null, // null = shared/public (matches the future data model)
    label: label || manifest?.name || id,
    category: category || null,
    manifest,
    psdBytes,
    thumbBytes,
    createdAt: Date.now(),
  };
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const req = tx(db, "readwrite").put(record);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
  db.close();
  return record;
}

// Registry-shaped list of locally-saved templates ({id, label, category}), so a
// gallery can merge these with the static index. Bytes are omitted here — fetch
// the full record with getSavedTemplate when actually rendering.
export async function listSavedTemplates() {
  const db = await openDb();
  const all = await new Promise((resolve, reject) => {
    const req = tx(db, "readonly").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return all.map(({ id, label, category }) => ({ id, label, category }));
}

// Full stored record (including psdBytes/thumbBytes/manifest), or null.
export async function getSavedTemplate(id) {
  const db = await openDb();
  const rec = await new Promise((resolve, reject) => {
    const req = tx(db, "readonly").get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return rec;
}
