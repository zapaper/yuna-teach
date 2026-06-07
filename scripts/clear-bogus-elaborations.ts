// Null out elaborations matching the deterministic "Step 1: key values,
// Step 2: equation, Step 3: match" template. These were Gemini
// no-context hallucinations cached by the elaborate route's old
// image-only path. The route now uses the transcribed-text prompt
// whenever a stem exists, so re-generation will produce real
// explanations.

import { prisma } from "../src/lib/db";

async function main() {
  const updated = await prisma.examQuestion.updateMany({
    where: {
      elaboration: { not: null },
      AND: [
        { elaboration: { contains: "Read the question carefully to identify" } },
        { elaboration: { contains: "equation" } },
        { elaboration: { contains: "Match your final calculated result" } },
      ],
    },
    data: { elaboration: null },
  });
  console.log(`Cleared bogus elaboration on ${updated.count} questions.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
