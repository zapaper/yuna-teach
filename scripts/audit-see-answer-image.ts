// Pulls every question whose stored answer is just "see answer image"
// (or close variants) and writes a markdown report you can edit in
// place to supplement the answer key with a description.
//
// Usage:
//   npx tsx scripts/audit-see-answer-image.ts
//
// Output:
//   eval/see-answer-image-audit.md
//
// Each row gives you a direct link to the question's edit URL so you
// can open it, look at the answer image, and type in the missing
// description. Grouped by paper so you can sweep one paper at a time.

import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Same regex the marker uses (lib/marking.ts) so the report covers
// exactly the cases that produce poor marking.
const SEE_IMAGE_RE = /^\s*(?:see|refer to)\s+(?:answer\s+)?(?:image|diagram|figure|drawing|picture)\b.*$/i;
// Also catch the per-subpart variants like "(a) see answer image" or
// answers that ONLY contain a see-image clause across all subparts.
const HAS_SEE_IMAGE_INLINE = /\bsee\s+(?:answer\s+)?(?:image|diagram|figure|drawing|picture)\b/i;
const HAS_REFER_TO_IMAGE_INLINE = /\brefer\s+to\s+(?:answer\s+)?(?:image|diagram|figure|drawing|picture)\b/i;

const BASE = process.env.PROD_BASE ?? "https://www.markforyou.com";

const prisma = new PrismaClient();

async function main() {
  const masters = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      paperType: null,
    },
    select: {
      id: true,
      title: true,
      subject: true,
      year: true,
      questions: {
        select: {
          id: true,
          questionNum: true,
          answer: true,
          answerImageData: true,
          syllabusTopic: true,
          marksAvailable: true,
        },
        orderBy: { orderIndex: "asc" },
      },
    },
    orderBy: [{ subject: "asc" }, { title: "asc" }],
  });

  type Row = { qNum: string; topic: string | null; marks: number | null; answer: string; hasImage: boolean; editUrl: string };
  type Group = { id: string; title: string; subject: string | null; year: string | null; rows: Row[] };
  const groups: Group[] = [];
  for (const p of masters) {
    const rows: Row[] = [];
    for (const q of p.questions) {
      const ans = (q.answer ?? "").trim();
      if (!ans) continue;
      const exact = SEE_IMAGE_RE.test(ans);
      const inline = HAS_SEE_IMAGE_INLINE.test(ans) || HAS_REFER_TO_IMAGE_INLINE.test(ans);
      if (!exact && !inline) continue;
      rows.push({
        qNum: q.questionNum,
        topic: q.syllabusTopic,
        marks: q.marksAvailable,
        answer: ans.replace(/\s+/g, " ").slice(0, 220),
        hasImage: !!q.answerImageData,
        editUrl: `${BASE}/exam/${p.id}/edit`,
      });
    }
    if (rows.length > 0) {
      groups.push({ id: p.id, title: p.title, subject: p.subject, year: p.year, rows });
    }
  }

  const lines: string[] = [];
  lines.push("# Audit — questions whose answer is just \"see answer image\"");
  lines.push("");
  lines.push(`_Generated ${new Date().toISOString()} from ${masters.length} master papers._`);
  lines.push("");
  lines.push(`Found **${groups.reduce((s, g) => s + g.rows.length, 0)}** questions across **${groups.length}** papers that need a written description supplementing the answer image.`);
  lines.push("");
  lines.push("Per question: open the paper's `/edit` page, find the question, replace or supplement the answer text with the description the AI marker needs. Examples:");
  lines.push("");
  lines.push("- `see answer image` → `see answer image | Diagram: two parallel lines with arrows pointing right; bottom label 'F=20N'`");
  lines.push("- `(a) see answer image` → `(a) Triangle ABC with C at the apex; angle BAC = 30°`");
  lines.push("");

  for (const g of groups) {
    lines.push(`## ${g.title}${g.subject ? `  — _${g.subject}_` : ""}${g.year ? ` (${g.year})` : ""}`);
    lines.push("");
    lines.push(`Edit: <${g.editUrl}>`);
    lines.push("");
    lines.push("| Q | Topic | Marks | Has image? | Current answer |");
    lines.push("|---|---|---|---|---|");
    for (const r of g.rows) {
      const ans = r.answer.replace(/\|/g, "\\|");
      const topic = (r.topic ?? "").replace(/\|/g, "\\|");
      lines.push(`| ${r.qNum} | ${topic} | ${r.marks ?? "—"} | ${r.hasImage ? "✓" : "✗"} | ${ans} |`);
    }
    lines.push("");
  }

  const outDir = path.join(__dirname, "..", "eval");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "see-answer-image-audit.md");
  writeFileSync(outPath, lines.join("\n"), "utf-8");
  console.log(`Wrote ${outPath}`);
  console.log(`  ${groups.reduce((s, g) => s + g.rows.length, 0)} questions in ${groups.length} papers`);

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
