// Save-with-retry + localStorage outbox.
//
// Protects student answer saves (MCQ clicks, typed answers, OEQ canvas
// uploads) against transient server failures — most importantly the
// Mark/David scenario where a deploy outage dropped in-flight PATCH/
// POST requests on the floor and the answers never reached the DB.
//
// Strategy:
//   1. Cache every attempted save in a localStorage outbox before
//      firing it.
//   2. Retry the fetch with exponential backoff (immediate → 2s → 8s
//      → 30s).
//   3. On a 2xx response, remove the entry from the outbox.
//   4. On 401/403, give up (session expired — no point hammering).
//   5. On other failures, leave the entry in the outbox; next time
//      the quiz page loads, drainOutboxForPaper() replays it.
//
// FormData entries (OEQ canvas blobs) are stored as base64 dataURLs in
// localStorage so the entire request is reconstructable on replay.
//
// Scope cap: only covers SENT requests. If the student draws on a
// canvas and closes the tab before hitting "save progress", that data
// was never in any save attempt, so we have nothing to replay. A
// follow-up commit could add periodic canvas → localStorage snapshots
// for that case.

const OUTBOX_KEY = "yuna_save_outbox_v1";
// Total worst case: 0 + 2 + 8 + 30 = 40s of in-process retries.
// Anything beyond that is left for next-page-load drain.
const BACKOFF_MS = [0, 2000, 8000, 30000];

type JsonEntry = {
  kind: "json";
  id: string;
  paperId: string;
  url: string;
  method: "PATCH" | "POST";
  body: string;
  createdAt: number;
};

type FormEntry = {
  kind: "form";
  id: string;
  paperId: string;
  url: string;
  fields: Record<string, string>;
  blobs: Record<string, { dataUrl: string; filename: string; mime: string }>;
  createdAt: number;
};

type OutboxEntry = JsonEntry | FormEntry;

function readOutbox(): OutboxEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(OUTBOX_KEY);
    return raw ? (JSON.parse(raw) as OutboxEntry[]) : [];
  } catch {
    return [];
  }
}

function writeOutbox(entries: OutboxEntry[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries));
  } catch (err) {
    // Quota exceeded is the main case — best effort, don't crash the
    // save flow over a missed cache write.
    console.warn("[save-with-retry] outbox write failed:", err);
  }
}

function upsertEntry(entry: OutboxEntry) {
  const entries = readOutbox().filter(e => e.id !== entry.id);
  entries.push(entry);
  writeOutbox(entries);
}

function removeEntry(id: string) {
  writeOutbox(readOutbox().filter(e => e.id !== id));
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Patch a JSON body to a question/paper endpoint. Returns true on a
// confirmed 2xx, false otherwise (network failure persisted, auth
// failure, or non-2xx). Either way, localStorage holds the body until
// the next successful drain.
export async function patchJsonWithRetry(args: {
  paperId: string;
  url: string;
  body: Record<string, unknown>;
  // Stable id so repeated saves for the same target (e.g. an MCQ that
  // the student keeps changing) collapse into one outbox entry rather
  // than piling up.
  cacheId: string;
}): Promise<boolean> {
  const entry: JsonEntry = {
    kind: "json",
    id: args.cacheId,
    paperId: args.paperId,
    url: args.url,
    method: "PATCH",
    body: JSON.stringify(args.body),
    createdAt: Date.now(),
  };
  upsertEntry(entry);
  for (let i = 0; i < BACKOFF_MS.length; i++) {
    if (BACKOFF_MS[i] > 0) await new Promise(r => setTimeout(r, BACKOFF_MS[i]));
    try {
      const res = await fetch(args.url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: entry.body,
      });
      if (res.ok) {
        removeEntry(args.cacheId);
        return true;
      }
      if (res.status === 401 || res.status === 403) {
        // Session expired — no point retrying. Leave the entry in
        // case the user re-logs in and reloads the page (drain will
        // pick it up).
        return false;
      }
    } catch {
      // Network blip — fall through to the next backoff slot.
    }
  }
  return false;
}

// Post a FormData (with optional Blob fields) to a paper endpoint.
// Blobs are cached as base64 dataURLs so the request is rebuildable
// after a refresh.
export async function postFormWithRetry(args: {
  paperId: string;
  url: string;
  fields: Record<string, string>;
  blobs: Record<string, { blob: Blob; filename: string }>;
  cacheId: string;
}): Promise<boolean> {
  const blobsAsDataUrls: Record<string, { dataUrl: string; filename: string; mime: string }> = {};
  for (const [k, v] of Object.entries(args.blobs)) {
    blobsAsDataUrls[k] = {
      dataUrl: await blobToDataUrl(v.blob),
      filename: v.filename,
      mime: v.blob.type || "application/octet-stream",
    };
  }
  const entry: FormEntry = {
    kind: "form",
    id: args.cacheId,
    paperId: args.paperId,
    url: args.url,
    fields: args.fields,
    blobs: blobsAsDataUrls,
    createdAt: Date.now(),
  };
  upsertEntry(entry);
  for (let i = 0; i < BACKOFF_MS.length; i++) {
    if (BACKOFF_MS[i] > 0) await new Promise(r => setTimeout(r, BACKOFF_MS[i]));
    try {
      const form = new FormData();
      for (const [k, v] of Object.entries(args.fields)) form.append(k, v);
      for (const [k, v] of Object.entries(args.blobs)) form.append(k, v.blob, v.filename);
      const res = await fetch(args.url, { method: "POST", body: form });
      if (res.ok) {
        removeEntry(args.cacheId);
        return true;
      }
      if (res.status === 401 || res.status === 403) return false;
    } catch {
      // Retry next slot.
    }
  }
  return false;
}

// Replay any unsent outbox entries for the given paper. Call on quiz
// page load (or any time the user returns to an in-progress paper).
// Entries that succeed are removed; those that still fail stay in
// place for the next attempt.
export async function drainOutboxForPaper(paperId: string): Promise<{ replayed: number; remaining: number }> {
  const entries = readOutbox().filter(e => e.paperId === paperId);
  let replayed = 0;
  for (const entry of entries) {
    try {
      if (entry.kind === "json") {
        const res = await fetch(entry.url, {
          method: entry.method,
          headers: { "Content-Type": "application/json" },
          body: entry.body,
        });
        if (res.ok) {
          removeEntry(entry.id);
          replayed++;
        }
      } else {
        const form = new FormData();
        for (const [k, v] of Object.entries(entry.fields)) form.append(k, v);
        for (const [k, v] of Object.entries(entry.blobs)) {
          const blob = await dataUrlToBlob(v.dataUrl);
          form.append(k, blob, v.filename);
        }
        const res = await fetch(entry.url, { method: "POST", body: form });
        if (res.ok) {
          removeEntry(entry.id);
          replayed++;
        }
      }
    } catch {
      // Still down — leave the entry, try again next time.
    }
  }
  const remaining = readOutbox().filter(e => e.paperId === paperId).length;
  return { replayed, remaining };
}
