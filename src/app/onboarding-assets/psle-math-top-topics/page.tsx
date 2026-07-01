import { A4Sheet, A4Table, A4SectionTitle } from "../A4Sheet";

// PSLE Math — Top Topics, Tips and Common Mistakes.
// Top-5 topic shares are PLACEHOLDERS pending the 10-year analysis.
// Bar-model tips lifted from the existing bar-models Facebook post so
// the family reads consistent with what parents may have seen.

export default function MathTopTopics() {
  return (
    <A4Sheet
      title="Top Topics, Tips and Common Mistakes for PSLE Math"
      subtitle="One-page cheat sheet — the topics that dominate the paper, the models that unlock them."
    >
      <A4SectionTitle>Top 5 PSLE Math topics (10-year mark share — draft)</A4SectionTitle>
      <A4Table
        headers={["Topic", "Share", "Model / heuristic", "Common mistake"]}
        rows={[
          [
            <><strong>Fractions</strong> — of, remainder, equivalent</>,
            "~18%",
            <>Bar model with equal units; label the &ldquo;total&rdquo; and the &ldquo;part&rdquo;.</>,
            <>Taking a fraction of the WRONG whole (original vs remainder).</>,
          ],
          [
            <><strong>Ratio</strong> — 2-quantity, 3-quantity, before/after</>,
            "~15%",
            <>Bar model where each unit is drawn to scale; align changes across before/after rows.</>,
            <>Adding a fixed amount to ONE side without adjusting units.</>,
          ],
          [
            <><strong>Percentage</strong> — of, more/less than, discount</>,
            "~14%",
            <>Anchor on 100% = the base; convert between % and fraction (25% = 1/4).</>,
            <>Percentage OF the new price vs percentage OF the original.</>,
          ],
          [
            <><strong>Area &amp; Perimeter</strong> — composite shapes, circles</>,
            "~13%",
            <>Cut composite figures into rectangles + quarter-circles; label each region.</>,
            <>Missing an internal side; using &pi;r&sup2; when perimeter is asked.</>,
          ],
          [
            <><strong>Rate &amp; Speed</strong> — average, unit conversion</>,
            "~12%",
            <>Distance = Speed × Time; always check units (km vs m, hr vs min).</>,
            <>Averaging two speeds instead of total-distance ÷ total-time.</>,
          ],
        ]}
      />

      <A4SectionTitle>Bar models — the one habit that wins Paper 2</A4SectionTitle>
      <ul className="list-disc pl-5 text-[9.5pt] space-y-1">
        <li><strong>Read the question twice, draw once.</strong> Mark the &ldquo;total&rdquo;, the &ldquo;asked-for part&rdquo;, and any &ldquo;equal-units&rdquo; on the bar before computing.</li>
        <li><strong>Before / after problems get TWO stacked bars.</strong> Line them up so the change is visually obvious.</li>
        <li><strong>3-quantity ratios: pull the constant quantity out.</strong> If one value is fixed, anchor on it and adjust the other two in units.</li>
        <li><strong>Label every arithmetic step.</strong> The marker awards method marks even when the final answer is wrong.</li>
      </ul>

      <A4SectionTitle>Command words — how the marker reads the verb</A4SectionTitle>
      <A4Table
        headers={["Word", "What the marker expects", "One-line rule"]}
        rows={[
          [
            <strong>Find</strong>,
            "The numerical answer — no working needed for method marks.",
            <>Show units in the final line.</>,
          ],
          [
            <strong>Express</strong>,
            "The answer in a specific form (fraction, ratio, percentage).",
            <>Simplify to lowest terms.</>,
          ],
          [
            <strong>Show that&hellip;</strong>,
            "Every step leading to the given result.",
            <>Don&rsquo;t skip lines &mdash; each line = 1 mark.</>,
          ],
          [
            <strong>Explain</strong>,
            "Reason + link to a mathematical rule.",
            <>Cite the rule (e.g. &ldquo;alternate angles&rdquo;).</>,
          ],
        ]}
      />
    </A4Sheet>
  );
}
