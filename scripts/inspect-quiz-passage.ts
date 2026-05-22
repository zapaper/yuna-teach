import { prisma } from "../src/lib/db";

(async () => {
  const paperId = "cmph0khbd005ty1tynu1nqf7i";
  const paper = await prisma.examPaper.findUnique({
    where: { id: paperId },
    select: { id: true, title: true, metadata: true, questions: { select: { questionNum: true, transcribedStem: true, syllabusTopic: true, orderIndex: true }, orderBy: { orderIndex: "asc" } } },
  });
  if (!paper) { console.log("Not found"); return; }
  console.log("Paper:", paper.title);
  const meta = paper.metadata as Record<string, unknown>;
  const sections = (meta.chineseSections as Array<{ label: string; passage?: string; startIndex: number; endIndex: number }>) ?? [];
  console.log("Sections:", sections.map(s => `${s.label}[${s.startIndex}-${s.endIndex}]`));
  for (const s of sections) {
    if (!s.label.includes("完成对话")) continue;
    console.log("\n=== Section:", s.label, "===");
    const passage = s.passage ?? "";
    console.log("PASSAGE length:", passage.length);
    console.log("PASSAGE first 500:");
    console.log(passage.slice(0, 500));
    console.log("\n\n--- Locations of '**(' in passage ---");
    let idx = 0;
    while ((idx = passage.indexOf("**(", idx)) !== -1) {
      console.log(`@${idx}:`, JSON.stringify(passage.slice(idx, idx + 80)));
      idx += 3;
    }
  }
  const cloze = paper.questions.filter(q => q.syllabusTopic?.includes("完成对话"));
  console.log("\n\n=== 完成对话 question stems (first 3) ===");
  for (const q of cloze.slice(0, 3)) {
    console.log(`\nQ${q.questionNum}: stem =`, JSON.stringify(q.transcribedStem));
  }
  await prisma.$disconnect();
})();
