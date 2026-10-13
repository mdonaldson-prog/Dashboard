// Keeps the last loaded dataset in this browser (IndexedDB) so the dashboard opens with data.
// Nothing leaves the computer. Clearing browser data or "Forget saved data" removes it.

import type { Dataset } from "./model";

const DB = "execdash";
const STORE = "datasets";
const KEY = "last";

function open(db = DB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(db, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, dbName = DB): Promise<T> {
  const db = await open(dbName);
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function saveDataset(ds: Dataset): Promise<boolean> {
  try {
    await run("readwrite", (s) => s.put(ds, KEY));
    return true;
  } catch {
    return false; // storage blocked or full: the dashboard still works for this session
  }
}

export async function loadDataset(): Promise<Dataset | null> {
  try {
    return ((await run("readonly", (s) => s.get(KEY))) as Dataset | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function forgetDataset(): Promise<void> {
  try {
    await run("readwrite", (s) => s.delete(KEY));
  } catch {
    /* nothing saved */
  }
}

/** The same store under another database name (the Forecast page keeps its own copy). */
export function namedStore<T>(dbName: string) {
  return {
    save: async (v: T) => { try { await run("readwrite", (s) => s.put(v, KEY), dbName); return true; } catch { return false; } },
    load: async () => { try { return ((await run("readonly", (s) => s.get(KEY), dbName)) as T | undefined) ?? null; } catch { return null; } },
    forget: async () => { try { await run("readwrite", (s) => s.delete(KEY), dbName); } catch { /* nothing saved */ } },
  };
}
