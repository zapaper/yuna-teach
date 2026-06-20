"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

type SignupBucket = { date: string; newUsers: number; cumulative: number };

// Inline SVG signup chart — 14 days of new-user counts (bars) with the
// cumulative total user count (line) overlaid. Self-contained so we
// don't pull in a chart library for one panel.
function SignupChart({ data }: { data: SignupBucket[] }) {
  // Mount-time animation: bars start at scaleY(0) anchored at the
  // baseline and grow to scaleY(1) over ~600 ms with a small per-bar
  // delay so the columns sweep up left-to-right. useEffect flips the
  // state on the next paint, so the initial render is at 0 and the
  // transition to 1 is the animation. Honours prefers-reduced-motion
  // — readers who've turned animations off see the final state
  // immediately.
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) { setGrown(true); return; }
    const id = window.requestAnimationFrame(() => setGrown(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  if (data.length === 0) return null;
  const W = 700;
  const H = 160;
  const padL = 36;
  const padR = 40;
  const padT = 10;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxNew = Math.max(1, ...data.map(d => d.newUsers));
  const maxCum = Math.max(1, ...data.map(d => d.cumulative));
  const barW = plotW / data.length * 0.7;
  const stepX = plotW / data.length;
  const newY = (n: number) => padT + plotH - (n / maxNew) * plotH;
  const cumY = (n: number) => padT + plotH - (n / maxCum) * plotH;
  const linePts = data.map((d, i) => `${padL + i * stepX + stepX / 2},${cumY(d.cumulative)}`).join(" ");
  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-4">
      <div className="flex items-baseline gap-4 mb-2">
        <h2 className="text-sm font-bold text-slate-700">Signups — last 14 days</h2>
        <span className="text-[11px] text-slate-400">bars = new users that day · line = cumulative total</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="xMidYMid meet">
        {/* horizontal gridlines (1/4, 1/2, 3/4) */}
        {[0.25, 0.5, 0.75].map(f => (
          <line key={f} x1={padL} x2={padL + plotW} y1={padT + plotH * f} y2={padT + plotH * f} stroke="#e2e8f0" strokeDasharray="3 3" />
        ))}
        {/* daily bars — grow from baseline via scaleY transform.
            transform-origin sits at the bar's baseline (bottom-centre
            in SVG units); transform-box keeps the origin local to the
            element. Per-bar delay (i * 35 ms) sweeps L→R. */}
        {data.map((d, i) => {
          const barHeight = padT + plotH - newY(d.newUsers);
          const barX = padL + i * stepX + (stepX - barW) / 2;
          const barBaselineY = padT + plotH;
          return (
            <rect key={d.date}
              x={barX}
              y={newY(d.newUsers)}
              width={barW}
              height={barHeight}
              fill="#10b981"
              rx={2}
              style={{
                transformOrigin: `${barX + barW / 2}px ${barBaselineY}px`,
                transformBox: "view-box",
                transform: grown ? "scaleY(1)" : "scaleY(0)",
                transition: `transform 600ms cubic-bezier(0.22, 1, 0.36, 1) ${i * 35}ms`,
              }}
            >
              <title>{`${d.date}: +${d.newUsers} new · total ${d.cumulative}`}</title>
            </rect>
          );
        })}
        {/* cumulative line */}
        <polyline fill="none" stroke="#3b82f6" strokeWidth="2" points={linePts} />
        {data.map((d, i) => (
          <circle key={`c-${d.date}`} cx={padL + i * stepX + stepX / 2} cy={cumY(d.cumulative)} r={3} fill="#3b82f6" />
        ))}
        {/* left axis labels — new-user max + 0 */}
        <text x={padL - 6} y={padT + 4} textAnchor="end" fontSize="10" fill="#64748b">{maxNew}</text>
        <text x={padL - 6} y={padT + plotH} textAnchor="end" fontSize="10" fill="#64748b">0</text>
        {/* right axis labels — cumulative max + start */}
        <text x={padL + plotW + 6} y={padT + 4} fontSize="10" fill="#3b82f6">{maxCum}</text>
        <text x={padL + plotW + 6} y={padT + plotH} fontSize="10" fill="#3b82f6">{data[0]?.cumulative ?? 0}</text>
        {/* date labels — first, mid, last */}
        {[0, Math.floor(data.length / 2), data.length - 1].map(i => (
          <text key={`d-${i}`} x={padL + i * stepX + stepX / 2} y={H - 6} textAnchor="middle" fontSize="10" fill="#64748b">
            {data[i].date.slice(5)}
          </text>
        ))}
      </svg>
    </div>
  );
}

type ParentRow = {
  id: string;
  name: string;
  displayName: string | null;
  email: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  isAdmin: boolean;
  paperCount: number;
  students: { id: string; name: string; displayName: string | null; level: number | null }[];
};

type StudentRow = {
  id: string;
  name: string;
  displayName: string | null;
  email: string | null;
  level: number | null;
  createdAt: string;
  lastLoginAt: string | null;
  paperCount: number;
  parents: { id: string; name: string; displayName: string | null; email: string | null }[];
  progressEmailsSent: { subjectKey: string; sentAt: string }[];
};

// Friendly relative-time label, falling back to the local date for
// anything older than ~30 days. NULL = never logged in.
function lastLoginLabel(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  if (ms < 0) return d.toLocaleString();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  return d.toLocaleDateString();
}

export default function AdminUsersPage() {
  return (
    <Suspense>
      <AdminUsersContent />
    </Suspense>
  );
}

function AdminUsersContent() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [parents, setParents] = useState<ParentRow[]>([]);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [signups14d, setSignups14d] = useState<SignupBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string; role: "PARENT" | "STUDENT" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportingProgress, setExportingProgress] = useState(false);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`)
      .then(r => setAllowed(r.ok))
      .catch(() => setAllowed(false));
  }, [userId]);

  // Rich parent-progress export. One row per parent with up to 2 linked
  // children; each child contributes weakness topic, 7-day avg, and the
  // 3 most recent paper titles + scores. Server does the heavy DB
  // aggregation; we shape the CSV here.
  async function downloadParentProgressCsv() {
    setExportingProgress(true);
    try {
      const res = await fetch("/api/admin/parent-progress");
      if (!res.ok) {
        alert(`Export failed: ${res.status}`);
        return;
      }
      const { rows } = (await res.json()) as {
        rows: Array<{
          parentName: string;
          parentEmail: string;
          parentHomepageUrl: string;
          parentRegisteredAt: string;
          quizzesSet: number;
          quizzesCompleted: number;
          children: Array<{
            name: string;
            homepageUrl: string;
            weaknessTopic: string | null;
            avg7dPct: number | null;
            recent: Array<{ title: string; pct: number | null }>;
            lastQuizAt: string | null;
          }>;
        }>;
      };
      const headers = [
        "parent_name",
        "parent_email",
        "parent_homepage_link",
        "parent_registered_at",
        "quizzes_set",
        "quizzes_completed_by_students",
        "child_1_name",
        "child_1_homepage_link",
        "child_1_last_quiz_at",
        "child_1_weakness_topic",
        "child_1_avg_score_last_7_days",
        "child_1_last_quiz_title",
        "child_1_last_quiz_score",
        "child_1_2nd_last_quiz_title",
        "child_1_2nd_last_quiz_score",
        "child_1_3rd_last_quiz_title",
        "child_1_3rd_last_quiz_score",
        "child_2_name",
        "child_2_homepage_link",
        "child_2_last_quiz_at",
        "child_2_weakness_topic",
        "child_2_avg_score_last_7_days",
        "child_2_last_quiz_title",
        "child_2_last_quiz_score",
        "child_2_2nd_last_quiz_title",
        "child_2_2nd_last_quiz_score",
        "child_2_3rd_last_quiz_title",
        "child_2_3rd_last_quiz_score",
      ];
      const fmtPct = (n: number | null) => (n == null ? "" : `${n}%`);
      // ISO date (YYYY-MM-DD) — readable in Sheets and sorts correctly.
      const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
      const childCols = (c: { name: string; homepageUrl: string; weaknessTopic: string | null; avg7dPct: number | null; recent: Array<{ title: string; pct: number | null }>; lastQuizAt: string | null } | undefined) => {
        if (!c) return ["", "", "", "", "", "", "", "", "", "", ""];
        return [
          c.name,
          c.homepageUrl,
          fmtDate(c.lastQuizAt),
          c.weaknessTopic ?? "",
          fmtPct(c.avg7dPct),
          c.recent[0]?.title ?? "",
          fmtPct(c.recent[0]?.pct ?? null),
          c.recent[1]?.title ?? "",
          fmtPct(c.recent[1]?.pct ?? null),
          c.recent[2]?.title ?? "",
          fmtPct(c.recent[2]?.pct ?? null),
        ];
      };
      const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const lines = [
        headers.join(","),
        ...rows.map(r => [
          r.parentName,
          r.parentEmail,
          r.parentHomepageUrl,
          fmtDate(r.parentRegisteredAt),
          r.quizzesSet,
          r.quizzesCompleted,
          ...childCols(r.children[0]),
          ...childCols(r.children[1]),
        ].map(v => escape(String(v ?? ""))).join(",")),
      ];
      const csv = lines.join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `parent-progress-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExportingProgress(false);
    }
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/users");
      if (!res.ok) {
        setError(res.status === 403 ? "Access denied" : "Failed to load users");
        return;
      }
      const data = await res.json();
      setParents(data.parents ?? []);
      setStudents(data.students ?? []);
      setSignups14d(data.signups14d ?? []);
    } catch {
      setError("Failed to load users");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (allowed) load();
  }, [allowed]);

  async function doDelete() {
    if (!confirmDelete) return;
    setDeleting(confirmDelete.id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${confirmDelete.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Delete failed");
        return;
      }
      setConfirmDelete(null);
      await load();
    } catch {
      setError("Delete failed");
    } finally {
      setDeleting(null);
    }
  }

  if (allowed === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" />
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <p className="text-slate-500 text-sm">Access denied.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-lg font-bold text-slate-800">Manage Users</h1>
            <p className="text-xs text-slate-400">{parents.length} parents · {students.length} students</p>
          </div>
          <button
            onClick={downloadParentProgressCsv}
            disabled={exportingProgress}
            className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-bold disabled:opacity-50 hover:bg-emerald-700 transition-colors"
          >
            {exportingProgress ? "Building…" : "Export parent progress (CSV)"}
          </button>
        </div>

        {error && (
          <div className="mx-4 mt-4 px-4 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>
        )}

        <div className="max-w-5xl mx-auto px-4 py-6 space-y-8">
          {loading ? (
            <div className="text-center py-10">
              <div className="animate-spin inline-block rounded-full h-6 w-6 border-2 border-slate-200 border-t-slate-500" />
            </div>
          ) : (
            <>
              {signups14d.length > 0 && <SignupChart data={signups14d} />}
              <UserSection
                title="Parents"
                count={parents.length}
                rows={parents.map(p => ({
                  id: p.id,
                  primary: p.displayName ?? p.name,
                  username: p.name,
                  badge: p.isAdmin ? "ADMIN" : null,
                  email: p.email ?? "—",
                  meta: `${p.paperCount} paper${p.paperCount === 1 ? "" : "s"} · joined ${new Date(p.createdAt).toLocaleDateString()} · last active ${lastLoginLabel(p.lastLoginAt)}`,
                  links: p.students.length > 0
                    ? p.students.map(s => `${s.displayName ?? s.name}${s.level ? ` (P${s.level})` : ""}`).join(", ")
                    : "no linked students",
                  linksLabel: "Linked students",
                  role: "PARENT" as const,
                }))}
                deleting={deleting}
                onDelete={(id, name, role) => setConfirmDelete({ id, name, role })}
              />

              <UserSection
                title="Students"
                count={students.length}
                rows={students.map(s => ({
                  id: s.id,
                  primary: s.displayName ?? s.name,
                  username: s.name,
                  badge: s.level ? `P${s.level}` : null,
                  email: s.email ?? "—",
                  meta: `${s.paperCount} paper${s.paperCount === 1 ? "" : "s"} · joined ${new Date(s.createdAt).toLocaleDateString()} · last login ${lastLoginLabel(s.lastLoginAt)}`,
                  links: s.parents.length > 0
                    ? s.parents.map(p => `${p.displayName ?? p.name}${p.email ? ` <${p.email}>` : ""}`).join(", ")
                    : "no linked parents",
                  linksLabel: "Linked parents",
                  role: "STUDENT" as const,
                  primaryParentId: s.parents[0]?.id,
                  progressEmailsSent: s.progressEmailsSent,
                }))}
                deleting={deleting}
                onDelete={(id, name, role) => setConfirmDelete({ id, name, role })}
              />
            </>
          )}
        </div>
      </div>

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.4)" }}>
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold text-slate-800 mb-2">Delete this {confirmDelete.role === "PARENT" ? "parent" : "student"}?</h3>
            <p className="text-sm text-slate-600 mb-4">
              <strong>{confirmDelete.name}</strong> will be permanently deleted, along with all their owned exam papers and links to other accounts. This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDelete(null)}
                disabled={deleting === confirmDelete.id}
                className="px-4 py-2 rounded-xl border-2 border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={doDelete}
                disabled={deleting === confirmDelete.id}
                className="px-4 py-2 rounded-xl bg-red-600 text-white text-sm font-bold hover:bg-red-700 disabled:opacity-50"
              >
                {deleting === confirmDelete.id ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function UserSection({
  title,
  count,
  rows,
  deleting,
  onDelete,
}: {
  title: string;
  count: number;
  rows: {
    id: string;
    primary: string;
    username: string;
    badge: string | null;
    email: string;
    meta: string;
    links: string;
    linksLabel: string;
    role: "PARENT" | "STUDENT";
    // First linked parent id for STUDENT rows — admin's "open home"
    // deeplink routes to /home/<parentId>?student=<studentId> so the
    // view shows Lumi/progress chrome (parent-side dashboard), not
    // the student's own gamified home. Empty for parents.
    primaryParentId?: string;
    progressEmailsSent?: { subjectKey: string; sentAt: string }[];
  }[];
  deleting: string | null;
  onDelete: (id: string, name: string, role: "PARENT" | "STUDENT") => void;
}) {
  return (
    <section>
      <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wider mb-3">
        {title} <span className="text-slate-400 font-normal">({count})</span>
      </h2>
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm divide-y divide-slate-100">
        {rows.length === 0 ? (
          <div className="px-5 py-6 text-sm text-slate-400 text-center">No {title.toLowerCase()} yet.</div>
        ) : rows.map(r => (
          <div key={r.id} className="px-5 py-4 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-bold text-slate-800 text-sm">{r.primary}</p>
                {r.badge && (
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                    r.badge === "ADMIN" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"
                  }`}>{r.badge}</span>
                )}
                {r.primary !== r.username && (
                  <span className="text-[11px] text-slate-400">@{r.username}</span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-0.5 break-all">{r.email}</p>
              <p className="text-[11px] text-slate-400 mt-1">{r.meta}</p>
              <p className="text-[11px] text-slate-500 mt-1.5">
                <span className="font-semibold">{r.linksLabel}:</span> {r.links}
              </p>
              {r.progressEmailsSent && r.progressEmailsSent.length > 0 && (
                <p className="text-[11px] text-green-700 mt-1.5 font-semibold">
                  Progress report sent:{" "}
                  {r.progressEmailsSent
                    .map(p => `${p.subjectKey.charAt(0).toUpperCase()}${p.subjectKey.slice(1)} (${new Date(p.sentAt).toLocaleDateString()})`)
                    .join(", ")}
                </p>
              )}
            </div>
            <a
              href={
                // For STUDENT rows, route via the first linked parent
                // so admin lands on the parent dashboard scoped to
                // this kid (Lumi / progress / focused practice all
                // live there). Falling back to the student's own
                // /home only when there's no linked parent.
                r.role === "STUDENT" && r.primaryParentId
                  ? `/home/${r.primaryParentId}?userId=${r.primaryParentId}&student=${r.id}`
                  : `/home/${r.id}?userId=${r.id}`
              }
              target="_blank"
              rel="noopener"
              title={r.role === "PARENT" ? "Open parent home page" : (r.primaryParentId ? "Open parent dashboard scoped to this student" : "Open student home (no linked parent)")}
              className="shrink-0 px-3 py-2 rounded-lg border border-slate-200 text-slate-600 text-xs font-bold hover:bg-slate-50"
            >
              <span className="material-symbols-outlined text-base align-middle">open_in_new</span>
            </a>
            <button
              onClick={() => onDelete(r.id, r.primary, r.role)}
              disabled={deleting === r.id}
              className="shrink-0 px-3 py-2 rounded-lg border border-red-200 text-red-600 text-xs font-bold hover:bg-red-50 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-base align-middle">delete</span>
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
