import { prisma } from "../src/lib/db";
import { promises as fs } from "fs";
import path from "path";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");

async function main() {
  const id = "cmphn6npc000112g1sdstau5j";
  const p = await prisma.examPaper.findUnique({
    where: { id },
    select: {
      id: true, title: true, paperType: true, subject: true,
      pdfPath: true, pageCount: true, metadata: true,
      createdAt: true, updatedAt: true,
      _count: { select: { questions: true, clones: true } },
    },
  });
  console.log("Master paper:", JSON.stringify(p, null, 2).slice(0, 2500));
  // Check disk for any PDFs related to this id
  const pagesDir = path.join(VOLUME_PATH, "pages", id);
  try {
    const files = await fs.readdir(pagesDir);
    console.log(`\nFiles under /pages/${id}: ${files.length} entries`);
    console.log(`  ${files.slice(0, 10).join(", ")}${files.length > 10 ? "…" : ""}`);
  } catch (e) {
    console.log(`No /pages/${id} dir on disk: ${(e as Error).message}`);
  }
  // Common upload directory check
  for (const guess of ["uploads", "papers", "pdfs", "exam-pdfs"]) {
    try {
      const root = path.join(VOLUME_PATH, guess);
      const files = await fs.readdir(root);
      const matching = files.filter(f => f.includes(id) || f.toLowerCase().includes("psle") && f.toLowerCase().includes("chin"));
      if (matching.length > 0) console.log(`Matching in /${guess}: ${matching.join(", ")}`);
    } catch { /* ignore */ }
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
