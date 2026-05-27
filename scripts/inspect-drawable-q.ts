import { prisma } from "../src/lib/db";
import { promises as fs } from "fs";
import path from "path";

const PAPER_ID = process.argv[2];
const Q_NUM = process.argv[3] ?? "39";

async function main() {
  if (!PAPER_ID) { console.error("usage: inspect-drawable-q <paperId> [qNum]"); process.exit(1); }
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID }, select: { id: true, title: true, sourceExamId: true },
  });
  if (!paper) { console.error("Paper not found"); process.exit(1); }
  console.log(`Paper: ${paper.title}  sourceExamId=${paper.sourceExamId}`);

  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: PAPER_ID, questionNum: Q_NUM },
    select: {
      id: true, questionNum: true, transcribedSubparts: true,
      diagramImageData: true,
    },
  });
  if (!q) { console.error("Question not found"); process.exit(1); }
  console.log(`\nQ${q.questionNum}`);
  console.log(`  diagramImageData length: ${q.diagramImageData?.length ?? 0}`);
  const subs = (q.transcribedSubparts as Array<{ label: string; diagramBase64?: string }> | null) ?? [];
  for (const sp of subs) {
    console.log(`  subpart ${sp.label} — diagramBase64 length: ${sp.diagramBase64?.length ?? 0}`);
  }

  // Check the SUBMISSION dir for canvas files
  const VOL = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
  const dir = path.join(VOL, "submissions", PAPER_ID);
  try {
    const files = await fs.readdir(dir);
    const matchPattern = new RegExp(`page_\\d+_(?:${Q_NUM}|q${Q_NUM})`, "i");
    const relevant = files.filter(f => matchPattern.test(f) || f.match(new RegExp(`page_\\d+`)));
    console.log(`\nSubmission files in ${dir}:`);
    for (const f of relevant.slice(0, 20)) {
      const s = await fs.stat(path.join(dir, f));
      console.log(`  ${f}  ${(s.size / 1024).toFixed(1)} KB`);
    }
  } catch (e) {
    console.log(`\nSubmission dir not accessible locally (${(e as Error).message.slice(0, 60)}).`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
