import { prisma } from "../src/lib/db";

async function main() {
  const id = "cmps3x4mt004l2nr7opoak80p";
  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { id: true, metadata: true, sourceExamId: true, paperType: true },
  });
  console.log("paper.metadata keys:", Object.keys((paper?.metadata as object | null) ?? {}));
  const meta = paper?.metadata as { englishSections?: Array<{ label: string; startIndex: number; endIndex: number }>; chineseSections?: unknown } | null;
  if (meta?.englishSections) {
    console.log("englishSections:");
    for (const s of meta.englishSections) console.log(`  [${s.startIndex}..${s.endIndex}] "${s.label}"`);
  } else {
    console.log("NO englishSections in this paper's metadata");
  }
  if (paper?.sourceExamId) {
    const master = await prisma.examPaper.findUnique({
      where: { id: paper.sourceExamId },
      select: { id: true, title: true, metadata: true },
    });
    console.log("---");
    console.log("MASTER:", master?.id, master?.title);
    const mmeta = master?.metadata as { englishSections?: Array<{ label: string; startIndex: number; endIndex: number }> } | null;
    if (mmeta?.englishSections) {
      console.log("master.englishSections:");
      for (const s of mmeta.englishSections) console.log(`  [${s.startIndex}..${s.endIndex}] "${s.label}"`);
    } else {
      console.log("NO englishSections in MASTER metadata");
    }
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
