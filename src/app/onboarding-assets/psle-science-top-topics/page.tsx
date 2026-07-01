import { A4Sheet, A4Table, A4SectionTitle } from "../A4Sheet";

// PSLE Science — Top Topics, Tips and Common Mistakes.
// Top-5 topic shares are PLACEHOLDERS — replace with the real numbers
// from PSLE-Science-Topic-Marks-10yr-Average.docx once the user
// pastes them.

export default function ScienceTopTopics() {
  return (
    <A4Sheet
      title="Top Topics, Tips and Common Mistakes for PSLE Science"
      subtitle="One-page cheat sheet — the topics that dominate the paper, and how to write for full marks."
    >
      <A4SectionTitle>Top 5 PSLE Science topics (10-year mark share)</A4SectionTitle>
      <A4Table
        headers={["Topic", "Share", "Example question", "Marker looks for", "Common mistake"]}
        rows={[
          [
            <><strong>Cycles</strong> — water, life, matter</>,
            "~18%",
            <><em>&ldquo;State a change of state and give the cause.&rdquo;</em></>,
            <><em>condensed</em>, <em>evaporated</em>, <em>heat gained/lost</em>, <em>change of state</em>.</>,
            <>Mixing up condensation ↔ evaporation causes.</>,
          ],
          [
            <><strong>Systems</strong> — human digestion, circulation, plant transport</>,
            "~16%",
            <><em>&ldquo;Explain how oxygen reaches the muscle cells.&rdquo;</em></>,
            <><em>transports X from Y to Z</em>, <em>adapted for&hellip;</em></>,
            <>Confusing digestion ↔ absorption; describing structure instead of function.</>,
          ],
          [
            <><strong>Energy</strong> — forms + conversion</>,
            "~14%",
            <><em>&ldquo;Describe the energy change when the ball is dropped.&rdquo;</em></>,
            <><em>kinetic energy converted to&hellip;</em>, <em>stored as&hellip;</em></>,
            <>Not naming the type (chemical / kinetic / potential) — calling everything &ldquo;energy&rdquo;.</>,
          ],
          [
            <><strong>Interactions of Forces</strong> — friction, gravity, elastic</>,
            "~13%",
            <><em>&ldquo;Explain why box A moves faster than box B.&rdquo;</em></>,
            <><em>force acts in direction of&hellip;</em>, <em>greater than&hellip; so&hellip;</em></>,
            <>Forgetting arrow direction on the diagram; ignoring the weight of the object.</>,
          ],
          [
            <><strong>Diversity of Living Things</strong> — classification, adaptation, reproduction</>,
            "~12%",
            <><em>&ldquo;Suggest one adaptation and how it helps X survive.&rdquo;</em></>,
            <><em>respiration takes in&hellip; gives out&hellip;</em>, <em>adapted to&hellip;</em></>,
            <>Swapping stamen ↔ pistil; describing appearance instead of survival benefit.</>,
          ],
        ]}
      />

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
    </A4Sheet>
  );
}
