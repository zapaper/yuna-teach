// Print-friendly view of a saved Lumi's tip. Same content as the
// in-app BatchResultPanel, stripped down: no header/footer chrome, no
// close button, scaled type, generous margins, auto-fires the system
// print dialog on mount so the admin can save to PDF or send to a
// physical printer.
//
// /print/batch-tip/[id]?userId=<admin>  — the userId param keeps the
// session resolver happy on /print routes (same pattern as /admin).
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import PrintTrigger from "./PrintTrigger";

type BatchAdvice = {
  tip: string;
  tipEn?: string;
  why: string;
  whyEn?: string;
  examples: Array<{ from: string; before: string; after: string }>;
};
type BatchBucket = {
  title: string;
  titleEn?: string;
  color: "blue" | "emerald" | "amber" | "rose" | "violet" | "sky";
  advice: BatchAdvice[];
};
type BatchAnalyseResult = {
  buckets: BatchBucket[];
  overview: string;
  overviewEn?: string;
  essaysAnalysed: number;
  language: "chinese" | "english" | "mixed";
};

// Tailwind palette per bucket colour. Print stylesheet renders these
// as monochrome borders to save toner, while the screen preview keeps
// them coloured.
const PALETTE: Record<BatchBucket["color"], { border: string; bg: string; chip: string }> = {
  blue:    { border: "border-blue-300",    bg: "bg-blue-50",    chip: "bg-blue-100 text-blue-800" },
  emerald: { border: "border-emerald-300", bg: "bg-emerald-50", chip: "bg-emerald-100 text-emerald-800" },
  amber:   { border: "border-amber-300",   bg: "bg-amber-50",   chip: "bg-amber-100 text-amber-800" },
  rose:    { border: "border-rose-300",    bg: "bg-rose-50",    chip: "bg-rose-100 text-rose-800" },
  violet:  { border: "border-violet-300",  bg: "bg-violet-50",  chip: "bg-violet-100 text-violet-800" },
  sky:     { border: "border-sky-300",     bg: "bg-sky-50",     chip: "bg-sky-100 text-sky-800" },
};

export default async function PrintBatchTipPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Force-include headers so the session cookie resolves under the
  // server-component render context (cookies() lookups in this
  // codebase need an explicit headers() touch when called from
  // page-level RSC — same workaround used elsewhere).
  await headers();
  if (!(await isSessionAdmin())) notFound();

  const { id } = await params;
  const tip = await prisma.batchCoachTip.findUnique({
    where: { id },
    select: { id: true, analysis: true, language: true, createdAt: true, attemptIds: true },
  });
  if (!tip) notFound();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const analysis = tip.analysis as any as BatchAnalyseResult;
  const isChinese = (tip.language ?? "english") === "chinese";

  return (
    <div className="bg-white text-slate-900 mx-auto p-8 max-w-4xl" style={{ fontFamily: isChinese ? "'Noto Serif SC', 'PingFang SC', 'Microsoft YaHei', serif" : "Georgia, 'Times New Roman', serif" }}>
      <PrintTrigger />
      <style>{`
        @page { margin: 18mm; }
        @media print {
          .no-print { display: none !important; }
          body { font-size: 11pt; }
        }
      `}</style>

      <header className="border-b border-slate-300 pb-4 mb-6">
        <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">
          Lumi&rsquo;s cross-essay coaching tip
        </div>
        <h1 className="text-2xl font-bold mt-1">Patterns across {analysis.essaysAnalysed} {isChinese ? "篇作文" : "essays"}</h1>
        <div className="text-xs text-slate-500 mt-2">
          Saved {new Date(tip.createdAt).toLocaleDateString("en-SG", { dateStyle: "medium" })}
        </div>
        {analysis.overview && (
          <p className="mt-4 text-base leading-relaxed italic text-slate-700">
            {analysis.overview}
          </p>
        )}
        {analysis.overviewEn && analysis.overview !== analysis.overviewEn && (
          <p className="mt-2 text-sm leading-relaxed text-slate-500" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
            {analysis.overviewEn}
          </p>
        )}
      </header>

      <main className="space-y-5">
        {analysis.buckets.length === 0 && (
          <p className="italic text-slate-500">No patterns were surfaced.</p>
        )}
        {analysis.buckets.map((b, bi) => {
          const palette = PALETTE[b.color] ?? PALETTE.blue;
          return (
            <section key={bi} className={`border ${palette.border} rounded-lg overflow-hidden break-inside-avoid`}>
              <div className={`${palette.bg} px-4 py-2 border-b ${palette.border} flex items-center justify-between gap-2`}>
                <div className="min-w-0">
                  <h2 className="font-bold text-base">{b.title}</h2>
                  {b.titleEn && b.titleEn !== b.title && (
                    <div className="text-[10px] text-slate-500 font-medium mt-0.5" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>{b.titleEn}</div>
                  )}
                </div>
                <span className={`text-[10px] font-semibold uppercase tracking-wide ${palette.chip} px-2 py-0.5 rounded shrink-0`}>
                  {b.advice.length} {isChinese ? "条" : `tip${b.advice.length === 1 ? "" : "s"}`}
                </span>
              </div>
              <div className="px-4 py-3 space-y-4">
                {b.advice.map((a, ai) => (
                  <div key={ai}>
                    <div className="font-bold text-sm">{a.tip}</div>
                    {a.tipEn && a.tipEn !== a.tip && (
                      <div className="text-xs text-slate-500 mt-0.5" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>{a.tipEn}</div>
                    )}
                    {a.why && <p className="text-xs text-slate-600 mt-1">{a.why}</p>}
                    {a.whyEn && a.whyEn !== a.why && (
                      <p className="text-[11px] text-slate-400 italic mt-0.5" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>{a.whyEn}</p>
                    )}
                    {a.examples.length > 0 && (
                      <div className="mt-2 space-y-2">
                        {a.examples.map((e, ei) => (
                          <div key={ei} className="text-xs bg-slate-50 border border-slate-200 rounded p-2.5 space-y-1.5">
                            {e.from && <div className="text-[10px] text-slate-500 uppercase tracking-wide">{e.from}</div>}
                            <div className="flex items-start gap-2">
                              <span className="text-rose-600 font-bold shrink-0">−</span>
                              <span className="italic">&ldquo;{e.before}&rdquo;</span>
                            </div>
                            <div className="flex items-start gap-2">
                              <span className="text-emerald-700 font-bold shrink-0">+</span>
                              <span className="font-medium">&ldquo;{e.after}&rdquo;</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </main>

      <footer className="mt-10 pt-4 border-t border-slate-200 text-[10px] text-slate-400 text-center">
        markforyou.com · Compo Coach
      </footer>
    </div>
  );
}
