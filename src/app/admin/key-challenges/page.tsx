"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

interface KeyChallengeRow {
  id: string;
  questionNum: string;
  stem: string | null;
  options: unknown;
  answerKey: string | null;
  syllabusTopic: string | null;
  paperId: string;
  paperTitle: string;
  paperLevel: string | null;
  aiKeyChallenge: { suspectedWrong: boolean; suggestedAnswer: string; reason: string };
  solution: string | null;
}

export default function AdminKeyChallengesPage() {
  return (
    <Suspense>
      <AdminKeyChallengesContent />
    </Suspense>
  );
}

function AdminKeyChallengesContent() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";

  const [items, setItems] = useState<KeyChallengeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    if (!userId) { setForbidden(true); setLoading(false); return; }
    fetch(`/api/admin/key-challenges?userId=${userId}`)
      .then(async (r) => {
        if (r.status === 403 || r.status === 401) { setForbidden(true); return; }
        setItems(await r.json());
      })
      .finally(() => setLoading(false));
  }, [userId]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <p className="text-slate-500">Access denied.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3">
          <h1 className="text-lg font-bold text-slate-800">AI Answer-Key Challenges</h1>
          <p className="text-xs text-slate-400">
            Questions where the AI flagged the official answer key as likely wrong during the bulk-elaborate run. Review and decide whether to amend.
            <br />{items.length} flag{items.length === 1 ? "" : "s"} pending review.
          </p>
        </div>
        {items.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-slate-400">No flagged questions.</p>
          </div>
        ) : (
          <div className="px-4 py-4 space-y-4 max-w-3xl mx-auto">
            {items.map((item) => {
              const options = Array.isArray(item.options) ? (item.options as string[]) : [];
              return (
                <div key={item.id} className="bg-white rounded-xl border border-amber-200 shadow-sm px-5 py-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{item.paperLevel ?? "?"} · {item.syllabusTopic ?? "?"}</p>
                      <p className="text-sm font-bold text-slate-800">{item.paperTitle} — Q{item.questionNum}</p>
                    </div>
                    <a
                      href={`/exam/${item.paperId}/edit?userId=${userId}#q-${item.id}`}
                      className="text-xs px-2.5 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium"
                      title="Open the paper edit view"
                    >
                      Open paper →
                    </a>
                  </div>

                  {item.stem && (
                    <p className="text-sm text-slate-700 whitespace-pre-wrap">{item.stem}</p>
                  )}

                  {options.length > 0 && (
                    <ol className="text-sm text-slate-700 space-y-0.5 pl-5 list-decimal">
                      {options.map((o, i) => (
                        <li key={i} className={String(i + 1) === item.answerKey ? "font-semibold text-emerald-700" : ""}>
                          {o}{String(i + 1) === item.answerKey ? "  (current answer key)" : ""}
                        </li>
                      ))}
                    </ol>
                  )}

                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-1.5">
                    <p className="text-xs font-bold uppercase tracking-wide text-amber-700">AI thinks the key is wrong</p>
                    <p className="text-sm text-slate-700">
                      <span className="font-semibold">Current key:</span> {item.answerKey}
                      {" · "}
                      <span className="font-semibold">AI suggests:</span> {item.aiKeyChallenge.suggestedAnswer}
                    </p>
                    <p className="text-sm text-slate-700 italic">{item.aiKeyChallenge.reason}</p>
                  </div>

                  {item.solution && (
                    <details className="text-xs text-slate-500">
                      <summary className="cursor-pointer hover:text-slate-700">Show AI elaboration (current key)</summary>
                      <p className="mt-2 whitespace-pre-wrap text-slate-600 bg-slate-50 rounded p-2">{item.solution}</p>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
