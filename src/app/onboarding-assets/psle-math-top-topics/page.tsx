import { A4Sheet, A4Table, A4SectionTitle } from "../A4Sheet";

// PSLE Math — Top Topics, Tips and Common Mistakes.
// Top-5 shares from 10-year 2016-2025 analysis (source: internal
// chart). Top 5 = 59 marks out of 100 = 59% of the paper.

export default function MathTopTopics() {
  return (
    <A4Sheet
      title="Top Topics, Tips and Common Mistakes for PSLE Math"
      subtitle="One-page cheat sheet — the 5 topics that carry 59 out of 100 marks (10-year average, 2016-2025)."
    >
      <A4SectionTitle>Top 5 PSLE Math topics — 10-year average (2016-2025)</A4SectionTitle>
      <A4Table
        headers={["#", "Topic", "Marks / paper", "Example question", "Model / heuristic", "Common mistake"]}
        rows={[
          [
            "1",
            <><strong>Geometry</strong> — angles, triangles, circles, symmetry, nets</>,
            "17",
            <><em>&ldquo;Find the value of angle x in the figure below.&rdquo;</em></>,
            <>Mark every known angle on the diagram; extend lines to spot angles-on-a-straight-line and vertically-opposite pairs.</>,
            <>Forgetting <em>angles on a straight line = 180&deg;</em>; missing the isosceles-triangle rule (two equal base angles).</>,
          ],
          [
            "2",
            <><strong>Fractions</strong> — of, remainder, equivalent</>,
            "11",
            <><em>&ldquo;2/5 of the money was spent; 1/3 of the remainder was saved. Find the amount left.&rdquo;</em></>,
            <>Bar model with equal units; label the <em>total</em> and the <em>part</em>.</>,
            <>Taking a fraction of the <strong>wrong whole</strong> (original vs remainder).</>,
          ],
          [
            "3",
            <><strong>Area &amp; Perimeter</strong> — composite shapes, circles, semicircles</>,
            "11",
            <><em>&ldquo;Find the perimeter of the shaded region (quarter-circle inside a square).&rdquo;</em></>,
            <>Cut composite figures into rectangles + quarter-circles; label each region separately.</>,
            <>Missing an internal side; using <em>&pi;r&sup2;</em> for perimeter instead of <em>2&pi;r</em>.</>,
          ],
          [
            "4",
            <><strong>Measurement</strong> — length, mass, volume, time, conversions</>,
            "10",
            <><em>&ldquo;Convert 2.4 kg + 350 g to grams. Give your answer in kg.&rdquo;</em></>,
            <>Convert ALL values to the same unit BEFORE adding; write the unit at every intermediate step.</>,
            <>Slipping decimal places on kg ↔ g and m ↔ cm; adding hours + minutes without borrowing 60.</>,
          ],
          [
            "5",
            <><strong>Statistics</strong> — bar graph, pie chart, table, average</>,
            "10",
            <><em>&ldquo;Find the average number of books sold from the bar graph.&rdquo;</em></>,
            <>Underline what&rsquo;s asked; then read the scale — check whether 1 unit = 1 or 1 unit = 5/10.</>,
            <>Reading the wrong scale interval; forgetting to divide by the number of items for average.</>,
          ],
        ]}
      />
      <p className="text-[9pt] text-slate-600 mt-2 italic">
        These 5 topics together carry <strong>59 out of 100 PSLE Math marks</strong>. Drilling them well covers well over half the paper.
      </p>

      <A4SectionTitle>Bar models — the one habit that wins Paper 2</A4SectionTitle>
      <ul className="list-disc pl-5 text-[9.5pt] space-y-1">
        <li><strong>Read the question twice, draw once.</strong> Mark the <em>total</em>, the <em>asked-for part</em>, and any <em>equal-units</em> on the bar before computing.</li>
        <li><strong>Before / after problems get TWO stacked bars.</strong> Line them up so the change is visually obvious.</li>
        <li><strong>Label every arithmetic step.</strong> The marker awards method marks even when the final answer is wrong.</li>
      </ul>

      <A4SectionTitle>Command words — how the marker reads the verb</A4SectionTitle>
      <A4Table
        headers={["Word", "What the marker expects", "One-line rule"]}
        rows={[
          [
            <strong>Find</strong>,
            "The numerical answer — with the correct unit.",
            <>Always write the unit on the final line.</>,
          ],
          [
            <strong>Express</strong>,
            "The answer in a specific form (fraction, ratio, percentage).",
            <>Simplify to lowest terms.</>,
          ],
          [
            <strong>Show that&hellip;</strong>,
            "Every step leading to the given result.",
            <>Don&rsquo;t skip lines &mdash; each line = 1 method mark.</>,
          ],
          [
            <strong>Explain</strong>,
            "Reason + link to a mathematical rule.",
            <>Cite the rule by name (e.g. &ldquo;alternate angles&rdquo;).</>,
          ],
        ]}
      />
    </A4Sheet>
  );
}
