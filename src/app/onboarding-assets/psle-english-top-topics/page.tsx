import { A4Sheet, A4Table, A4SectionTitle } from "../A4Sheet";

// PSLE English — Top Topic, Tips and Common Mistakes.
// One-page A4 asset linked from the OnboardingBanner "download PDF"
// CTA. Iterate copy in this file; refresh + Ctrl+P for a fresh PDF.
//
// Weightage numbers mirror PSLE_GRAMMAR_WEIGHTAGE and
// PSLE_SYNTHESIS_WEIGHTAGE in src/app/tutor/[parentId]/page.tsx so the
// PDF echoes what the parent just saw in the Lumi fluency table.

export default function EnglishTopTopics() {
  return (
    <A4Sheet
      title="PSLE English — Top Topics & Common Mistakes"
      subtitle="One-page cheat sheet — the grammar rules and synthesis tricks that decide the paper."
    >
      <A4SectionTitle>Grammar (~14 marks of Paper 2)</A4SectionTitle>
      <A4Table
        headers={["Rule", "PSLE %", "Tip in one line", "Common mistake"]}
        rows={[
          [
            "Connectors & tenses",
            "26%",
            <>Match tense pairs across the sentence (<em>was</em>/<em>were</em>, <em>has</em>/<em>have</em>).</>,
            <>Mixed tenses inside one clause.</>,
          ],
          [
            "Verb forms",
            "21%",
            <><em>-ing</em> after <em>prevent from</em>, <em>stop from</em>; base form after <em>let</em>, <em>make</em>.</>,
            <>Wrong form after a modal + main-verb chain.</>,
          ],
          [
            "Prepositions",
            "18%",
            <>Learn preposition + noun collocations by heart.</>,
            <><em>discuss about</em>, <em>listen music</em>.</>,
          ],
          [
            "Tag questions",
            "12%",
            <>Positive stem → negative tag, same auxiliary.</>,
            <><em>isn&rsquo;t it?</em> after a <em>don&rsquo;t</em> stem.</>,
          ],
          [
            "Countable / uncountable",
            "9%",
            <><em>Fewer</em> for countable, <em>less</em> for uncountable.</>,
            <><em>less mistakes</em> → should be <em>fewer mistakes</em>.</>,
          ],
          [
            "Subject-verb agreement",
            "7%",
            <>Isolate the head noun; ignore intervening phrases.</>,
            <>Verb agreeing with the noun inside <em>of + plural</em>.</>,
          ],
          [
            "Pronouns",
            "6%",
            <><em>its</em> = possessive, <em>it&rsquo;s</em> = <em>it is</em>; <em>their/there/they&rsquo;re</em>.</>,
            <>Homophone slips (<em>there hats</em> vs <em>their hats</em>).</>,
          ],
        ]}
      />

      <A4SectionTitle>Synthesis &amp; Transformation (5 marks · 1 per paper)</A4SectionTitle>
      <A4Table
        headers={["Trick", "PSLE %", "Tip in one line", "Common mistake"]}
        rows={[
          [
            "Reported speech",
            "25%",
            <>Shift tense back; swap <em>I → he/she</em>, <em>today → that day</em>.</>,
            <>Keeping present tense after <em>said that&hellip;</em></>,
          ],
          [
            "Correlative / preference",
            "20%",
            <><em>Not only&hellip; but also&hellip;</em>, <em>either&hellip; or&hellip;</em>, <em>would rather&hellip; than&hellip;</em></>,
            <><em>either / nor</em>, <em>neither / or</em> — pair mismatch.</>,
          ],
          [
            "Subordinator",
            "18%",
            <><em>because</em> vs <em>so</em>; time markers <em>while</em>, <em>when</em>, <em>as</em>.</>,
            <>Comma splice instead of a subordinating conjunction.</>,
          ],
          [
            "Noun phrase",
            "15%",
            <>Turn a verb into its noun form (<em>decide → decision</em>).</>,
            <>Wrong preposition after the nominalised noun.</>,
          ],
          [
            "Participle clauses",
            "12%",
            <>Present participle for active; past participle for passive.</>,
            <>Dangling participle: <em>Walking home, the rain started.</em></>,
          ],
          [
            "Substitution / inversion",
            "10%",
            <><em>So did I</em> after positive; <em>Neither did I</em> after negative.</>,
            <>Wrong auxiliary in the inversion.</>,
          ],
        ]}
      />

      <A4SectionTitle>Two habits that save marks</A4SectionTitle>
      <ul className="list-disc pl-5 text-[9.5pt] space-y-1">
        <li><strong>Read aloud in your head</strong> — verb-form and tag-question errors surface immediately.</li>
        <li><strong>Underline the tested word first</strong> — Grammar MCQ traps the eye with tempting distractors right next to the correct answer.</li>
      </ul>
    </A4Sheet>
  );
}
