"use client";

import { useEffect, useState } from "react";

// Homepage widget — shows the current user's previously-saved practice
// sessions for a given module (english / chinese). Fetched from
// /api/oral-coach/list-sessions. Empty state renders as a subtle
// "no history yet" panel so the module isn't cluttered on first use.

type StoredSession = {
  savedAt: number;
  themeId: string;
  themeLabel: string;
  module: "english" | "chinese";
  reading?: { total?: number };
  sbc?: { overallSeabScore?: number; q1Percent?: number; q2Percent?: number; q3Percent?: number };
  combined: number;
};

type Props = {
  /** Which module's sessions to fetch + display. */
  module: "english" | "chinese";
  /** Copy overrides — the Chinese homepage passes Mandarin labels. */
  labels?: {
    heading?: string;         // e.g. "Previous sessions" / "过去练习"
    emptyState?: string;
    readingLabel?: string;    // e.g. "Reading" / "朗读"
    sbcLabel?: string;        // e.g. "SBC" / "会话"
    skippedLabel?: string;    // e.g. "skipped" / "跳过"
    totalOutOfIfSkipped?: number;   // 25 for English, 30 for Chinese
    totalOutOfIfFull?: number;      // 40 for both
  };
};

export function OralSessionHistory({ module, labels = {} }: Props) {
  const {
    heading = "Previous sessions",
    emptyState = "No saved sessions yet. Finish a practice and click Save to build up your history.",
    readingLabel = "Reading",
    sbcLabel = "SBC",
    skippedLabel = "skipped",
    totalOutOfIfSkipped = module === "chinese" ? 30 : 25,
    totalOutOfIfFull = 40,
  } = labels;

  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");

  useEffect(() => {
    fetch(`/api/oral-coach/list-sessions?module=${module}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json: { sessions: StoredSession[] }) => {
        setSessions(json.sessions ?? []);
        setState("loaded");
      })
      .catch(() => setState("error"));
  }, [module]);

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">{heading}</p>
      {state === "loading" && <p className="text-xs text-slate-400">Loading…</p>}
      {state === "error" && <p className="text-xs text-rose-600">Couldn&apos;t load history.</p>}
      {state === "loaded" && sessions.length === 0 && (
        <p className="text-xs text-slate-400 italic">{emptyState}</p>
      )}
      {state === "loaded" && sessions.length > 0 && (
        <ul className="space-y-1.5">
          {sessions.map((s, i) => {
            const readingSkipped = !s.reading;
            const outOf = readingSkipped ? totalOutOfIfSkipped : totalOutOfIfFull;
            return (
              <li
                key={`${s.savedAt}_${i}`}
                className="flex items-center gap-3 rounded-lg border border-slate-100 bg-slate-50 hover:bg-slate-100 transition px-3 py-2"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-slate-800 truncate">{s.themeLabel}</p>
                    {readingSkipped && (
                      <span className="text-[9px] uppercase tracking-wide bg-slate-200 text-slate-500 px-1.5 py-0.5 rounded-full flex-shrink-0">
                        {readingLabel} {skippedLabel}
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-400">{formatWhen(s.savedAt)}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-lg font-bold text-slate-800 leading-none">{s.combined}</p>
                  <p className="text-[10px] text-slate-500">/ {outOf}</p>
                </div>
                <div className="hidden sm:flex flex-col gap-0.5 text-[10px] text-slate-500 min-w-[80px]">
                  {s.reading && <span>{readingLabel} {s.reading.total?.toFixed(1)}</span>}
                  {s.sbc && <span>{sbcLabel} {s.sbc.overallSeabScore}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function formatWhen(ts: number): string {
  const now = Date.now();
  const diffMin = Math.floor((now - ts) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
