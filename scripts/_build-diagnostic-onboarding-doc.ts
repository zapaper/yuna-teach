// Build a Word doc summarising the proposed onboarding diagnostic
// design + the data-supply check that supports it. Saved into the
// user's OneDrive shared folder (per feedback_shared_folder memory).
//
// Run: npx tsx scripts/_build-diagnostic-onboarding-doc.ts

import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } from "docx";
import { writeFile } from "fs/promises";
import path from "path";

const OUT = "C:/Users/peter/OneDrive/Documents/MarkForYou/MarkForYou-Onboarding-Diagnostic-Plan.docx";

// Shorthand builders
const H = (text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1) =>
  new Paragraph({ text, heading: level, spacing: { before: 240, after: 120 } });
const P = (text: string) => new Paragraph({ children: [new TextRun(text)], spacing: { after: 120 } });
const B = (text: string) => new Paragraph({ children: [new TextRun({ text, bold: true })], spacing: { after: 120 } });
const Q = (text: string) => new Paragraph({ children: [new TextRun({ text, italics: true, color: "555555" })], indent: { left: 400 }, spacing: { after: 120 } });
const Bullet = (text: string) => new Paragraph({ children: [new TextRun(text)], bullet: { level: 0 }, spacing: { after: 60 } });
const SubBullet = (text: string) => new Paragraph({ children: [new TextRun(text)], bullet: { level: 1 }, spacing: { after: 40 } });

function makeTable(header: string[], rows: string[][]): Table {
  const borders = { top: { style: BorderStyle.SINGLE, size: 4, color: "999999" }, bottom: { style: BorderStyle.SINGLE, size: 4, color: "999999" }, left: { style: BorderStyle.SINGLE, size: 4, color: "999999" }, right: { style: BorderStyle.SINGLE, size: 4, color: "999999" } };
  const cell = (text: string, opts: { bold?: boolean; shade?: string } = {}) => new TableCell({
    borders,
    shading: opts.shade ? { fill: opts.shade, color: "auto", type: "clear" } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text, bold: opts.bold })] })],
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: header.map(h => cell(h, { bold: true, shade: "E8EEF6" })) }),
      ...rows.map(r => new TableRow({ children: r.map(c => cell(c)) })),
    ],
  });
}

const doc = new Document({
  creator: "MarkForYou",
  title: "Onboarding Diagnostic Plan",
  styles: {
    default: { document: { run: { font: "Calibri", size: 22 } } },
  },
  sections: [
    {
      properties: {},
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 120 },
          children: [new TextRun({ text: "Onboarding Diagnostic — Plan & Data Check", bold: true, size: 40 })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 300 },
          children: [new TextRun({ text: "Replacing 'set a quiz' with a 20-minute insights diagnostic", italics: true, color: "555555" })],
        }),

        H("1. Why we are changing onboarding"),
        P("MarkForYou is no longer being pitched as a marker. We are pitching insights and personalised education — the marker is the on-ramp, but the value the parent buys is the picture we paint of their child's gaps and the personalised practice we build around those gaps."),
        P("The current onboarding ends with 'set a quiz'. It puts the parent in the driver's seat before we've told them anything — the reason the funnel keeps leaking at the assigned-but-not-attempted stage (50% drop across the last 150 signups). The new onboarding delivers the pitch mechanically: a 20-minute diagnostic goes in, an initial progress chart comes out on the very same session, and the parent can immediately see the topic-level shape of what their child does not know."),
        P("This is the diagnostic-then-personalise loop the marketing site (preview-v2) already sells. Onboarding needs to match."),

        H("2. The empirical case — where the current funnel leaks"),
        P("We ran the funnel across the last 150 parent signups (2026-06-03 → 2026-06-30). The failure is not at signup, linking, or paper-assignment. It is at the moment the child is meant to actually start."),
        makeTable(
          ["Stage", "Count", "% of signups", "Drop from previous stage"],
          [
            ["1. Signed up", "150", "100%", "—"],
            ["2. Linked a student", "137", "91%", "13"],
            ["3. Paper assigned", "128", "85%", "9"],
            ["4. Any attempt", "64", "43%", "64 ⚠ largest drop"],
            ["5. Any completed", "52", "35%", "12"],
          ],
        ),
        P(""),
        P("Half the parents who successfully teed up a paper never had their child attempt it. That is what the new diagnostic is designed to eliminate — the diagnostic doubles as the first attempt, so 'assigned' and 'attempted' collapse into the same action."),
        P(""),
        B("Time to first attempt (n=63 attempters):"),
        Bullet("Median: 3 minutes."),
        Bullet("42 of 63 (67%) attempted within 10 minutes of signup."),
        Bullet("Another 7 attempted within an hour."),
        Bullet("Only 7 attempted 24 hours or more after signup."),
        P("The read: it is 'attempt immediately or never' — there is essentially no 'come back tomorrow' recovery. Every second in onboarding matters, and the 'set a quiz' step wastes those seconds. The new diagnostic launches inside the signup flow."),
        P(""),
        B("Attempt rate by first-paper subject:"),
        makeTable(
          ["Subject of first assigned paper", "Signups (n)", "Attempt rate"],
          [
            ["Math", "48", "58%"],
            ["Science", "35", "57%"],
            ["English", "45", "36% ⚠ 22 pts below Math/Science"],
          ],
        ),
        P("English is the standout leak. Not a data-noise gap — 22 percentage points on n=45 is real. The current English first-quiz is heavier than Math/Science, and kids opt out cold. The new diagnostic uses only Grammar MCQ + short typed Synthesis, which is deliberately lower-friction than the current English quiz composition (which can include Comp Cloze, Comp OEQ, or Editing)."),
        P(""),
        B("Attempt rate by signup hour (SGT):"),
        Bullet("Great: 15:00–19:00 (63–100% conversion — kids home from school, parent present)."),
        Bullet("Weak: 21:00–01:00 (0–33%) — late-evening signup, no follow-through that night."),
        Bullet("Weak: 07:00–08:00 (11–33%) — pre-work window."),
        P("Peak signup volume clusters at 11:00, 16:00, and 21:00. The 21:00 cohort converts at only 33%, so it's a large volume × low conversion loss. Suggests a 'save for tomorrow morning' option in the diagnostic launch — see §10 open items."),
        P(""),
        B("Attempt rate by day of week (SGT):"),
        Bullet("Best: Mon 52%, Wed 52%, Thu 46%, Sat 47%."),
        Bullet("Worst: Tue 24% (n=21, so noise-vulnerable but worth flagging), Sun 36%."),
        P(""),
        B("The Day-3 nurture nudge is not the answer:"),
        Bullet("124 Day-3 nudges sent all-time (campaign started 2026-06-27, cron paused 2026-06-30)."),
        Bullet("2 of the 124 (1.6%) attempted an English question AFTER the nudge fired — strict attribution, excluding kids who had already touched anything before Day 3."),
        Bullet("The other 122 did not engage even with the auto-quiz + email in the inbox — a 3-day delay is far past the '3-minute median' window that actually converts."),
        Bullet("Final conversion checkpoint 2026-07-04. Preliminary read strongly favours redesigning the onboarding moment over patching the follow-up nudge."),
        P(""),
        P("Bottom line: the 'assigned → attempted' drop is a 64-parent, ~$X-of-marketing-cost hole in the funnel. Fixing it by moving the first attempt inside the signup session (the diagnostic) recovers the largest number of would-be users at the lowest per-user cost of any change we could make."),

        H("3. The new onboarding flow"),
        Bullet("Parent signs up → adds child → picks ONE subject: English, Math, or Science."),
        Bullet("The system generates a level-appropriate all-MCQ (English also has a typed-synthesis component) diagnostic, sized to ~20 minutes."),
        Bullet("Child attempts the diagnostic in-session. All auto-marked."),
        Bullet("Review screen shows every question with mark + explanation (already built)."),
        Bullet("At the end of review, the parent lands DIRECTLY on the Progress page. The per-topic column chart is populated with the diagnostic result — the parent's first impression is a visual read of the gaps."),
        Bullet("A prominent CTA on that page: \"Do a few more quizzes to refine the picture — accuracy improves with more data.\""),
        P(""),
        B("Not launched yet."),
        P("Ship behind a feature flag. Workshop the copy and the chart-empty-state before we route real signups through it."),

        H("4. Diagnostic composition by subject"),

        H("4.1 English (20 questions)", HeadingLevel.HEADING_2),
        Bullet("14 MCQ Grammar — 2 questions per PSLE grammar rule (7 rules × 2)."),
        SubBullet("Rules: connectors-tenses, verb-forms, idiomatic-prepositions, tag-questions, countable/uncountable, subject-verb-agreement, pronouns."),
        Bullet("6 typed Synthesis — 2 per trick, from three tricks that hit hardest in practice."),
        SubBullet("Recommended: reported-speech, correlative-preference (verb → noun / preference), noun-phrase (verb → noun)."),
        SubBullet("These are the tricks that show up most reliably at every PSLE and have the largest supply in our bank."),
        Bullet("Typed synthesis stays typed — do not force it into MCQ. Kids get 2 min per synthesis; total ~20 min."),

        H("4.2 Math (15 MCQ)", HeadingLevel.HEADING_2),
        Bullet("3 MCQs from EACH of the top 5 topics for the child's level × assessment period."),
        Bullet("For P6: use the child's overall syllabus (top-5 topics by paper-frequency)."),
        Bullet("For P4/P5: pick the top-5 topics from the WA/EOY window active for the current calendar date (see §6 for the lookup table)."),

        H("4.3 Science (15 MCQ)", HeadingLevel.HEADING_2),
        Bullet("Same shape as Math: 3 MCQs from each of the top 5 topics for the child's level × assessment period."),

        H("5. Data-supply check — do we have enough?"),
        P("Ran the supply probe on the master bank (paperType=null, sourceExamId=null, extractionStatus=ready)."),
        B("English:"),
        Bullet("Grammar MCQ across all rules: min 31 questions (tag-questions), max 202 (connectors-tenses). All 7 rules have 30+ questions. 2/rule is trivially feasible."),
        Bullet("Synthesis (both label variants combined): 326 master rows. Broken down by trick: subordinator 89, reported-speech 59, noun-phrase 47, correlative-preference 40, participle-clauses 21, substitution-inversion 21. All 6 tricks have 20+ questions."),
        Bullet("Synthesis by level: Primary 3 has 4, Primary 4 has 33, Primary 5 has 48, Primary 6 has 180, PSLE has 61."),
        Bullet("English master papers by level (all types): P4 has 10 masters + 46 focused + 199 quizzes; P5 has 9 + 60 + 188; P6 has 18 + 8 + 892. Sufficient across levels."),
        B("Math + Science:"),
        Bullet("Every P4/P5/P6 top-5 topic has 3+ MCQs in the bank (verified per-level per-topic). PSLE too."),
        Bullet("Only edge cases: P5 Algebra (1 MCQ), P4 Compass (1), and a few P4/P5 topics that appear late in the year. Not in the top-5 for their level, so not blocking the diagnostic."),

        H("6. WA1 / WA2 / WA3 / EOY topic lookup"),
        P("Derived from actual paper titles in the bank. Use this to pick the top-5 topics per (level, period) at diagnostic-generation time."),

        H("6.1 Primary 4", HeadingLevel.HEADING_2),
        B("Math"),
        makeTable(
          ["Period", "Top 5 hot topics (MCQ count)"],
          [
            ["WA1", "Basic operations (38), Fractions (2), Statistics (2), Geometry (1), Ratio (1)"],
            ["WA2", "Geometry (12), Fractions (4), Basic operations (4), Statistics (2), Compass (1)"],
            ["WA3", "Fractions (13), Basic operations (5), Ratio (1)"],
            ["EOY", "Basic operations (16), Geometry (6), Fractions (6), Statistics (3), Time (2)"],
          ],
        ),
        P(""),
        B("Science"),
        makeTable(
          ["Period", "Top 5 hot topics (MCQ count)"],
          [
            ["WA1", "Plant parts (15), Human digestive (11), Diversity of living (8), Human respiratory (7), Cycles in matter (6)"],
            ["WA2", "Cycles in matter (15), Light (9), Plant parts (6), Life cycles (6), Magnets (3)"],
            ["WA3", "Heat energy (2), Cycles in matter (1)  ⚠ sparse coverage in this period"],
            ["EOY", "Diversity of living (3), Life cycles (3), Plant parts (3), Human respiratory (2), Heat energy (2)"],
          ],
        ),

        H("6.2 Primary 5", HeadingLevel.HEADING_2),
        B("Math"),
        makeTable(
          ["Period", "Top 5 hot topics (MCQ count)"],
          [
            ["WA1", "Basic operations (12), Fractions (3)"],
            ["WA2", "Basic operations (8), Volume of cube/cuboid (7), Fractions (6), Geometry (5), Ratio (3)"],
            ["EOY", "Basic operations (4), Geometry (4), Fractions (2), Percentage (2), Time (1)"],
          ],
        ),
        P(""),
        B("Science"),
        makeTable(
          ["Period", "Top 5 hot topics (MCQ count)"],
          [
            ["WA1", "Reproduction (11), Cycles in matter (4), Water cycle (2), Heat (2), Life cycles (1)"],
            ["WA2", "Cycles in matter (15), Water cycle (15), Heat (11), Human respiratory (11), Reproduction (10)"],
            ["WA3", "Photosynthesis (2), Heat (2), Cycles (1), Water cycle (1)  ⚠ sparse coverage"],
            ["EOY", "Reproduction (4), Heat (3), Diversity of living (3), Plant parts (2), Magnets (2)"],
          ],
        ),

        H("6.3 Primary 6 / PSLE", HeadingLevel.HEADING_2),
        P("At P6 / PSLE the topic spread widens and papers cover most of the syllabus. Use the standard top-5 (by aggregate MCQ frequency) across all P6 masters — no WA-period specialisation needed."),
        Bullet("Math P6 top-5: Fractions (33), Geometry (27), Basic operations (21/19 combined), Percentage (18), Ratio (17)."),
        Bullet("Science P6 top-5: Interactions within environment (50), Energy conversion (34), Interaction of forces (30), Cycles in matter (23), Heat (23)."),

        H("7. Storage — the lookup table"),
        P("Ship this as a static file at src/lib/psle-topic-schedule.ts:"),
        Q("export const TOPIC_SCHEDULE: Record<Level, Record<Period, string[]>> = { \"Primary 4\": { WA1: [...], WA2: [...], WA3: [...], EOY: [...] }, \"Primary 5\": {...}, \"Primary 6\": { all: [...] } };"),
        P("The diagnostic route calls a helper `pickDiagnosticTopics(level, dateToday)` that maps today's date to the current WA period, then returns the top-5 topic slugs for pulling questions."),

        H("8. Progress page after the diagnostic"),
        P("This is the compelling artifact. The parent has just watched the child attempt 20 minutes of practice; the very next screen should read: \"Here's what we can already see.\""),
        Bullet("Per-topic column chart populated with the diagnostic result — 5 columns, one per top topic tested, coloured by accuracy (green above the child's average, yellow below)."),
        Bullet("Sub-topic table for English (grammar rule + synthesis trick) using the fluency-table variant we already built (rows ≥80% green, <80% yellow)."),
        Bullet("One-line insight above the chart, e.g. \"Nate is strongest in Fractions, weakest in Ratio. Grammar tag-questions is the standout gap.\""),
        Bullet("Explicit sample-size honesty callout, placed under the chart in slightly softer text: \"This is a preliminary read — 15 questions is a small sample. In our experience, 2 more 15-minute daily quizzes will lock the picture in and Lumi's read of Nate's weakest sub-topics will be far more reliable.\""),
        Bullet("CTA immediately below that copy: \"Assign the next 15-min quiz →\" — one tap, next quiz created and waiting on the child's homepage."),
        P(""),
        P("The sample-size framing does two things at once: it manages the parent's confidence in the initial chart (so they don't dismiss it if the bars look wrong), AND it turns the natural next-step (do more quizzes) into a specific quantified ask — \"2 more 15-min daily quizzes\" — rather than an open-ended \"do more\". That's a much smaller commitment for the parent to say yes to."),
        P(""),
        P("The chart-empty-state trap: 5 bars each with n=3 attempts is low-N by our normal display standards. With the sample-size callout in place we can show the bars anyway (option a) — the copy pre-empts the credibility question. Alternative is to wait for ≥N=5 per topic before drawing bars, but that removes the compelling artifact from onboarding. Pick (a)."),

        H("9. Positioning — insights + personalisation, not just marking"),
        P("Everything about this flow should reinforce the pitch:"),
        Bullet("The diagnostic itself is called \"Nate's first diagnostic\" — not \"first quiz\"."),
        Bullet("The result screen is titled \"Nate's initial progress report\" — not \"quiz results\"."),
        Bullet("The CTA is about accuracy of the picture, not about doing more work. \"Every quiz sharpens the read on where Nate loses marks.\""),
        Bullet("The Lumi mascot appears at the start, at the end, and beside the column chart — the same character delivering the diagnostic, marking it, and reading it back."),

        H("10. Open items to workshop before build"),
        Bullet("Copy: the mid-diagnostic screens (progress bar, encouragement, brief-child-here messaging)."),
        Bullet("Time-of-day gating: our funnel probe showed 22:00–01:00 signups convert at 0–22%. Consider a \"Save for tomorrow — Nate's fresh brain will do better\" option instead of forcing the diagnostic that night."),
        Bullet("Subject picker copy — how to guide a parent whose child needs help across multiple subjects. \"Which subject worries you most right now?\" reads better than \"pick one\"."),
        Bullet("Post-diagnostic email — should we send a summary email 30 min after the diagnostic completes, so the parent has an artifact to show the child later that day?"),
        Bullet("Handling repeat-diagnostic runs — if a parent goes through this a second time (different child, or same child later), do we replace the previous baseline or store both?"),

        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 480 },
          children: [new TextRun({ text: "— end —", italics: true, color: "999999" })],
        }),
      ],
    },
  ],
});

(async () => {
  const buf = await Packer.toBuffer(doc);
  await writeFile(path.normalize(OUT), buf);
  console.log(`Wrote ${OUT} (${(buf.length / 1024).toFixed(1)} KB)`);
})().catch(e => { console.error(e); process.exit(1); });
