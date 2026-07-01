import { A4Sheet, A4Table, A4SectionTitle } from "../A4Sheet";

// PSLE Math — Top Topics & Common Mistakes.
// Top-5 marks from 2016-2025 10-year chart:
// Geometry 17, Fractions 11, Area & Perimeter 11, Measurement 10,
// Statistics 10 (= 59 out of 100 marks).

const TOP5 = [
  { rank: 1, name: "Geometry",         marks: 17, colour: "#0f5c66" },
  { rank: 2, name: "Fractions",        marks: 11, colour: "#4a9aa4" },
  { rank: 3, name: "Area & Perimeter", marks: 11, colour: "#87c2c8" },
  { rank: 4, name: "Measurement",      marks: 10, colour: "#a9d1d5" },
  { rank: 5, name: "Statistics",       marks: 10, colour: "#a9d1d5" },
];

export default function MathTopTopics() {
  const maxMarks = 20;                                   // chart max for axis
  const chartWidth = 520;
  const barAreaLeft = 150;
  const barAreaRight = chartWidth - 60;
  const barLen = (m: number) => ((m / maxMarks) * (barAreaRight - barAreaLeft));
  const rowH = 30;
  const gap = 8;
  const chartH = TOP5.length * (rowH + gap) + 8;

  return (
    <A4Sheet
      title="PSLE Math — Top Topics & Common Mistakes"
      subtitle="10-year average (2016-2025). The 5 topics below carry 59 of 100 marks on the paper."
    >
      <A4SectionTitle>Top 5 topics by marks (per 100-mark paper)</A4SectionTitle>
      <div className="mb-2" style={{ backgroundColor: "#f8f4ea", padding: "10px 12px", borderRadius: 8 }}>
        <svg viewBox={`0 0 ${chartWidth} ${chartH}`} style={{ width: "100%", height: "auto", display: "block" }}>
          {TOP5.map((t, i) => {
            const y = i * (rowH + gap);
            const w = barLen(t.marks);
            return (
              <g key={t.rank}>
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
                <rect x={barAreaLeft} y={y} width={w} height={rowH} fill={t.colour} rx={2} />
                <text
                  x={barAreaLeft + w + 6}
                  y={y + rowH / 2 + 4}
                  fontSize="11"
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

      <A4SectionTitle>Common mistakes on the top 5</A4SectionTitle>
      <A4Table
        headers={["Topic", "Common mistake"]}
        rows={[
          [
            <><strong>Geometry</strong> — angles, triangles, circles</>,
            <>Missing <em>angles on a straight line = 180&deg;</em>; forgetting the isosceles-triangle rule (two equal base angles).</>,
          ],
          [
            <><strong>Fractions</strong> — of, remainder, equivalent</>,
            <>Taking a fraction of the <strong>wrong whole</strong> (original vs remainder). Use a bar model with the remainder drawn separately.</>,
          ],
          [
            <><strong>Area &amp; Perimeter</strong> — composite shapes, circles</>,
            <>Missing an internal side of a composite figure; using <em>&pi;r&sup2;</em> for perimeter instead of <em>2&pi;r</em>.</>,
          ],
          [
            <><strong>Measurement</strong> — length, mass, volume, time</>,
            <>Slipping decimal places on kg ↔ g and m ↔ cm; adding hours + minutes without borrowing 60.</>,
          ],
          [
            <><strong>Statistics</strong> — bar graph, pie chart, average</>,
            <>Reading the wrong scale interval; forgetting to divide by the number of items when calculating the average.</>,
          ],
        ]}
      />

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
