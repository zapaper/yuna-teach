"use client";

// Singapore-primary "model method" bar diagram. Rows are stacked
// vertically, each row's bar is sized in proportion to the largest
// row's units. Units < 12 get visible 1-unit subdivisions. Optional
// per-row "value" (e.g. "?", "210", "$24") shown to the right of
// each bar; optional "1 unit = …" footer.
//
// Originally lived inline in src/app/solver/page.tsx; extracted so
// the AI explainer can reuse the same render. Schema mirrors the
// solver API's `diagrams[]` field exactly.

export interface DiagramRow {
  label: string;
  units: number;
  value: string | null;
}

export interface DiagramStep {
  title: string | null;
  rows: DiagramRow[];
  unitValue: string | null;
}

function splitLabel(label: string): [string, string | null] {
  // ~10 chars fits comfortably in LABEL_W at fontSize 12; split longer labels
  if (label.length <= 11) return [label, null];
  const mid = Math.ceil(label.length / 2);
  const spaceIdx = label.lastIndexOf(" ", mid + 4);
  if (spaceIdx > 0) return [label.slice(0, spaceIdx), label.slice(spaceIdx + 1)];
  return [label.slice(0, 11), label.slice(11)];
}

export default function BarDiagram({ diagram }: { diagram: DiagramStep }) {
  const ROW_H = 44;
  const ROW_GAP = 10;
  const LABEL_W = 100;
  const BAR_AREA_W = 190;
  const VALUE_W = 62;
  const PAD_X = 8;
  const PAD_Y = 8;
  const TOTAL_W = PAD_X + LABEL_W + BAR_AREA_W + VALUE_W + PAD_X;

  const maxUnits = Math.max(...diagram.rows.map((r) => r.units), 1);
  const unitW = BAR_AREA_W / maxUnits;

  const FOOTER_H = diagram.unitValue ? 26 : 0;
  const totalH = PAD_Y + diagram.rows.length * (ROW_H + ROW_GAP) - ROW_GAP + FOOTER_H + PAD_Y;

  const COLORS = [
    { fill: "#dbeafe", stroke: "#60a5fa", text: "#1d4ed8" },
    { fill: "#ede9fe", stroke: "#a78bfa", text: "#6d28d9" },
    { fill: "#d1fae5", stroke: "#34d399", text: "#065f46" },
    { fill: "#fef3c7", stroke: "#fbbf24", text: "#92400e" },
    { fill: "#fce7f3", stroke: "#f472b6", text: "#9d174d" },
  ];

  return (
    <svg viewBox={`0 0 ${TOTAL_W} ${totalH}`} width="100%" style={{ display: "block", maxWidth: TOTAL_W }}>
      {diagram.rows.map((row, i) => {
        const y = PAD_Y + i * (ROW_H + ROW_GAP);
        const barX = PAD_X + LABEL_W;
        const barW = row.units * unitW;
        const col = COLORS[i % COLORS.length];
        const [line1, line2] = splitLabel(row.label);
        const labelX = PAD_X + LABEL_W - 6;

        return (
          <g key={i}>
            {line2 ? (
              <text x={labelX} textAnchor="end"
                fontSize="11" fontFamily="system-ui,sans-serif" fontWeight="500" fill="#475569">
                <tspan x={labelX} y={y + ROW_H / 2 - 3}>{line1}</tspan>
                <tspan x={labelX} dy="14">{line2}</tspan>
              </text>
            ) : (
              <text x={labelX} y={y + ROW_H / 2 + 4} textAnchor="end"
                fontSize="12" fontFamily="system-ui,sans-serif" fontWeight="500" fill="#475569">
                {line1}
              </text>
            )}
            <rect x={barX} y={y} width={BAR_AREA_W} height={ROW_H} rx={4}
              fill="#f1f5f9" stroke="#e2e8f0" strokeWidth={1} />
            <rect x={barX} y={y} width={barW} height={ROW_H} rx={4}
              fill={col.fill} stroke={col.stroke} strokeWidth={1.5} />
            {row.units <= 12 && Array.from({ length: row.units - 1 }, (_, j) => (
              <line key={j}
                x1={barX + (j + 1) * unitW} y1={y + 6}
                x2={barX + (j + 1) * unitW} y2={y + ROW_H - 6}
                stroke={col.stroke} strokeWidth={1} opacity={0.6} />
            ))}
            {row.value && (
              <text x={barX + BAR_AREA_W + 6} y={y + ROW_H / 2 + 4}
                fontSize="13" fontFamily="system-ui,sans-serif" fontWeight="700" fill={col.text}>
                {row.value}
              </text>
            )}
          </g>
        );
      })}
      {diagram.unitValue && (
        <text x={PAD_X + LABEL_W} y={PAD_Y + diagram.rows.length * (ROW_H + ROW_GAP) - ROW_GAP + 20}
          fontSize="11" fontFamily="system-ui,sans-serif" fill="#64748b">
          1 unit = {diagram.unitValue}
        </text>
      )}
    </svg>
  );
}
