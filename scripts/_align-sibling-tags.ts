// Align syllabusTopic across multi-part question siblings (same
// examPaperId + baseNum) for the 9 confirmed-real cases identified
// in the scan. Skips the 3 baseNum collisions (Q11 P4, English
// QS125/QS126) where the rows aren't actually siblings.
import { prisma } from "../src/lib/db";

type Fix = { paperTitle: string; baseQ: string; target: string };

const FIXES: Fix[] = [
  // Clear mistags
  { paperTitle: "P6 Science WA2 Nanhua 2025", baseQ: "38", target: "Light energy and uses" },
  { paperTitle: "P3 Science WA2 Maha Bodhi 2025", baseQ: "12", target: "Interaction of forces (Magnets)" },
  { paperTitle: "PSLE Life Science OEQ 2022-2024", baseQ: "14", target: "Reproduction in plants and animals" },
  { paperTitle: "P6 Science WA2 Nanyang 2025", baseQ: "32", target: "Reproduction in plants and animals" },
  // Ambiguous fixes — user picked "apply my proposed tag" for all
  { paperTitle: "P5 Science WA2 Taonan 2023", baseQ: "12", target: "Water cycle, evaporation, condensation" },
  { paperTitle: "P6 Science Prelim ACS - J 2024", baseQ: "29", target: "Human respiratory and circulatory systems" },
  { paperTitle: "P6 Science Prelim Catholic High 2024", baseQ: "31", target: "Life cycles in plants and animals" },
  { paperTitle: "P6 Science Prelim Catholic High 2024", baseQ: "32", target: "Plant respiratory and circulatory systems" },
  { paperTitle: "P6 Math Prelim Henry Park 2024", baseQ: "P2-17", target: "Algebra" },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main() {
  for (const fix of FIXES) {
    const paper = await prisma.examPaper.findFirst({
      where: { title: fix.paperTitle, sourceExamId: null, paperType: null },
      select: { id: true, title: true },
    });
    if (!paper) {
      console.log(`SKIP -- paper not found: "${fix.paperTitle}"`);
      continue;
    }
    const candidates = await prisma.examQuestion.findMany({
      where: { examPaperId: paper.id, questionNum: { startsWith: fix.baseQ } },
      select: { id: true, questionNum: true, syllabusTopic: true },
    });
    // baseQ="38" should match 38, 38a, 38ab, 38c but NOT 380, 381.
    const baseRe = new RegExp(`^${escapeRe(fix.baseQ)}[a-zA-Z()]*$`);
    const siblings = candidates.filter(c => baseRe.test(c.questionNum));
    if (siblings.length === 0) {
      console.log(`SKIP -- no siblings matched for ${paper.title} Q${fix.baseQ}`);
      continue;
    }
    const before = siblings.map(s => `Q${s.questionNum}=[${s.syllabusTopic}]`).join(", ");
    const updates = siblings
      .filter(s => s.syllabusTopic !== fix.target)
      .map(s => prisma.examQuestion.update({ where: { id: s.id }, data: { syllabusTopic: fix.target } }));
    if (updates.length === 0) {
      console.log(`OK    ${paper.title} Q${fix.baseQ} -- already aligned: ${before}`);
      continue;
    }
    await prisma.$transaction(updates);
    console.log(`FIX   ${paper.title} Q${fix.baseQ} -> "${fix.target}"`);
    console.log(`      before: ${before}`);
  }
  process.exit(0);
}
main();
