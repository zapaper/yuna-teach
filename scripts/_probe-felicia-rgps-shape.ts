import "dotenv/config";
import { prisma } from "../src/lib/db";
import { promises as fs } from "fs";
import path from "path";
(async () => {
  const paperId = "cmqxxlr590001kyi8tze0dzes";
  const paper = await prisma.examPaper.findUnique({
    where: { id: paperId },
    select: {
      id: true, title: true, subject: true, level: true,
      paperType: true, sourceExamId: true, markingStatus: true, extractionStatus: true,
      createdAt: true, completedAt: true, assignedToId: true,
      pageCount: true,
      metadata: true,
    },
  });
  console.log(JSON.stringify(paper, null, 2));

  // Compare to the older version with the same title
  const older = await prisma.examPaper.findFirst({
    where: { assignedToId: paper?.assignedToId ?? undefined, title: paper?.title, id: { not: paperId } },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, paperType: true, sourceExamId: true, markingStatus: true, extractionStatus: true, createdAt: true, completedAt: true, pageCount: true },
  });
  console.log("\nOlder same-title version:");
  console.log(JSON.stringify(older, null, 2));

  // Check for submissions/<id>/ folder existence
  const volumePath = process.env.VOLUME_PATH ?? ".data";
  const submissionsDir = path.join(volumePath, "submissions", paperId);
  try {
    const files = await fs.readdir(submissionsDir);
    console.log(`\nSubmission files at ${submissionsDir}: ${files.length}`);
    for (const f of files.slice(0, 6)) console.log(`  ${f}`);
  } catch (e) {
    console.log(`\nSubmission dir NOT found at ${submissionsDir} (${(e as Error).message.slice(0, 100)})`);
  }
  await prisma.$disconnect();
})();
