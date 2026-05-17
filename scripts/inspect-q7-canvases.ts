import { prisma } from "../src/lib/db";
import { promises as fs } from "fs";
import path from "path";

(async () => {
  const ID = "cmosfj32p000f6r3v91udj8n6";
  const QID = "cmosfj32s000m6r3v1btt5uey";
  const p = await prisma.examPaper.findUnique({
    where: { id: ID },
    select: { metadata: true },
  });
  const meta = p?.metadata as Record<string, unknown> | null;
  const oeqPageMap = meta?.oeqPageMap as Record<string, number> | undefined;
  const canvasHeights = meta?.canvasHeights as Record<string, number> | undefined;
  const oeqIdx = oeqPageMap?.[QID];
  console.log(`Q7 (id=${QID})  oeqIdx=${oeqIdx}`);
  console.log(`canvas heights for this question:`);
  for (const [k, v] of Object.entries(canvasHeights ?? {})) {
    if (k.startsWith(QID)) console.log(`  ${k} = ${v}`);
  }

  // Check submission files
  const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
  const subDir = path.join(VOLUME_PATH, "submissions", ID);
  console.log(`\nSubmission dir: ${subDir}`);
  try {
    const files = await fs.readdir(subDir);
    const relevant = files.filter(f => f.startsWith(`page_${oeqIdx}`));
    console.log(`Files for Q7 oeqIdx=${oeqIdx}:`);
    for (const f of relevant) {
      const stat = await fs.stat(path.join(subDir, f));
      console.log(`  ${f}  size=${stat.size}B`);
    }
  } catch (err) {
    console.log("no local submissions dir (production railway volume probably)");
  }
  await prisma.$disconnect();
})();
