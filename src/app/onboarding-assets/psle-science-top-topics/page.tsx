import { A4Sheet, A4SectionTitle } from "../A4Sheet";

// PSLE Science — top-5 chart + command words + common mistakes.
// Chart is the existing bar-chart PNG (day02-psle-science-top5.png).

export default function ScienceTopTopics() {
  return (
    <A4Sheet
      title="PSLE Science Top Topics and Mistakes"
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
