// Dump the marker output for the 4 questions gpt-5 missed in the eval.

import { prisma } from "../src/lib/db";

const FAILS: { prefix: string; label: string; qNum: string; expected: number; got: number }[] = [
  { prefix: "cmpuipgpi", label: "P4 Cycles in matter", qNum: "6", expected: 2, got: 1 },
  // p4 geo / interactions / p6 geo prefixes filled in after probes finish
];

async function dumpForPrefix(prefix: string, label: string, qNum: string, expected: number, got: number) {
  const p = await prisma.examPaper.findFirst({ where: { id: { startsWith: prefix } }, select: { id: true, title: true } });
  if (!p) { console.log(`(${label} — clone ${prefix} not found)`); return; }
  console.log(`\n============================================================`);
  console.log(`${label}  (clone ${p.id.slice(0, 12)}…)`);
  console.log(`============================================================`);
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: p.id, questionNum: qNum },
    select: {
      questionNum: true, marksAvailable: true, marksAwarded: true,
      markingNotes: true, studentAnswer: true, answer: true, transcribedStem: true,
    },
  });
  for (const q of qs) {
    console.log(`\n--- Q${q.questionNum}  ${q.marksAwarded}/${q.marksAvailable}m  (expected ${expected}, got ${got}, Δ${got - expected >= 0 ? "+" : ""}${got - expected})`);
    console.log(`STEM: ${(q.transcribedStem ?? "(null)").slice(0, 250)}`);
    console.log(`\nEXPECTED ANSWER:`);
    console.log(q.answer ?? "(null)");
    console.log(`\nSTUDENT ANSWER (detected):`);
    console.log(q.studentAnswer ?? "(null)");
    console.log(`\nMARKER NOTES:`);
    console.log(q.markingNotes ?? "(null)");
  }
}

async function main() {
  // Accept prefixes as args so we can rerun once all probes are done.
  const args = process.argv.slice(2);
  const items = args.length > 0
    ? args.map((arg) => {
        const [prefix, qNum, label] = arg.split(":");
        const item = FAILS.find(f => f.qNum === qNum);
        return { prefix, label: label ?? "?", qNum, expected: item?.expected ?? 0, got: item?.got ?? 0 };
      })
    : FAILS;
  for (const it of items) await dumpForPrefix(it.prefix, it.label, it.qNum, it.expected, it.got);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
