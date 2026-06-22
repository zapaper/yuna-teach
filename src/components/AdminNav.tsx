"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

const NAV_ITEMS = [
  { icon: "monitor_heart", label: "Marking",       path: "/admin/marking-dashboard", healthBadge: true },
  { icon: "flag",          label: "Flagged Q&A",  path: "/flagged" },
  { icon: "upload_file",   label: "Upload",        path: "/exam/upload" },
  { icon: "library_books", label: "Papers",        path: "/admin/papers" },
  { icon: "school",        label: "Master Class",  path: "/admin/master-class" },
  { icon: "auto_awesome",  label: "Synthetic",     path: "/admin/synthetic" },
  { icon: "tune",          label: "Subpart Marks", path: "/admin/subpart-marks" },
  { icon: "build",         label: "Fix Questions", path: "/admin/fix-questions" },
  { icon: "format_align_left", label: "Key Format", path: "/admin/answer-key-format" },
  { icon: "table_view",    label: "MCQ → Table",  path: "/admin/convert-mcq-tables" },
  { icon: "people",        label: "Manage Users",  path: "/admin/users" },
  { icon: "feedback",      label: "Feedback",      path: "/admin/feedback" },
];

export default function AdminNav({ userId }: { userId: string }) {
  const pathname = usePathname();
  const router = useRouter();

  // Lightweight badge: poll every 60s for stuck + failed marker
  // counts so the nav itself flags when something needs attention.
  // No need to render a number when both are zero — the count is
  // hidden and the nav looks normal.
  const [markerProblems, setMarkerProblems] = useState<{ stuck: number; failed: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/api/admin/marking-health-count");
        if (!r.ok || cancelled) return;
        const d = (await r.json()) as { stuck?: number; failed?: number };
        if (!cancelled) setMarkerProblems({ stuck: d.stuck ?? 0, failed: d.failed ?? 0 });
      } catch { /* nav badge is non-critical */ }
    }
    load();
    const id = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  const markerProblemCount = (markerProblems?.stuck ?? 0) + (markerProblems?.failed ?? 0);

  function go(path: string) {
    router.push(`${path}?userId=${userId}`);
  }

  return (
    <>
      {/* ── Desktop sidebar ── */}
      <aside className="hidden lg:flex fixed left-0 top-0 h-full w-56 bg-slate-900 flex-col z-40">
        <div className="px-5 py-5 border-b border-white/10">
          <p className="text-xs font-bold text-white/40 uppercase tracking-widest">Admin Panel</p>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV_ITEMS.map(item => {
            const active = pathname.startsWith(item.path);
            const showBadge = item.healthBadge && markerProblemCount > 0;
            return (
              <button
                key={item.path}
                onClick={() => go(item.path)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                  active ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"
                }`}
              >
                <span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0" }}>
                  {item.icon}
                </span>
                <span className="flex-1 text-left">{item.label}</span>
                {showBadge && (
                  <span
                    className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-500 text-white min-w-[18px] text-center"
                    title={`${markerProblems?.failed ?? 0} failed · ${markerProblems?.stuck ?? 0} stuck`}
                  >
                    {markerProblemCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="px-3 py-4 border-t border-white/10">
          <button
            onClick={() => router.push(`/home/${userId}`)}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-white/50 hover:text-white hover:bg-white/10 transition-colors"
          >
            <span className="material-symbols-outlined text-xl">arrow_back</span>
            Back to Home
          </button>
        </div>
      </aside>

      {/* ── Mobile bottom bar ── */}
      <nav className="lg:hidden fixed bottom-0 left-0 w-full z-50 bg-slate-900 flex justify-around items-center px-2 pb-safe pt-2 border-t border-white/10">
        {NAV_ITEMS.map(item => {
          const active = pathname.startsWith(item.path);
          const showBadge = item.healthBadge && markerProblemCount > 0;
          return (
            <button
              key={item.path}
              onClick={() => go(item.path)}
              className={`relative flex flex-col items-center gap-0.5 px-3 py-2 transition-colors ${active ? "text-white" : "text-white/50"}`}
            >
              <span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0" }}>
                {item.icon}
              </span>
              <span className="text-[10px] font-medium">{item.label}</span>
              {showBadge && (
                <span className="absolute top-1 right-1 text-[9px] font-bold px-1 py-0 rounded-full bg-red-500 text-white min-w-[14px] text-center leading-tight">
                  {markerProblemCount}
                </span>
              )}
            </button>
          );
        })}
        <button
          onClick={() => router.push(`/home/${userId}`)}
          className="flex flex-col items-center gap-0.5 px-3 py-2 text-white/50"
        >
          <span className="material-symbols-outlined text-xl">home</span>
          <span className="text-[10px] font-medium">Home</span>
        </button>
      </nav>
    </>
  );
}
