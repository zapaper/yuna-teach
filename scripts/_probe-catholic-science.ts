// Catholic High Science Prelim — see exactly what shape each MCQ is
// stored in. The previous scan counted "options array present" as MCQ,
// but the user's complaint may be that table/image MCQs were stored with
// PLACEHOLDER text options instead of optionTable/optionImages.

import { prisma } from "../src/lib/db";

async function main() {
  const paper = await prisma.examPaper.findFirst({
    where: { title: { contains: "CATHOLIC", mode: "insensitive" }, subject: { contains: "Science", mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, createdAt: true },
  });
  if (!paper) { console.log("paper not found"); return; }
  console.log(`paper: ${paper.title} (${paper.id})\n`);

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: paper.id },
    orderBy: { orderIndex: "asc" },
    select: {
      id: true, questionNum: true, answer: true,
      transcribedOptions: true, transcribedOptionImages: true,
      transcribedOptionTable: true, transcribedSubparts: true,
      transcribedStem: true,
    },
  });

  console.log(`Q   ans  stored-shape          stem-preview / options-preview`);
  console.log(`-`.repeat(110));
  for (const q of qs.slice(0, 28)) {
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
    if (optTable) {
      preview = `cols=[${optTable.columns.join("|")}] rows=${optTable.rows.length}`;
    } else if (opts && opts.length > 0) {
      preview = opts.map(o => o.slice(0, 18)).join(" / ");
    } else if (subs && subs.length > 0) {
      preview = subs.map(s => `(${s.label})${s.text?.slice(0, 30) ?? ""}`).join(" | ");
    } else {
      preview = (q.transcribedStem ?? "").slice(0, 50);
    }
    console.log(`Q${q.questionNum.padEnd(3)} ${(q.answer ?? "null").padEnd(4)} ${shape.padEnd(20)} ${preview.slice(0, 80)}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
