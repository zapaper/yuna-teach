import { prisma } from "../src/lib/db";

async function main() {
  const id = process.argv[2] ?? "cmptrqzjs00ebzgzxupuf0egs";
  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { id: true, title: true, subject: true, createdAt: true, updatedAt: true },
  });
  if (!paper) { console.log("not found"); return; }
  console.log(`paper: ${paper.title}`);
  console.log(`  created: ${paper.createdAt.toISOString()}  updated: ${paper.updatedAt.toISOString()}`);

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: id },
    orderBy: { orderIndex: "asc" },
    select: {
      questionNum: true, answer: true, marksAvailable: true,
      transcribedStem: true,
      transcribedOptions: true,
      transcribedOptionImages: true,
      transcribedOptionTable: true,
      transcribedSubparts: true,
    },
  });

  console.log(`\nQ   ans  marks  shape          stem-preview / preview`);
  console.log(`-`.repeat(110));
  for (const q of qs.slice(0, 30)) {
    const opts = q.transcribedOptions as string[] | null;
    const optImgs = q.transcribedOptionImages as (string | null)[] | null;
    const optTable = q.transcribedOptionTable as { columns: string[]; rows: string[][] } | null;
    const subs = q.transcribedSubparts as { label: string; text: string }[] | null;
    const shape = optTable ? "optionTable"
      : (optImgs && optImgs.some(x => x)) ? "optionImages"
      : (opts && opts.length > 0) ? "options(text)"
      : (subs && subs.length > 0) ? "OEQ-subparts"
      : "(empty)";
    let preview = "";
    if (optTable) preview = `cols=[${optTable.columns.join("|")}] rows=${optTable.rows.length}`;
    else if (opts && opts.length > 0) preview = opts.map(o => o.slice(0, 18)).join(" / ");
    else if (subs && subs.length > 0) preview = subs.map(s => `(${s.label})${s.text?.slice(0, 24) ?? ""}`).join(" | ");
    else preview = (q.transcribedStem ?? "").slice(0, 50);
    console.log(`Q${q.questionNum.padEnd(3)} ${(q.answer ?? "null").slice(0, 4).padEnd(5)} ${String(q.marksAvailable).padEnd(6)} ${shape.padEnd(14)} ${preview.slice(0, 70)}`);
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
