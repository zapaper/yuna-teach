import { A4Sheet, A4SectionTitle } from "../A4Sheet";

// PSLE Science — top-5 chart + command words + common mistakes.
// Chart is the existing bar-chart PNG (day02-psle-science-top5.png).

export default function ScienceTopTopics() {
  return (
    <A4Sheet
      title="PSLE Science — Top Topics"
      subtitle="Top 5 topics by share of total PSLE Science marks."
    >
      <div style={{ marginTop: 8 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/onboarding-assets/science-top5.png"
          alt="PSLE Science top 5 topics by share of marks"
          style={{ width: "100%", height: "auto", display: "block" }}
        />
      </div>

      <A4SectionTitle>Command words — how the marker reads the verb</A4SectionTitle>
      <table className="w-full border-collapse" style={{ fontSize: "9.5pt" }}>
        <thead>
          <tr className="bg-[#eff4ff]">
            <th className="border border-slate-300 px-2 py-1.5 text-left font-bold text-[#001e40] text-[9pt] uppercase tracking-wide" style={{ width: "12%" }}>Word</th>
            <th className="border border-slate-300 px-2 py-1.5 text-left font-bold text-[#001e40] text-[9pt] uppercase tracking-wide" style={{ width: "28%" }}>What the marker expects</th>
            <th className="border border-slate-300 px-2 py-1.5 text-left font-bold text-[#001e40] text-[9pt] uppercase tracking-wide">Common mistakes</th>
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
              Not a guess — a <strong>reasonable</strong> answer with a mechanism.
            </td>
          </tr>
          <tr className="bg-white">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Compare</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Similarity AND difference.</td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">
              Always both, even if the question sounds one-sided. Students sometimes cite evidence <strong>from outside the question</strong> — always use <strong>data presented in the question</strong>, do not infer unless the question asks for inference.
            </td>
          </tr>
        </tbody>
      </table>

      <A4SectionTitle>Common mistakes on the top 5</A4SectionTitle>
      <table className="w-full border-collapse" style={{ fontSize: "9.5pt" }}>
        <thead>
          <tr className="bg-[#eff4ff]">
            <th className="border border-slate-300 px-2 py-1.5 text-left font-bold text-[#001e40] text-[9pt] uppercase tracking-wide">Topic</th>
            <th className="border border-slate-300 px-2 py-1.5 text-left font-bold text-[#001e40] text-[9pt] uppercase tracking-wide">Common mistake</th>
          </tr>
        </thead>
        <tbody>
          <tr className="bg-white">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Interactions within the environment</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Describing appearance instead of the survival mechanism; food-chain arrows drawn the wrong way (arrows show energy flow).</td>
          </tr>
          <tr className="bg-slate-50">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Electrical systems &amp; circuits</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Confusing series ↔ parallel behaviour; not tracing the complete closed circuit before answering.</td>
          </tr>
          <tr className="bg-white">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Forces</strong> (friction / gravity / spring)</td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Forgetting arrow direction on the force diagram; not saying which force is bigger.</td>
          </tr>
          <tr className="bg-slate-50">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Heat energy &amp; uses</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Mixing up heat with temperature; forgetting that heat flows from hot to cold, not the other way.</td>
          </tr>
          <tr className="bg-white">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Diversity of living &amp; non-living</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Grouping by visual difference (colour, size) instead of a scientific property.</td>
          </tr>
        </tbody>
      </table>
    </A4Sheet>
  );
}
