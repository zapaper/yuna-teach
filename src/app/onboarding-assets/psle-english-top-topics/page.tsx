import { A4Sheet, A4SectionTitle } from "../A4Sheet";
import type { CSSProperties, ReactNode } from "react";

// PSLE English — Grammar rules donut pies + Reported Speech cheat
// sheet. Pies are drawn as inline SVG so labels don't overlap and
// the font is legible on A4 print. "Others" slice is intentionally
// dropped (< 2% and ~1% respectively; the user's asked to hide it).
//
// Data source: PSLE-Grammar-7-Rules-Match-Post.docx (12 years,
// 2014-2025, n=122 MCQ + n=120 Cloze).

type Slice = { label: string; pct: number; colour: string };

const MCQ: Slice[] = [
  { label: "Connectors & tenses",       pct: 26.2, colour: "#2b6a5f" },
  { label: "Verb-forms (gerund / infinitive / causative)", pct: 21.3, colour: "#d97a2f" },
  { label: "Idiomatic prepositions",    pct: 18.0, colour: "#4a7fbf" },
  { label: "Tag questions",             pct: 11.5, colour: "#e0a02b" },
  { label: "Countable / uncountable",   pct:  9.0, colour: "#8f5aa8" },
  { label: "Subject-verb agreement",    pct:  6.6, colour: "#c15b3f" },
  { label: "Pronouns",                  pct:  5.7, colour: "#dfc744" },
];
// Cloze reuses the same colour per rule so the reader recognises
// each rule across the two pies at a glance.
const CLOZE: Slice[] = [
  { label: "Connectors & tenses",     pct: 35.0, colour: "#2b6a5f" },
  { label: "Idiomatic prepositions",  pct: 25.0, colour: "#4a7fbf" },
  { label: "Pronouns",                pct: 16.7, colour: "#dfc744" },
  { label: "Subject-verb agreement",  pct: 15.8, colour: "#c15b3f" },
  { label: "Countable / uncountable", pct:  6.7, colour: "#8f5aa8" },
];

// Donut geometry: outer radius R, inner radius r, from centre (cx,cy).
// Total pct sums under 100 (we dropped "Others" — ~1-2%); we
// re-normalise so the pie fills the ring visually.
function DonutPie({ slices, size = 200, n }: { slices: Slice[]; size?: number; n: number }) {
  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.42;
  const r = size * 0.26;
  const total = slices.reduce((s, x) => s + x.pct, 0);
  let acc = 0;
  const segments = slices.map(s => {
    const startAngle = (acc / total) * 2 * Math.PI - Math.PI / 2;
    acc += s.pct;
    const endAngle = (acc / total) * 2 * Math.PI - Math.PI / 2;
    const large = endAngle - startAngle > Math.PI ? 1 : 0;
    const x1 = cx + R * Math.cos(startAngle);
    const y1 = cy + R * Math.sin(startAngle);
    const x2 = cx + R * Math.cos(endAngle);
    const y2 = cy + R * Math.sin(endAngle);
    const xi2 = cx + r * Math.cos(endAngle);
    const yi2 = cy + r * Math.sin(endAngle);
    const xi1 = cx + r * Math.cos(startAngle);
    const yi1 = cy + r * Math.sin(startAngle);
    const d = [
      `M ${x1} ${y1}`,
      `A ${R} ${R} 0 ${large} 1 ${x2} ${y2}`,
      `L ${xi2} ${yi2}`,
      `A ${r} ${r} 0 ${large} 0 ${xi1} ${yi1}`,
      "Z",
    ].join(" ");
    return { d, colour: s.colour };
  });
  return (
    <svg viewBox={`0 0 ${size} ${size}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {segments.map((seg, i) => (
        <path key={i} d={seg.d} fill={seg.colour} stroke="#fff" strokeWidth={1.5} />
      ))}
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize={size * 0.09} fontWeight={800} fill="#0b1c30">n = {n}</text>
      <text x={cx} y={cy + size * 0.08} textAnchor="middle" fontSize={size * 0.055} fill="#0b1c30">PSLE 2014-2025</text>
    </svg>
  );
}

function Legend({ slices }: { slices: Slice[] }) {
  const rowStyle: CSSProperties = { display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 4, fontSize: "10pt" };
  const dotStyle = (c: string): CSSProperties => ({ width: 12, height: 12, borderRadius: 3, backgroundColor: c, flex: "0 0 12px", marginTop: 3 });
  return (
    <div style={{ marginTop: 8 }}>
      {slices.map((s, i) => (
        <div key={i} style={rowStyle}>
          <span style={dotStyle(s.colour)} />
          <span style={{ flex: 1, lineHeight: 1.25 }}>
            <strong>{s.pct}%</strong> — {s.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function PieBlock({ title, slices, n }: { title: string; slices: Slice[]; n: number }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <h3 className="font-headline font-extrabold text-[#001e40] text-center" style={{ fontSize: "11pt", marginBottom: 4 }}>{title}</h3>
      <DonutPie slices={slices} n={n} />
      <Legend slices={slices} />
    </div>
  );
}

export default function EnglishTopTopics(): ReactNode {
  return (
    <A4Sheet
      title="PSLE Grammar Rules and Report Speech Tricks"
      subtitle="12 years of PSLE English Booklet A (2014-2025). Where do the marks come from?"
    >
      <A4SectionTitle>Top Grammar Rules Tested in PSLE</A4SectionTitle>
      <div style={{ display: "flex", gap: 16 }}>
        <PieBlock title="Grammar MCQ (n=122)" slices={MCQ} n={122} />
        <PieBlock title="Grammar Cloze (n=120)" slices={CLOZE} n={120} />
      </div>

      <A4SectionTitle>Reported Speech Cheat Sheet — 5 common traps</A4SectionTitle>
      <div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/onboarding-assets/english-reported-speech.png"
          alt="Reported Speech Cheat Sheet: 5 common traps"
          style={{ width: "100%", height: "auto", display: "block" }}
        />
      </div>
    </A4Sheet>
  );
}
