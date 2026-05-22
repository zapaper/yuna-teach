// Read chinese-mcq-drafts.md, find drafts marked KEEP, import them as
// real ExamQuestion records in the Chinese synthetic bank paper.
//
// Usage:
//   npx tsx -r dotenv/config scripts/promote-chinese-mcq-drafts.ts
//
// How verdict marking works (in chinese-mcq-drafts.md):
//   - Each draft has a line: "**Verdict:** ☐ KEEP   ☐ DROP"
//   - User marks one of the boxes (e.g. "☑ KEEP" or "[x] KEEP" or "KEEP")
//   - This script reads the .md, pairs each verdict line back to the
//     matching draft in the .json, and imports KEEP drafts.
//
// Markers accepted (case-insensitive, anywhere on the Verdict line):
//   ☑ KEEP, [x] KEEP, [X] KEEP, X KEEP, "→ KEEP", just "KEEP" if no DROP follows
//   ☑ DROP, [x] DROP, [X] DROP, X DROP, just "DROP"
// Unmarked drafts default to SKIP (neither imported nor flagged).

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/db";

const DRAFTS_JSON = path.join(__dirname, "chinese-mcq-drafts.json");
const DRAFTS_MD = path.join(__dirname, "chinese-mcq-drafts.md");

type Draft = {
  seedWord: string;
  seedMeaning: string;
  shape: "Q5-Q6" | "Q7-Q8" | "Q9-Q10";
  stem: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
  syllabusTopic: string;
  subTopic: string;
  priority: number;
};

async function getOrCreateBankPaper(adminUserId: string): Promise<string> {
  const title = "[Synthetic Bank] Chinese Primary 6";
  const existing = await prisma.examPaper.findFirst({
    where: { title, paperType: null, sourceExamId: null },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.examPaper.create({
    data: {
      title, subject: "Chinese", level: "Primary 6", userId: adminUserId,
      pageCount: 0, paperType: null, sourceExamId: null,
      extractionStatus: "ready", visible: true, examType: "Synthetic",
    },
    select: { id: true },
  });
  return created.id;
}

// Parse the markdown into per-draft verdict records.
//
// Verdict line in the .md is "**Verdict:** ☐ KEEP   ☐ DROP" by default.
// To MARK KEEP: replace the ☐ before KEEP with X / ✓ / ☑ — anything not ☐.
// To MARK DROP: same idea, before DROP.
// To MARK plainly: replace whole verdict text with just "KEEP" or "DROP".
function classifyVerdict(line: string): "KEEP" | "DROP" | "SKIP" {
  const body = line.replace(/^\*\*Verdict:\*\*\s*/, "").trim();

  // Plain-text shortcut: just "KEEP" or "DROP" with nothing else
  if (/^KEEP\s*$/i.test(body)) return "KEEP";
  if (/^DROP\s*$/i.test(body)) return "DROP";

  // Checkbox-marker form. Look for the character immediately before
  // "KEEP" vs "DROP". Filled markers: X x ✓ ✔ ☑ ☒.
  // Default empty marker: ☐ (or nothing).
  const FILLED_RX = /[Xx✓✔☑☒]/;
  const keepIdx = body.toUpperCase().indexOf("KEEP");
  const dropIdx = body.toUpperCase().indexOf("DROP");
  // Look 4 chars before each word for a filled marker.
  const beforeKeep = keepIdx > 0 ? body.slice(Math.max(0, keepIdx - 4), keepIdx) : "";
  const beforeDrop = dropIdx > 0 ? body.slice(Math.max(0, dropIdx - 4), dropIdx) : "";
  const keepChosen = FILLED_RX.test(beforeKeep);
  const dropChosen = FILLED_RX.test(beforeDrop);
  if (keepChosen && !dropChosen) return "KEEP";
  if (dropChosen && !keepChosen) return "DROP";
  return "SKIP";
}

function parseVerdicts(md: string): Array<{ shape: string; seedWord: string; verdict: "KEEP" | "DROP" | "SKIP" }> {
  const lines = md.split("\n");
  const out: Array<{ shape: string; seedWord: string; verdict: "KEEP" | "DROP" | "SKIP" }> = [];
  let currentSeed: string | null = null;
  let currentShape: string | null = null;
  for (const line of lines) {
    const h = line.match(/^### \[([^\]]+)\]\s+.*\*\*([^*]+)\*\*/);
    if (h) {
      currentShape = h[1].replace(/-\d+$/, "");
      currentSeed = h[2];
      continue;
    }
    if (line.startsWith("**Verdict:**") && currentSeed && currentShape) {
      out.push({ shape: currentShape, seedWord: currentSeed, verdict: classifyVerdict(line) });
      currentSeed = null;
      currentShape = null;
    }
  }
  return out;
}

(async () => {
  if (!fs.existsSync(DRAFTS_JSON) || !fs.existsSync(DRAFTS_MD)) {
    console.error(`Drafts not found. Run generate-chinese-mcq-drafts.ts first.`);
    process.exit(1);
  }
  const drafts = JSON.parse(fs.readFileSync(DRAFTS_JSON, "utf8")) as Draft[];
  const md = fs.readFileSync(DRAFTS_MD, "utf8");

  const verdicts = parseVerdicts(md);
  console.log(`Parsed ${verdicts.length} verdict lines from .md`);

  // Build a verdict lookup. Use seedWord + shape as the key. If the
  // same seed appears twice in the same shape, both will be flagged
  // the same way (.md doesn't disambiguate beyond the heading number).
  const verdictMap = new Map<string, "KEEP" | "DROP" | "SKIP">();
  for (const v of verdicts) {
    const key = `${v.shape}|${v.seedWord}`;
    verdictMap.set(key, v.verdict);
  }

  const toImport = drafts.filter(d => verdictMap.get(`${d.shape}|${d.seedWord}`) === "KEEP");
  const dropped = drafts.filter(d => verdictMap.get(`${d.shape}|${d.seedWord}`) === "DROP");
  const skipped = drafts.length - toImport.length - dropped.length;
  console.log(`To import (KEEP):  ${toImport.length}`);
  console.log(`Dropped:           ${dropped.length}`);
  console.log(`Unmarked (SKIP):   ${skipped}`);

  if (toImport.length === 0) {
    console.log(`\nNo KEEPs to import. Edit ${DRAFTS_MD} first.`);
    return;
  }

  // Find an admin user to own the synthetic bank paper.
  const admin = await prisma.user.findFirst({
    where: {
      OR: [
        { name: { equals: "admin", mode: "insensitive" } },
        { settings: { path: ["admin"], equals: true } as never },
      ],
    },
    select: { id: true, name: true },
  });
  if (!admin) {
    console.error(`No admin user found in DB. Pass userId manually or seed an admin first.`);
    process.exit(1);
  }
  console.log(`Using admin user: ${admin.name} (${admin.id})`);

  const bankPaperId = await getOrCreateBankPaper(admin.id);
  console.log(`Bank paper: ${bankPaperId}`);

  const existingCount = await prisma.examQuestion.count({ where: { examPaperId: bankPaperId } });
  let nextOrder = existingCount;
  console.log(`Existing questions in bank: ${existingCount}`);

  let imported = 0;
  for (const d of toImport) {
    nextOrder += 1;
    await prisma.examQuestion.create({
      data: {
        questionNum: `S${nextOrder}`,
        imageData: "",
        answer: `(${d.correctAnswer})`,
        pageIndex: 0,
        orderIndex: nextOrder,
        marksAvailable: 2,
        examPaperId: bankPaperId,
        syllabusTopic: d.syllabusTopic,
        subTopic: d.subTopic,
        transcribedStem: d.stem,
        transcribedOptions: d.options,
        elaboration: d.explanation,
      },
    });
    imported++;
  }

  console.log(`\nImported ${imported} drafts into synthetic bank paper ${bankPaperId}.`);
  await prisma.$disconnect();
})();
