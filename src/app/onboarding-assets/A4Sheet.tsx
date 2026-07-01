// A4-sized wrapper shared by the three top-topics onboarding sheets
// (English / Math / Science). Locks the visible width to 210 mm and
// max height to 297 mm so what the parent sees on screen matches
// what prints via Ctrl+P. Print CSS strips the surrounding page
// chrome so the sheet fills the paper edge-to-edge.

import type { ReactNode } from "react";

export function A4Sheet({ title, subtitle, children }: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <>
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
          Preview of A4 sheet. Press <strong>Ctrl+P</strong> (or Cmd+P on Mac) → <strong>Save as PDF</strong> to export.
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

export function A4SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="font-headline font-extrabold text-[#001e40] mt-4 mb-2" style={{ fontSize: "12pt" }}>
      {children}
    </h2>
  );
}

// Reusable horizontal-bar chart. Same look as the reference Math
// chart (cream bg, teal bars with gradient darkening for top items).
export function BarChart({ items, unit = "marks", labelWidth = 170 }: {
  items: Array<{ name: string; value: number; colour?: string }>;
  unit?: string;
  labelWidth?: number;
}) {
  const maxVal = Math.max(...items.map(i => i.value));
  const axisMax = Math.ceil(maxVal / 5) * 5 || 5;        // round up to nearest 5 for a clean axis
  const chartWidth = 560;
  const barAreaLeft = labelWidth;
  const barAreaRight = chartWidth - 70;
  const rowH = 26;
  const gap = 8;
  const chartH = items.length * (rowH + gap) + 4;
  // Default palette: darkest teal for #1, fading to lighter teal.
  const palette = ["#0f5c66", "#3d848c", "#66a5ac", "#8fbfc4", "#b3d3d6", "#c9dedf", "#d8e6e7"];
  return (
    <div style={{ backgroundColor: "#f8f4ea", padding: "10px 12px", borderRadius: 8 }}>
      <svg viewBox={`0 0 ${chartWidth} ${chartH}`} style={{ width: "100%", height: "auto", display: "block" }}>
        {items.map((t, i) => {
          const y = i * (rowH + gap);
          const w = (t.value / axisMax) * (barAreaRight - barAreaLeft);
          const fill = t.colour ?? palette[Math.min(i, palette.length - 1)];
          return (
            <g key={t.name}>
              <text
                x={barAreaLeft - 8}
                y={y + rowH / 2 + 4}
                textAnchor="end"
                fontSize="11"
                fontWeight="700"
                fill="#0b1c30"
              >
                {t.name}
              </text>
              <rect x={barAreaLeft} y={y} width={w} height={rowH} fill={fill} rx={2} />
              <text
                x={barAreaLeft + w + 6}
                y={y + rowH / 2 + 4}
                fontSize="11"
                fontWeight="800"
                fill="#0b1c30"
              >
                {t.value} {unit}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
