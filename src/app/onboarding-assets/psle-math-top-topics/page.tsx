import { A4Sheet, A4SectionTitle } from "../A4Sheet";

// PSLE Math — Top Topics chart + bar-models cheat-sheet image.
// Top-5 shares from 2016-2025 10-year chart. Chart drawn as SVG (no
// PNG asset on disk for the Math top-5). Bar-models poster reused
// from OneDrive Facebook Post asset.

const TOP5 = [
  { rank: 1, name: "Geometry",         marks: 17, colour: "#0f5c66" },
  { rank: 2, name: "Fractions",        marks: 11, colour: "#4a9aa4" },
  { rank: 3, name: "Area & Perimeter", marks: 11, colour: "#87c2c8" },
  { rank: 4, name: "Measurement",      marks: 10, colour: "#a9d1d5" },
  { rank: 5, name: "Statistics",       marks: 10, colour: "#a9d1d5" },
];

export default function MathTopTopics() {
  const axisMax = 20;
  const chartWidth = 560;
  const barAreaLeft = 160;
  const barAreaRight = chartWidth - 70;
  const rowH = 30;
  const gap = 10;
  const chartH = TOP5.length * (rowH + gap) + 4;

  return (
    <A4Sheet
      title="Top Topics and Advanced Bar Models Cheatsheet"
      subtitle="PSLE Math — top 5 topics by marks (per 100-mark paper). 10-year average, 2016-2025."
    >
      <div style={{ backgroundColor: "#f8f4ea", padding: "12px 14px", borderRadius: 8, marginTop: 8 }}>
        <svg viewBox={`0 0 ${chartWidth} ${chartH}`} style={{ width: "100%", height: "auto", display: "block" }}>
          {TOP5.map((t, i) => {
            const y = i * (rowH + gap);
            const w = (t.marks / axisMax) * (barAreaRight - barAreaLeft);
            return (
              <g key={t.rank}>
                <text
                  x={barAreaLeft - 8}
                  y={y + rowH / 2 + 4}
                  textAnchor="end"
                  fontSize="12"
                  fontWeight="700"
                  fill="#0b1c30"
                >
                  {t.name}
                </text>
                <rect x={barAreaLeft} y={y} width={w} height={rowH} fill={t.colour} rx={2} />
                <text
                  x={barAreaLeft + w + 6}
                  y={y + rowH / 2 + 4}
                  fontSize="12"
                  fontWeight="800"
                  fill="#0b1c30"
                >
                  {t.marks} marks
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <A4SectionTitle>Bar model cheat sheet</A4SectionTitle>
      <div style={{ backgroundColor: "#ffffff", padding: 8, border: "1px solid #e2e8f0", borderRadius: 6 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/onboarding-assets/math-bar-models.png"
          alt="PSLE Math bar-models cheat sheet"
          style={{ width: "100%", height: "auto", display: "block" }}
        />
      </div>
    </A4Sheet>
  );
}
