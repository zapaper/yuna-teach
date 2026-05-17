import { prisma } from "../src/lib/db";

async function main() {
  const q = await prisma.examQuestion.findUnique({
    where: { id: "cmocwbrid000dqg5w7a2hd1vz" },
    select: { id: true, questionNum: true, transcribedStem: true, transcribedOptions: true, transcribedSubparts: true, answer: true, examPaper: { select: { title: true, subject: true, paperType: true, sourceExamId: true } } },
  });
  console.log(JSON.stringify(q, null, 2));

  // Apply the new scan logic locally
  const MIXED = /\b\d+\s+\d+\/\d+\b/;
  const FRAC = /(?<!\/|\d)\b\d+\/\d+\b(?!\/)/;
  const stem = q?.transcribedStem ?? "";
  console.log("\nStem mixed-number match:", MIXED.test(stem));
  console.log("Stem bare-fraction match:", FRAC.test(stem));
  console.log("Has $:", stem.includes("$"));

  // Check transcribedOptions shape
  const opts = q?.transcribedOptions as unknown;
  console.log("Options is array:", Array.isArray(opts));
  if (Array.isArray(opts)) {
    console.log("Options length:", opts.length);
    console.log("Options string count:", opts.filter(o => typeof o === "string").length);
  }
  await prisma.$disconnect();
}
main();
