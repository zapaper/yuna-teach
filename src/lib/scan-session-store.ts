// Client-side IndexedDB persistence for DocumentScanner sessions.
//
// Why: submitting a scanned exam requires uploading N page JPEG blobs
// (~200 KB each) to /api/exam/[id]/scan-submit. If the network dies
// mid-upload, the tab is closed, or the phone locks and the browser
// evicts the tab from memory, the blobs are lost and the parent has to
// re-scan every page from scratch. We persist each captured page to
// IndexedDB the moment it's produced, so a crashed / closed / dropped
// session can pick up where it left off.
//
// Storage shape: one record per (paperId, studentId) pair, holding
// [{ blob, index }...]. Blobs go in as-is — IndexedDB supports Blob
// values natively, no base64 round-trip needed.

const DB_NAME = "yuna-scan-sessions";
const DB_VERSION = 1;
const STORE = "sessions";

export type StoredPage = { blob: Blob; index: number };
export type StoredSession = {
  key: string;           // `${paperId}::${studentId}`
  paperId: string;
  studentId: string;
  pages: StoredPage[];
  updatedAt: number;
};

function sessionKey(paperId: string, studentId: string): string {
  return `${paperId}::${studentId}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("open failed"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = await fn(store);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("tx failed"));
      tx.onabort = () => reject(tx.error ?? new Error("tx aborted"));
    });
    return result;
  } finally {
    db.close();
  }
}

// Overwrite the full session for (paperId, studentId). Callers pass
// the current in-memory page list; we mirror it to disk on every
// mutation (capture, retake, delete). Cheap — IDB is async, doesn't
// block the render thread.
export async function saveScanSession(
  paperId: string,
  studentId: string,
  pages: Array<{ blob: Blob; index: number }>,
): Promise<void> {
  try {
    await withStore("readwrite", (store) => {
      const record: StoredSession = {
        key: sessionKey(paperId, studentId),
        paperId,
        studentId,
        pages: pages.map((p) => ({ blob: p.blob, index: p.index })),
        updatedAt: Date.now(),
      };
      store.put(record);
    });
  } catch (err) {
    // IDB failures are non-fatal — the user can still submit from
    // memory. Log so we can spot Safari quota / private-mode issues.
    console.warn("[scan-session-store] save failed:", err);
  }
}

export async function loadScanSession(
  paperId: string,
  studentId: string,
): Promise<StoredSession | null> {
  try {
    return await withStore("readonly", (store) => {
      return new Promise<StoredSession | null>((resolve, reject) => {
        const req = store.get(sessionKey(paperId, studentId));
        req.onsuccess = () => resolve((req.result as StoredSession | undefined) ?? null);
        req.onerror = () => reject(req.error ?? new Error("get failed"));
      });
    });
  } catch (err) {
    console.warn("[scan-session-store] load failed:", err);
    return null;
  }
}

export async function deleteScanSession(
  paperId: string,
  studentId: string,
): Promise<void> {
  try {
    await withStore("readwrite", (store) => {
      store.delete(sessionKey(paperId, studentId));
    });
  } catch (err) {
    console.warn("[scan-session-store] delete failed:", err);
  }
}

// Prune sessions older than 7 days. Not called by any UI yet, but
// exposed so a future cleanup pass can drop orphaned blobs that were
// never submitted (kid backed out, forgot). Runs off the critical
// path — no awaits in mount / submit hot paths.
export async function pruneOldScanSessions(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  try {
    return await withStore("readwrite", (store) => {
      return new Promise<number>((resolve, reject) => {
        const cutoff = Date.now() - maxAgeMs;
        let dropped = 0;
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) { resolve(dropped); return; }
          const rec = cursor.value as StoredSession;
          if (rec.updatedAt < cutoff) { cursor.delete(); dropped++; }
          cursor.continue();
        };
        req.onerror = () => reject(req.error ?? new Error("cursor failed"));
      });
    });
  } catch {
    return 0;
  }
}
