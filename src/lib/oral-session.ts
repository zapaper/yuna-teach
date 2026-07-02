// LocalStorage-backed session carrying student progress across the
// three practice screens:
//   /admin/english-oral-coach              (theme picker + Start)
//   /admin/english-oral-coach/read/Y/D     (Reading Aloud, 15 marks)
//   /admin/english-oral-coach/sbc/Y/D      (Stimulus Conversation, 25 marks)
//   /admin/english-oral-coach/results      (aggregate + save)
//
// The user picks a theme (year, day). Reading Aloud runs against
// that theme's passage. When Reading is done, we pick a RANDOM SBC
// day (1 or 2 for the same year) and jump into SBC. When SBC is
// done, the results screen surfaces the /40 total plus top tips.
//
// Everything is client-side JSON in localStorage under one key so
// the three screens can hand off without server round-trips. A
// separate "save session" endpoint (POST /api/oral-coach/save-
// session) is fired from the results page and persists everything
// to the DB + uploads the two audio blobs to R2.

export type OralSessionReading = {
  year: string;
  day: number;
  pronunciation: number;
  fluencyRhythm: number;
  expressiveness: number;
  total: number;         // /15
  topTips: string[];     // 1-3 short one-liners for the aggregate summary
  recordingBlobKey?: string; // key for IDB blob store (recordings are too big for localStorage)
};

export type OralSessionSbc = {
  year: string;
  day: number;               // the RANDOM day picked at continuation
  overallSeabScore: number;  // /25
  overallPercent: number;    // 0-100
  overallVerdict: string;
  q1Percent: number;
  q2Percent: number;
  q3Percent: number;
  topTips: string[];
  recordingBlobKey?: string;
};

export type OralSession = {
  themeId: string;
  themeLabel: string;
  avatarKey: string;
  startedAt: number;
  reading?: OralSessionReading;
  sbc?: OralSessionSbc;
};

const KEY = "oral-session";

export function loadOralSession(): OralSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as OralSession;
  } catch {
    return null;
  }
}

export function saveOralSession(session: OralSession) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(session));
}

export function clearOralSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}

export function updateOralSession(patch: Partial<OralSession>): OralSession | null {
  const prev = loadOralSession();
  if (!prev) return null;
  const next = { ...prev, ...patch };
  saveOralSession(next);
  return next;
}

// Randomly pick day 1 or 2 for the SBC continuation. Injected here
// so the read + SBC pages share one implementation.
export function pickRandomSbcDay(): 1 | 2 {
  return Math.random() < 0.5 ? 1 : 2;
}
