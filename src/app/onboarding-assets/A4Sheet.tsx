// A4-sized wrapper shared by the three top-topics onboarding sheets
// (English / Math / Science). Locks the visible width to 210 mm and
// max height to 297 mm so what the parent sees on screen matches
// what prints via Ctrl+P. Print CSS strips the surrounding page
// chrome so the sheet fills the paper edge-to-edge.
//
// Iteration workflow: change the copy in each subject's page.tsx,
// hit refresh, Ctrl+P to preview the PDF, repeat. When the copy is
// locked, "Save as PDF" from print dialog and drop into public/
// onboarding-assets/ so the older /onboarding-assets/*.pdf URLs work
// as static files too. For now the Lumi banner links to the route.

import type { ReactNode } from "react";

export function A4Sheet({ title, subtitle, children }: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <>
      {/* Print CSS: A4 paper, 12mm margins, hide browser chrome + the
          surrounding page background so the sheet fills the paper. */}
      <style>{`
        @page { size: A4; margin: 12mm; }
        @media print {
          html, body { background: white !important; margin: 0 !important; padding: 0 !important; }
          .a4-outer { padding: 0 !important; background: white !important; }
          .a4-sheet { box-shadow: none !important; margin: 0 !important; }
          .no-print { display: none !important; }
        }
        body { background: #f5f6fa; }
      `}</style>
      <div className="a4-outer min-h-screen py-6 flex flex-col items-center gap-4">
        <div className="no-print text-xs text-slate-500 max-w-[210mm] w-full px-4">
          Preview of A4 sheet. Press <strong>Ctrl+P</strong> (or Cmd+P on Mac) → <strong>Save as PDF</strong> to export. Content iterates directly in the source file.
        </div>
        <article
          className="a4-sheet bg-white text-[#0b1c30] shadow-lg"
          style={{
            width: "210mm",
            minHeight: "297mm",
            padding: "12mm 14mm",
            boxSizing: "border-box",
            fontFamily: "'Inter', system-ui, sans-serif",
            fontSize: "10pt",
            lineHeight: 1.35,
          }}
        >
          <header className="mb-4 border-b-2 border-[#001e40] pb-3">
            <div className="flex items-baseline justify-between gap-4">
              <h1 className="font-headline font-extrabold text-[#001e40]" style={{ fontSize: "18pt", lineHeight: 1.1 }}>{title}</h1>
              <div className="text-right text-[9pt] leading-tight text-slate-500">
                <div className="font-bold text-[#7c3aed]">MarkForYou</div>
                <div>markforyou.com</div>
              </div>
            </div>
            {subtitle && <p className="mt-1 text-[10pt] text-slate-600">{subtitle}</p>}
          </header>
          {children}
          <footer className="mt-6 pt-3 border-t border-slate-200 text-[8.5pt] text-slate-500 leading-tight">
            Diagnosed and marked automatically by MarkForYou. Try a 20-min diagnostic quiz free at <strong>markforyou.com</strong>. Content synthesised from 10 years of past PSLE papers.
          </footer>
        </article>
      </div>
    </>
  );
}

// Small helper: table with tight A4-friendly styles. Every subject
// sheet uses the same row/column look so the family reads consistent.
export function A4Table({ headers, rows }: {
  headers: string[];
  rows: Array<Array<ReactNode>>;
}) {
  return (
    <table className="w-full border-collapse" style={{ fontSize: "9.5pt" }}>
      <thead>
        <tr className="bg-[#eff4ff] text-left">
          {headers.map((h, i) => (
            <th key={i} className="border border-slate-300 px-2 py-1.5 font-bold text-[#001e40] text-[9pt] uppercase tracking-wide">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-slate-50"}>
            {r.map((cell, j) => (
              <td key={j} className="border border-slate-200 px-2 py-1.5 align-top">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function A4SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="font-headline font-extrabold text-[#001e40] mt-4 mb-2" style={{ fontSize: "12pt" }}>
      {children}
    </h2>
  );
}
