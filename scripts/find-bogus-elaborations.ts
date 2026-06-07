// Find questions whose cached elaboration is the deterministic
// "Step 1: identify key values, Step 2: equation, Step 3: match"
// template. This template was emitted by Gemini when it had no
// question-text context (image-only prompt path) and was cached
// on master questions, polluting every clone that shared it.

import { prisma } from "../src/lib/db";

async function main() {
  // Bogus pattern: contains all 3 deterministic phrases that signal
  // a no-context hallucination. The real elaborations talk about
  // the actual question content.
  const candidates = await prisma.examQuestion.findMany({
    where: {
      elaboration: { not: null },
      AND: [
        { elaboration: { contains: "Read the question carefully to identify" } },
        { elaboration: { contains: "equation" } },
        { elaboration: { contains: "Match your final calculated result" } },
      ],
    },
    select: {
      id: true,
      questionNum: true,
      syllabusTopic: true,
      transcribedStem: true,
      sourceQuestionId: true,
      examPaper: { select: { id: true, title: true, paperType: true, subject: true } },
    },
    take: 200,
  });

  console.log(`Found ${candidates.length} questions with bogus templated elaboration\n`);

  // Group by paperType / subject so we see the scope.
  const bySubject = new Map<string, number>();
  const masters: typeof candidates = [];
  const clones: typeof candidates = [];
  for (const c of candidates) {
    const subj = c.examPaper?.subject ?? "?";
    bySubject.set(subj, (bySubject.get(subj) ?? 0) + 1);
    if (c.sourceQuestionId) clones.push(c);
    else masters.push(c);
  }
  console.log("By subject:");
  for (const [s, n] of [...bySubject.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s}: ${n}`);
  }
  console.log(`Masters (no sourceQuestionId): ${masters.length}`);
  console.log(`Clones (has sourceQuestionId): ${clones.length}`);

  console.log("\nSample 10 masters:");
  for (const m of masters.slice(0, 10)) {
    const stem = (m.transcribedStem ?? "").slice(0, 80);
    console.log(`  ${m.id} | ${m.examPaper?.subject ?? "?"} | ${m.syllabusTopic ?? "-"} | Q${m.questionNum} | ${stem}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
