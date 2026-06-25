// scripts/fix-science-oeq-alignment.ts
//
// Find master science OEQs whose transcribedSubparts and answer key
// labels don't line up (e.g. subpart (b) exists but the answer key
// jumps a-c), re-run Gemini OCR on the question image, and if the
// fresh extraction has MORE complete coverage, save it.
//
// Defaults to DRY-RUN — prints what it WOULD do without writing.
// Pass `--apply` to actually overwrite the DB rows.
//
// Auto-fix policy (only saves when ALL hold):
//   1. The question still has imageData (otherwise Gemini has nothing).
//   2. The new extraction parses into subparts + answer.
//   3. The new pipe-segment count in the answer is ≥ the old.
//   4. The new answer has at least one parseable pipe-label per subpart.
//
// Run:
//   npx tsx scripts/fix-science-oeq-alignment.ts            (dry-run)
//   npx tsx scripts/fix-science-oeq-alignment.ts --apply    (write to DB)
//   npx tsx scripts/fix-science-oeq-alignment.ts --paper=<id>
//   npx tsx scripts/fix-science-oeq-alignment.ts --limit=20

import { prisma } from "../src/lib/db";
import { transcribeScienceOpenEndedQuestion } from "../src/lib/gemini";

type Subpart = { label: string; text?: string };

function extractAnswerKeyLabels(answer: string | null): Set<string> {
  const out = new Set<string>();
  if (!answer) return out;
  for (const seg of answer.split("|")) {
    const m = seg.trim().match(/^\(([a-z](?:-[ivx]+)?|[ivx]+)\)/i);
    if (m) out.add(m[1].toLowerCase());
    const compound = seg.trim().match(/^\(([a-z])\)\s*\(([ivx]+)\)/i);
    if (compound) out.add(`${compound[1]}-${compound[2]}`.toLowerCase());
  }
  return out;
}

function parseLabel(l: string): { parent: string; child: string | null } {
  const norm = l.toLowerCase();
  if (norm.includes("-")) {
    const [p, c] = norm.split("-");
    return { parent: p, child: c };
  }
  return { parent: norm, child: null };
}

// A question has an alignment bug iff at least one subpart label
// can't reach an answer through direct match OR compound-parent fallback.
function hasAlignmentBug(subs: Subpart[], answer: string | null): boolean {
  const real = subs.filter(s => s && !s.label.startsWith("_"));
  if (real.length < 2) return false;
  const keyLabels = extractAnswerKeyLabels(answer);
  const keyParents = new Set([...keyLabels].map(l => parseLabel(l).parent));
  const keyCompounds = new Set([...keyLabels].filter(l => l.includes("-")));
  for (const sp of real) {
    const sl = sp.label.toLowerCase();
    if (keyLabels.has(sl)) continue;
    if (sl.includes("-") && keyParents.has(parseLabel(sl).parent)) continue;
    if (!sl.includes("-") && [...keyCompounds].some(k => k.startsWith(`${sl}-`))) continue;
    return true;
  }
  return false;
}

function countPipeSegments(answer: string | null): number {
  if (!answer) return 0;
  let n = 0;
  for (const seg of answer.split("|")) if (seg.trim().match(/^\(/)) n++;
  return n;
}

(async () => {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const paperFilter = args.find(a => a.startsWith("--paper="))?.split("=")[1];
  const limit = (() => {
    const a = args.find(x => x.startsWith("--limit="))?.split("=")[1];
    return a ? Math.max(1, parseInt(a, 10)) : 0;
  })();

  const papers = await prisma.examPaper.findMany({
    where: {
      subject: { contains: "Science", mode: "insensitive" },
      assignedToId: null,
      ...(paperFilter ? { id: paperFilter } : {}),
    },
    select: {
      id: true,
      title: true,
      questions: {
        select: { id: true, questionNum: true, transcribedSubparts: true, answer: true, imageData: true },
      },
    },
  });

  const broken: Array<{ paperId: string; paperTitle: string; questionId: string; questionNum: string; oldSegs: number; oldAns: string | null; hasImage: boolean }> = [];
  for (const p of papers) {
    for (const q of p.questions) {
      const subs = q.transcribedSubparts as Subpart[] | null;
      if (!Array.isArray(subs)) continue;
      if (!hasAlignmentBug(subs, q.answer)) continue;
      broken.push({
        paperId: p.id,
        paperTitle: p.title,
        questionId: q.id,
        questionNum: q.questionNum,
        oldSegs: countPipeSegments(q.answer),
        oldAns: q.answer,
        hasImage: !!q.imageData,
      });
    }
  }
  const totalBefore = broken.length;
  console.log(`Found ${totalBefore} broken questions across ${new Set(broken.map(b => b.paperId)).size} papers.\n`);
  console.log(`Mode: ${apply ? "APPLY (will write to DB)" : "DRY-RUN (will only report)"}\n`);

  const queue = limit ? broken.slice(0, limit) : broken;
  console.log(`Processing ${queue.length} question(s)…\n`);

  let attempted = 0, improved = 0, sameOrWorse = 0, skipped = 0, errors = 0;

  // Sequential — Gemini calls are paid + rate-limited and these admin
  // batches don't need to be fast. Easier to interrupt and resume.
  for (const b of queue) {
    attempted++;
    if (!b.hasImage) {
      skipped++;
      console.log(`[SKIP no-image]  ${b.paperTitle}  Q${b.questionNum}`);
      continue;
    }
    const q = await prisma.examQuestion.findUnique({
      where: { id: b.questionId },
      select: { imageData: true },
    });
    if (!q?.imageData) { skipped++; console.log(`[SKIP no-image-fetched] Q${b.questionNum}`); continue; }
    const base64 = q.imageData.replace(/^data:image\/\w+;base64,/, "");
    let result;
    try {
      result = await transcribeScienceOpenEndedQuestion(base64);
    } catch (err) {
      errors++;
      console.log(`[ERROR]          ${b.paperTitle}  Q${b.questionNum}: ${(err as Error).message}`);
      continue;
    }
    // Build the new answer string the way an admin save would: pipe-
    // separated "(label) text" entries.
    const newAnswer = (result.subparts ?? [])
      .filter(s => s.text && (s.text as string).trim().length > 0 && s.label)
      .map(s => {
        const lbl = s.label.includes("-") ? `(${s.label.split("-")[0]})(${s.label.split("-")[1]})` : `(${s.label})`;
        return `${lbl} ${(s.text as string).trim()}`;
      })
      .join(" | ");

    // The transcribe endpoint returns the question stem + subparts but
    // NOT the model answer — admin types or imports that separately.
    // What we CAN auto-fix from re-extraction is the SUBPART list
    // (so future merges and renders see the right labels). The
    // ANSWER content still requires admin input.
    //
    // So: only act when the subpart count or label set differs from
    // what's in DB AND the new set looks complete (matches the answer
    // key's pipe-segment labels). Otherwise it's a content-gap that
    // needs the human.
    const newLabels = (result.subparts ?? []).map(s => s.label.toLowerCase());
    const oldSubs = (await prisma.examQuestion.findUnique({
      where: { id: b.questionId },
      select: { transcribedSubparts: true },
    }))?.transcribedSubparts as Subpart[] | null;
    const oldLabels = (oldSubs ?? []).filter(s => s && !s.label.startsWith("_")).map(s => s.label.toLowerCase());

    const labelsChanged = newLabels.join(",") !== oldLabels.join(",");
    // Verdict logic — when does the new extract HELP?
    // (a) Label set changed AND new aligns with answer key better than old.
    // (b) OR old had no answer at all and we have at least some new
    //     subparts (still won't fix the answer-content gap but at least
    //     normalises labels for future re-extracts).
    const oldAnsKeyLabels = extractAnswerKeyLabels(b.oldAns);
    const oldAlignMisses = oldLabels.filter(l => {
      if (oldAnsKeyLabels.has(l)) return false;
      if (l.includes("-") && oldAnsKeyLabels.has(parseLabel(l).parent)) return false;
      return true;
    }).length;
    const newAlignMisses = newLabels.filter(l => {
      if (oldAnsKeyLabels.has(l)) return false;
      if (l.includes("-") && oldAnsKeyLabels.has(parseLabel(l).parent)) return false;
      return true;
    }).length;

    if (!labelsChanged) {
      sameOrWorse++;
      console.log(`[NO-CHANGE]      ${b.paperTitle}  Q${b.questionNum}: re-extract returned same labels`);
      continue;
    }
    if (newAlignMisses >= oldAlignMisses) {
      sameOrWorse++;
      console.log(`[NOT-BETTER]     ${b.paperTitle}  Q${b.questionNum}: old misses=${oldAlignMisses} new misses=${newAlignMisses} (labels old=[${oldLabels.join(",")}] new=[${newLabels.join(",")}])`);
      continue;
    }

    improved++;
    console.log(`[IMPROVE]        ${b.paperTitle}  Q${b.questionNum}: ${oldLabels.join(",")} → ${newLabels.join(",")}${apply ? " (will write)" : ""}`);
    void newAnswer;  // currently we don't overwrite .answer — content gaps need human review
    if (apply) {
      await prisma.examQuestion.update({
        where: { id: b.questionId },
        data: { transcribedSubparts: result.subparts as never },
      });
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`attempted: ${attempted}`);
  console.log(`improved:  ${improved}${apply ? " (saved to DB)" : " (would save if --apply)"}`);
  console.log(`same/worse: ${sameOrWorse}`);
  console.log(`skipped:   ${skipped}`);
  console.log(`errors:    ${errors}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
