import { A4Sheet, A4Table, A4SectionTitle } from "../A4Sheet";

// PSLE Science — Top Topics, Tips and Common Mistakes.
// Top-5 shares from 10-year 2016-2025 analysis
// (see: PSLE-Science-Topic-Marks-10yr-Average.docx). Top 5 = 50% of
// total PSLE Science marks.

export default function ScienceTopTopics() {
  return (
    <A4Sheet
      title="PSLE Science — Top Topics & Common Mistakes"
      subtitle="10-year average (2016-2025). The 5 topics below carry HALF the PSLE mark load."
    >
      <A4SectionTitle>Top 5 PSLE Science topics — 10-year average (2016-2025)</A4SectionTitle>
      <A4Table
        headers={["#", "Topic", "Marks / paper", "OEQ share", "Example question", "Marker looks for", "Common mistake"]}
        rows={[
          [
            "1",
            <><strong>Interaction of forces</strong> — friction, gravity, magnets</>,
            "14.0",
            "46%",
            <><em>&ldquo;Explain why the box slides faster on the smooth surface.&rdquo;</em></>,
            <><em>friction is less/greater</em>, <em>gravity pulls&hellip; down</em>, <em>opposing force</em>.</>,
            <>Forgetting arrow direction on the force diagram; not saying which force is bigger.</>,
          ],
          [
            "2",
            <><strong>Interactions within the environment</strong> — food chains, adaptations, ecosystems</>,
            "13.7",
            "58%",
            <><em>&ldquo;Suggest one adaptation and how it helps X survive.&rdquo;</em></>,
            <><em>adapted to&hellip;</em>, <em>producer / consumer</em>, <em>arrow shows energy flow</em>.</>,
            <>Describing appearance instead of survival mechanism; food-chain arrows drawn the wrong way.</>,
          ],
          [
            "3",
            <><strong>Electrical systems &amp; circuits</strong> — series, parallel, conductors</>,
            "8.2",
            "54%",
            <><em>&ldquo;Explain what happens to the bulbs when switch S is opened.&rdquo;</em></>,
            <><em>circuit is broken</em>, <em>current cannot flow through&hellip;</em>, <em>bulbs in series / parallel</em>.</>,
            <>Confusing series ↔ parallel behaviour; not tracing the complete closed circuit.</>,
          ],
          [
            "4",
            <><strong>Heat energy &amp; uses</strong> — conduction, expansion, transfer</>,
            "7.2",
            "58%",
            <><em>&ldquo;Explain why the metal spoon feels hot in hot soup.&rdquo;</em></>,
            <><em>heat gained / lost</em>, <em>conductor / insulator</em>, <em>heat flows from hot to cold</em>.</>,
            <>Mixing up heat with temperature; forgetting heat flows from hot → cold, not the reverse.</>,
          ],
          [
            "5",
            <><strong>Diversity of living &amp; non-living things</strong> — classification, materials</>,
            "7.1",
            "10%",
            <><em>&ldquo;Classify X, Y, Z into two groups. Explain your grouping.&rdquo;</em></>,
            <><em>possesses / does not possess&hellip;</em>, <em>flexible</em>, <em>waterproof</em>, <em>strong</em>.</>,
            <>Grouping by visual difference (colour, size) instead of a scientific property.</>,
          ],
        ]}
      />
      <p className="text-[9pt] text-slate-600 mt-2 italic">
        These 5 topics together carry <strong>50% of PSLE Science marks</strong>. Drilling them well covers half the paper.
      </p>

      <A4SectionTitle>Command words decoder — how the marker reads the verb</A4SectionTitle>
      <A4Table
        headers={["Word", "What the marker expects", "One-line rule"]}
        rows={[
          [
            <strong>State</strong>,
            "One short fact, no explanation.",
            <>Full sentence, no <em>because</em>.</>,
          ],
          [
            <strong>Describe</strong>,
            "Observation + change.",
            <>Say what you see AND what happens over time.</>,
          ],
          [
            <strong>Explain</strong>,
            "Cause + effect + link back to the question.",
            <>Use <em>because</em> and <em>so that</em> — always link back.</>,
          ],
          [
            <strong>Suggest</strong>,
            "Plausible reason with one supporting detail.",
            <>Not a guess — a <em>reasonable</em> answer with a mechanism.</>,
          ],
          [
            <strong>Compare</strong>,
            "Similarity AND difference.",
            <>Always both, even if the question sounds one-sided.</>,
          ],
        ]}
      />

      <A4SectionTitle>Two habits that save marks on OEQ</A4SectionTitle>
      <ul className="list-disc pl-5 text-[9.5pt] space-y-1">
        <li><strong>Answer in 3 parts:</strong> observation → mechanism → link back to the question. Missing the &ldquo;link back&rdquo; is the #1 reason a technically correct answer scores 1 out of 2.</li>
        <li><strong>Use the marker&rsquo;s keywords.</strong> Every top-5 topic has a small vocabulary the marker scans for. If your answer avoids those words, you leak marks even if the science is right.</li>
      </ul>
    </A4Sheet>
  );
}
