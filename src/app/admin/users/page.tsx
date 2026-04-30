"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

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
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string; role: "PARENT" | "STUDENT" } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`)
      .then(r => setAllowed(r.ok))
      .catch(() => setAllowed(false));
  }, [userId]);

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
        <div className="bg-white border-b border-slate-200 px-4 py-3">
          <h1 className="text-lg font-bold text-slate-800">Manage Users</h1>
          <p className="text-xs text-slate-400">{parents.length} parents · {students.length} students</p>
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
              <UserSection
                title="Parents"
                count={parents.length}
                rows={parents.map(p => ({
                  id: p.id,
                  primary: p.displayName ?? p.name,
                  username: p.name,
                  badge: p.isAdmin ? "ADMIN" : null,
                  email: p.email ?? "—",
                  meta: `${p.paperCount} paper${p.paperCount === 1 ? "" : "s"} · joined ${new Date(p.createdAt).toLocaleDateString()} · last login ${lastLoginLabel(p.lastLoginAt)}`,
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
            </div>
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
