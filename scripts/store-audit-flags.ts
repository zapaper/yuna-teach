// Reads audit-results JSON and stores non-false-positive flags into
// paper.metadata.auditFlags so the admin vet-qa page can display them.
// Run:  npx tsx scripts/store-audit-flags.ts

import { prisma } from "@/lib/db";
import * as fs from "fs";

const SKIP_PATTERNS = [
  "missing", "not provided", "not present in the", "cannot be audited",
  "incomplete", "preventing verification", "image is missing",
  "figure is missing", "diagram is missing", "table is missing",
  "graph is missing", "options are missing", "flowchart is missing",
  "cannot be verified", "is not provided",
];

async function main() {
  const resultsFile = process.argv[2] || "scripts/audit-results-2026-04-16T06-45-42.json";
  const data = JSON.parse(fs.readFileSync(resultsFile, "utf8"));

  // Collect actionable flags grouped by question ID
  const flags: Map<string, string> = new Map();
  for (const subj of ["math", "science", "english"]) {
    for (const it of data[subj] ?? []) {
      const r = it.reason.toLowerCase();
      if (SKIP_PATTERNS.some(p => r.includes(p))) continue;
      flags.set(it.id, it.reason);
    }
  }
  console.log(`${flags.size} actionable flags to store`);

  // Find which papers these questions belong to
  const qIds = [...flags.keys()];
  const questions = await prisma.examQuestion.findMany({
    where: { id: { in: qIds } },
    select: { id: true, examPaperId: true },
  });

  // Group by paper
  const byPaper = new Map<string, Map<string, string>>();
  for (const q of questions) {
    const reason = flags.get(q.id);
    if (!reason) continue;
    if (!byPaper.has(q.examPaperId)) byPaper.set(q.examPaperId, new Map());
    byPaper.get(q.examPaperId)!.set(q.id, reason);
  }

  // Update each paper's metadata.auditFlags
  let updated = 0;
  for (const [paperId, qFlags] of byPaper) {
    const paper = await prisma.examPaper.findUnique({
      where: { id: paperId },
      select: { metadata: true },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (paper?.metadata ?? {}) as any;
    meta.auditFlags = Object.fromEntries(qFlags);
    await prisma.examPaper.update({
      where: { id: paperId },
      data: { metadata: meta },
    });
    updated++;
  }
  console.log(`Updated ${updated} papers with audit flags`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
