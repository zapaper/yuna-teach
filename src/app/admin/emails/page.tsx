"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

type Row = {
  id: string;
  name: string;
  email: string | null;
  role: string;
  createdAt: string;
  emailVerified?: boolean;
};

export default function EmailsPage() {
  return (
    <Suspense>
      <Content />
    </Suspense>
  );
}

function Content() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [users, setUsers] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [onlyVerified, setOnlyVerified] = useState(false);
  const [onlyParents, setOnlyParents] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`).then(r => setAllowed(r.ok)).catch(() => setAllowed(false));
  }, [userId]);

  useEffect(() => {
    if (!allowed) return;
    fetch("/api/admin/emails").then(r => r.json()).then(d => {
      setUsers(d.users ?? []);
      setLoading(false);
    });
  }, [allowed]);

  const filtered = users.filter(u => {
    if (onlyVerified && !u.emailVerified) return false;
    if (onlyParents && u.role !== "PARENT") return false;
    return true;
  });
  const emails = [...new Set(filtered.map(u => u.email).filter((e): e is string => !!e))];

  async function copyEmails() {
    await navigator.clipboard.writeText(emails.join(", "));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function downloadCsv() {
    const header = "email,name,role,createdAt,verified";
    const rows = filtered.map(u => [u.email, u.name, u.role, u.createdAt, u.emailVerified ? "yes" : "no"].map(f => `"${String(f ?? "").replace(/"/g, '""')}"`).join(","));
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `beta-mailing-list-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (allowed === null) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" /></div>;
  }
  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">Access denied.</p></div>;
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24">
        <div className="bg-white border-b border-slate-200 px-4 py-3">
          <h1 className="text-lg font-bold text-slate-800">Beta Mailing List</h1>
          <p className="text-xs text-slate-400">All registered users with an email on file.</p>
        </div>

        <div className="max-w-3xl mx-auto px-4 py-5 space-y-4">
          <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={onlyParents} onChange={e => setOnlyParents(e.target.checked)} />
                <span>Only parents</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={onlyVerified} onChange={e => setOnlyVerified(e.target.checked)} />
                <span>Only verified</span>
              </label>
              <span className="ml-auto text-xs font-bold text-slate-500">{emails.length} unique emails</span>
            </div>
            <div className="flex gap-2">
              <button onClick={copyEmails} disabled={emails.length === 0}
                className="flex-1 py-2.5 rounded-xl bg-slate-800 text-white text-sm font-bold disabled:opacity-50">
                {copied ? "Copied!" : "Copy comma-separated"}
              </button>
              <button onClick={downloadCsv} disabled={filtered.length === 0}
                className="flex-1 py-2.5 rounded-xl border border-slate-300 text-slate-700 text-sm font-bold disabled:opacity-50">
                Download CSV
              </button>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            {loading ? (
              <p className="px-4 py-8 text-center text-sm text-slate-400">Loading…</p>
            ) : filtered.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-400">No users match the filter.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr>
                    <th className="px-3 py-2 font-bold">Email</th>
                    <th className="px-3 py-2 font-bold">Name</th>
                    <th className="px-3 py-2 font-bold">Role</th>
                    <th className="px-3 py-2 font-bold">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(u => (
                    <tr key={u.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 text-slate-800 font-mono">{u.email}</td>
                      <td className="px-3 py-2 text-slate-700">{u.name}</td>
                      <td className="px-3 py-2">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${u.role === "PARENT" ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700"}`}>{u.role}</span>
                      </td>
                      <td className="px-3 py-2 text-slate-500">{new Date(u.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
