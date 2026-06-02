// Dedicated admin page for the English "Normal Extract" pipeline.
// Lives on its own route (instead of inline in the overview) so the
// per-section Extract buttons aren't disturbed by the overview's
// background refetches and global state churn.

"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import EnglishNormalExtractPanel from "@/components/EnglishNormalExtractPanel";

type PaperShape = {
  id: string;
  title: string;
  subject: string | null;
  metadata: Record<string, unknown> | null;
};

export default function NormalExtractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [paper, setPaper] = useState<PaperShape | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/exam/${id}`);
        if (!res.ok) {
          setError(`Failed to load paper (${res.status})`);
          return;
        }
        const data = await res.json();
        if (!cancelled) setPaper(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  if (error) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <p className="text-sm text-red-700">{error}</p>
        <Link href={`/exam/${id}/overview`} className="text-sm text-violet-600 underline">← Back to overview</Link>
      </div>
    );
  }

  if (!paper) {
    return <div className="max-w-3xl mx-auto p-6 text-sm text-slate-500">Loading…</div>;
  }

  const isEnglish = (paper.subject ?? "").toLowerCase().includes("english");
  const initialState = (paper.metadata as { normalExtractEnglish?: Record<string, unknown> } | null)?.normalExtractEnglish ?? {};

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Normal Extract — English</h1>
          <p className="text-xs text-slate-500 mt-0.5">{paper.title}</p>
        </div>
        <Link href={`/exam/${id}/overview`} className="text-xs text-violet-600 hover:underline">← Back to overview</Link>
      </div>

      {!isEnglish ? (
        <p className="text-sm text-amber-700 p-3 rounded-xl bg-amber-50 border border-amber-200">
          This paper isn&apos;t tagged as English (subject = {paper.subject ?? "null"}). Normal Extract is English-only.
        </p>
      ) : (
        <>
          <p className="text-xs text-slate-500">
            Generates per-question bounding boxes per section. Booklet A and Booklet B
            sections all use gemini-3.1-pro-preview to locate question numbers; offsets
            differ per section type. Re-run any section anytime.
          </p>
          <EnglishNormalExtractPanel paperId={id} initialState={initialState} />
        </>
      )}
    </div>
  );
}
