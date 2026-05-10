// Count remaining OEQ-subpart gaps in master papers, broken down
// by subject + gap type. Mirrors the filter in
// /api/admin/answer-key-gaps so the result tells you exactly how
// many rows would still surface in the admin tool.
//
// Usage: npx tsx scripts/count-oeq-gaps.ts

import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

type Sub = { label: string; text: string };

function realSubs(j: unknown): Sub[] {
  if (!Array.isArray(j)) return [];
  return (j as Sub[]).filter((s) => s && typeof s.label === "string" && !s.label.startsWith("_") && typeof s.text === "string");
}

function hasMarksGap(subs: Sub[]): boolean {
  if (subs.length < 2) return false;
  return subs.some((s) => !/\[\s*\d+\s*(?:m(?:ark)?s?)?\s*\]/i.test(s.text));
}

function hasAnswerGap(answer: string | null, subs: Sub[]): boolean {
  if (subs.length < 2) return false;
  const ans = (answer ?? "").toLowerCase();
  return subs.some((s) => !ans.includes(`(${s.label.toLowerCase()})`));
}

async function main() {
  const all = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null,
        paperType: null,
        visible: true,
        NOT: [{ examType: "Synthetic" }, { title: { startsWith: "[Synthetic Bank]" } }],
      },
      transcribedSubparts: { not: Prisma.AnyNull },
      transcribedStem: { not: null },
    },
    select: {
      id: true,
      transcribedSubparts: true,
      answer: true,
      examPaper: { select: { subject: true } },
    },
  });

  type Counts = { total: number; marksGap: number; answerGap: number; both: number };
  const bySubject: Record<string, Counts> = {};
  const bump = (key: string) => (bySubject[key] ??= { total: 0, marksGap: 0, answerGap: 0, both: 0 });

  for (const q of all) {
    const subs = realSubs(q.transcribedSubparts);
    if (subs.length < 2) continue;
    const subj = (q.examPaper.subject ?? "").toLowerCase();
    const key = subj.includes("math") ? "math"
      : subj.includes("science") ? "science"
      : subj.includes("english") ? "english"
      : "other";
    const c = bump(key);
    const mg = hasMarksGap(subs);
    const ag = hasAnswerGap(q.answer, subs);
    c.total++;
    if (mg && !ag) c.marksGap++;
    else if (!mg && ag) c.answerGap++;
    else if (mg && ag) c.both++;
  }

  console.log("");
  console.log("=== Master OEQ-subpart gap counts ===");
  console.log("");
  for (const [subj, c] of Object.entries(bySubject)) {
    const open = c.marksGap + c.answerGap + c.both;
    const closed = c.total - open;
    console.log(`${subj.padEnd(10)}  total ${c.total}  closed ${closed}  open ${open}`);
    console.log(`              marks-gap only:  ${c.marksGap}`);
    console.log(`              answer-gap only: ${c.answerGap}`);
    console.log(`              both:            ${c.both}`);
    console.log("");
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
