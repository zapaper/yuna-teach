import { A4Sheet, A4SectionTitle } from "../A4Sheet";

// PSLE Science — top-5 chart + command words + common mistakes.
// Chart is the existing bar-chart PNG (day02-psle-science-top5.png).

export default function ScienceTopTopics() {
  return (
    <A4Sheet
      title="PSLE Science — Top Topics"
      subtitle="Top 5 topics by share of total PSLE Science marks."
    >
      {/* Squeeze the chart to ~65% width so the tables below have
          room to breathe with a bigger font. Centred. */}
      <div style={{ marginTop: 8, display: "flex", justifyContent: "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/onboarding-assets/science-top5.png"
          alt="PSLE Science top 5 topics by share of marks"
          style={{ width: "65%", height: "auto", display: "block" }}
        />
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

      <A4SectionTitle>Common mistakes on the top 5 — from real marking data</A4SectionTitle>
      <p className="text-[9pt] text-slate-500 italic mb-2">Based on 900+ wrong answers across MarkForYou&rsquo;s marked Science papers. Ranked by frequency within each topic.</p>
      <table className="w-full border-collapse" style={{ fontSize: "11pt" }}>
        <thead>
          <tr className="bg-[#eff4ff]">
            <th className="border border-slate-300 px-2 py-1.5 text-left font-bold text-[#001e40] text-[10pt] uppercase tracking-wide" style={{ width: "22%" }}>Topic</th>
            <th className="border border-slate-300 px-2 py-1.5 text-left font-bold text-[#001e40] text-[10pt] uppercase tracking-wide">Where students actually lose marks</th>
          </tr>
        </thead>
        <tbody>
          <tr className="bg-white">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Forces</strong><br/><span className="text-[9pt] text-slate-500">(friction / gravity / spring)</span></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">
              <strong>#1 Applying force concepts (35% of wrong).</strong> Kids can name the force but can&rsquo;t explain what happens next. <em>E.g. a parachutist at points P&rarr;Q&rarr;R</em> — students identify &ldquo;gravity&rdquo; but skip the effect on speed.
              <div className="mt-1 text-slate-700">#2 Force direction / arrows (23%). #3 Elastic-force setups &mdash; springs and rubber bands (19%).</div>
            </td>
          </tr>
          <tr className="bg-slate-50">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Interactions within the environment</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">
              <strong>#1 Adaptation (25% of wrong).</strong> Describing what the organism looks like instead of <em>how the feature helps it survive</em>.
              <div className="mt-1 text-slate-700">#2 Food-web reasoning (23%) — predicting the knock-on effect when one organism is removed. #3 Human impact (14%) &mdash; pollution, deforestation causal chains.</div>
            </td>
          </tr>
          <tr className="bg-white">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Electrical systems &amp; circuits</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">
              <strong>#1 Reading a circuit (42% of wrong).</strong> Not tracing whether the path is a complete closed loop before answering &mdash; especially on circuit-tester questions (&ldquo;which two clips must be connected?&rdquo;).
              <div className="mt-1 text-slate-700">#2 Series-vs-parallel behaviour when one bulb is removed (17%). #3 Electromagnet setups (16%).</div>
            </td>
          </tr>
          <tr className="bg-slate-50">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Heat energy &amp; uses</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">
              <strong>#1 Heat transfer &amp; material choice (32% of wrong).</strong> Picking the wrong container / material for insulation. <em>MCQ trap:</em> in one 10-yr recurring question &ldquo;which container keeps water hottest?&rdquo;, kids pick option (1) instead of (4) &mdash; 18 wrong attempts in the sample.
              <div className="mt-1 text-slate-700">#2 Changes of state (22%). #3 Heat vs temperature confusion (19%). #4 Expansion / contraction (18%).</div>
            </td>
          </tr>
          <tr className="bg-white">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Diversity of living &amp; non-living</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">
              MCQ-dominated topic (90% MCQ). Wrong answers spread thinly &mdash; no single sub-topic dominates. Watch for questions asking &ldquo;true for BOTH X and Y&rdquo; where a plausible-but-wrong distractor sits next to the correct option.
            </td>
          </tr>
        </tbody>
      </table>
      <p className="text-[9pt] text-slate-500 italic mt-2">One universal pattern: <strong>blank OEQ answers</strong> account for 15-25% of lost marks across every top-5 topic. Always attempt every sub-part &mdash; a half-answer scores more than zero.</p>
    </A4Sheet>
  );
}
