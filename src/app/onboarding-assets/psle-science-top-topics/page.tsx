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
            <th className="border border-slate-300 px-2 py-1.5 text-left font-bold text-[#001e40] text-[9pt] uppercase tracking-wide">Word</th>
            <th className="border border-slate-300 px-2 py-1.5 text-left font-bold text-[#001e40] text-[9pt] uppercase tracking-wide">What the marker expects</th>
            <th className="border border-slate-300 px-2 py-1.5 text-left font-bold text-[#001e40] text-[9pt] uppercase tracking-wide">One-line rule</th>
          </tr>
        </thead>
        <tbody>
          <tr className="bg-white">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>State</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">One short fact, no explanation.</td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Full sentence, no <em>because</em>.</td>
          </tr>
          <tr className="bg-slate-50">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Describe</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Observation + change.</td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Say what you see AND what happens over time.</td>
          </tr>
          <tr className="bg-white">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Explain</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Cause + effect + link back to the question.</td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Use <em>because</em> and <em>so that</em> — always link back.</td>
          </tr>
          <tr className="bg-slate-50">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Suggest</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Plausible reason with one supporting detail.</td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Not a guess — a <em>reasonable</em> answer with a mechanism.</td>
          </tr>
          <tr className="bg-white">
            <td className="border border-slate-200 px-2 py-1.5 align-top"><strong>Compare</strong></td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Similarity AND difference.</td>
            <td className="border border-slate-200 px-2 py-1.5 align-top">Always both, even if the question sounds one-sided.</td>
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
