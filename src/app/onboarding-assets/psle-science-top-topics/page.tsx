import { A4Sheet, A4SectionTitle } from "../A4Sheet";

// PSLE Science — top-4 SVG bar chart + command words + common
// mistakes tables. Chart is drawn as inline SVG (was the 2022-2024
// PNG showing 5 topics) so we can drop Diversity cleanly and use
// the more rigorous 10-year 2016-2025 marks-per-paper data from
// PSLE-Science-Topic-Marks-10yr-Average.docx.

const TOP4 = [
  { name: "Interaction of forces (friction / gravity / spring)", pct: 14.0, colour: "#0f5c66" },
  { name: "Interactions within the environment",                 pct: 13.7, colour: "#3d848c" },
  { name: "Electrical systems & circuits",                       pct:  8.2, colour: "#66a5ac" },
  { name: "Heat energy & uses",                                  pct:  7.2, colour: "#8fbfc4" },
];

export default function ScienceTopTopics() {
  const axisMax = 15;
  const chartWidth = 560;
  const barAreaLeft = 210;
  const barAreaRight = chartWidth - 60;
  const rowH = 30;
  const gap = 10;
  const chartH = TOP4.length * (rowH + gap) + 4;

  return (
    <A4Sheet
      title="PSLE Science Top Topics and Mistakes"
      subtitle="Top 4 topics by mark share (10-year average, 2016-2025). Together they carry ~43% of the paper."
    >
      <div style={{ backgroundColor: "#f8f4ea", padding: "12px 14px", borderRadius: 8, marginTop: 8 }}>
        <svg viewBox={`0 0 ${chartWidth} ${chartH}`} style={{ width: "100%", height: "auto", display: "block" }}>
          {TOP4.map((t, i) => {
            const y = i * (rowH + gap);
            const w = (t.pct / axisMax) * (barAreaRight - barAreaLeft);
            return (
              <g key={t.name}>
                <text x={barAreaLeft - 8} y={y + rowH / 2 + 4} textAnchor="end" fontSize="11" fontWeight="700" fill="#0b1c30">{t.name}</text>
                <rect x={barAreaLeft} y={y} width={w} height={rowH} fill={t.colour} rx={2} />
                <text x={barAreaLeft + w + 6} y={y + rowH / 2 + 4} fontSize="12" fontWeight="800" fill="#0b1c30">{t.pct.toFixed(1)}%</text>
              </g>
            );
          })}
        </svg>
      </div>

      <A4SectionTitle>Command words — how the marker reads the verb</A4SectionTitle>
      <table className="w-full border-collapse" style={{ fontSize: "11pt" }}>
        <thead>
          <tr className="bg-[#eff4ff]">
            <th className="border border-slate-300 px-2 py-1.5 text-left font-bold text-[#001e40] text-[10pt] uppercase tracking-wide" style={{ width: "12%" }}>Word</th>
            <th className="border border-slate-300 px-2 py-1.5 text-left font-bold text-[#001e40] text-[10pt] uppercase tracking-wide" style={{ width: "28%" }}>What the marker expects</th>
            <th className="border border-slate-300 px-2 py-1.5 text-left font-bold text-[#001e40] text-[10pt] uppercase tracking-wide">Common mistakes</th>
          </tr>
        </thead>
        <tbody>
          <tr className="bg-white">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>State</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Short fact, no explanation.</td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">
              Sometimes the answer has <strong>two functions</strong>.
              <div className="mt-1 text-slate-700"><em>E.g. State the function of the stem.</em> <strong>Ans:</strong> hold plant upright <strong>and</strong> transport water, mineral salts and food.</div>
            </td>
          </tr>
          <tr className="bg-slate-50">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Describe</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Observation + change.</td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">
              Say what you see AND what happens over time AND <strong>any turning point</strong>, citing <strong>specific data</strong>.
              <div className="mt-1 text-slate-700"><em>E.g. graph showing increasing trend that inflects.</em> <strong>Ans:</strong> Amount of oxygen produced <em>increases</em> with temperature up till 20°C; thereafter, amount of oxygen <em>decreases</em> with temperature.</div>
            </td>
          </tr>
          <tr className="bg-white">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Explain</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Data + cause + effect + link back to the question.</td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">
              Use <em>because</em> and <em>so that</em> — always <strong>link back</strong> to the question.
              <div className="mt-1 text-slate-700"><em>E.g. Which material is most suitable for making the soles of shoes?</em> Students often fail to <strong>(a) cite data</strong> and <strong>(b) link back</strong> to the question (i.e. <em>&ldquo;hence material X is most suitable for making soles of shoes&rdquo;</em>).</div>
            </td>
          </tr>
          <tr className="bg-slate-50">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Suggest</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Plausible reason with one supporting detail.</td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">
              Not a guess — a <strong>reasonable</strong> answer, likely with <strong>data from the question</strong>.
            </td>
          </tr>
          <tr className="bg-white">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Compare</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Similarity AND/OR difference.</td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">
              Remember to cite <strong>both</strong>. Students sometimes cite evidence <strong>from outside the question</strong> — always use <strong>data presented in the question</strong>, do not infer unless the question says so.
            </td>
          </tr>
        </tbody>
      </table>

      <A4SectionTitle>Common Mistakes</A4SectionTitle>
      <p className="text-[9pt] text-slate-500 italic mb-2">Based on 800+ wrong answers on the top 4 topics across MarkForYou&rsquo;s marked Science papers.</p>
      <table className="w-full border-collapse" style={{ fontSize: "11pt" }}>
        <thead>
          <tr className="bg-[#eff4ff]">
            <th className="border border-slate-300 px-2 py-1.5 text-left font-bold text-[#001e40] text-[10pt] uppercase tracking-wide" style={{ width: "22%" }}>Topic</th>
            <th className="border border-slate-300 px-2 py-1.5 text-left font-bold text-[#001e40] text-[10pt] uppercase tracking-wide">The mistake &amp; a real example</th>
          </tr>
        </thead>
        <tbody>
          <tr className="bg-white">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Forces</strong><br/><span className="text-[9pt] text-slate-500">(friction / gravity / spring)</span></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">
              Can <strong>name</strong> the force but can&rsquo;t <strong>explain what happens next</strong>.
              <div className="mt-1 text-slate-700"><em>E.g. A parachutist falls from P to R and opens the parachute after P.</em> Students correctly identify <strong>gravity</strong> and <strong>air resistance</strong>, but forget to say the parachutist <strong>slows down</strong> once the parachute opens because <strong>air resistance now exceeds gravity</strong>.</div>
            </td>
          </tr>
          <tr className="bg-slate-50">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Interactions within the environment</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">
              Describing what the organism / nest <strong>looks like</strong> instead of <strong>how the feature helps it survive</strong>.
              <div className="mt-1 text-slate-700"><em>E.g. Insect P builds its nest underground and stores leaves for a fungus that its young feed on.</em> Students write &ldquo;the nest keeps the leaves hidden.&rdquo; The marker wants: &ldquo;<strong>underground is dark, moist and warm</strong> &mdash; ideal for the <strong>fungus to grow</strong> on the leaves, providing <strong>food for the young</strong>.&rdquo;</div>
            </td>
          </tr>
          <tr className="bg-white">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Electrical systems &amp; circuits</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">
              Not tracing whether the circuit forms a <strong>complete closed loop</strong>.
              <div className="mt-1 text-slate-700"><em>E.g. A circuit-tester with clips A-F: which clips must be connected so the bulb lights?</em> Students pick paths that break at one junction. Always trace <strong>battery &rarr; clip &rarr; wire &rarr; bulb &rarr; back to battery</strong> before committing.</div>
            </td>
          </tr>
          <tr className="bg-slate-50">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Heat energy &amp; uses</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">
              Confusing <strong>conductor</strong> with <strong>insulator</strong> when picking the container.
              <div className="mt-1 text-slate-700"><em>E.g. Hot water at 80&deg;C is poured into four identical containers. Which will be coldest after 2 hours?</em> The correct answer is the <strong>metal</strong> (best conductor &mdash; heat escapes fastest). Students often pick an <strong>insulator</strong> instead. MarkForYou saw this wrong pick <strong>18 times</strong> in the sample.</div>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="text-[9pt] text-slate-500 italic mt-2">Universal pattern: <strong>blank OEQ answers</strong> account for 15-25% of lost marks across every top topic. Always attempt every sub-part &mdash; a half-answer scores more than zero.</p>
    </A4Sheet>
  );
}
