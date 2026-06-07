import { prisma } from "../src/lib/db";

(async () => {
  // PSLE 2022-2024 banks (Life + Physical, MCQ + OEQ)
  const PAPER_IDS = [
    { id: "cmoqvvp4x005pwu9980mndv8v", label: "Life Science MCQ" },
    { id: "cmor0ghj80001msjf7wzhgkj9", label: "Life Science OEQ" },
    { id: "cmp6okxsg000lk9u7zjbu76mx", label: "Physical Science MCQ" },
    { id: "cmp6om1q8000nk9u7rabiiju5", label: "Physical Science OEQ" },
  ];

  let totalQ = 0, totalMarks = 0;
  let interQ = 0, interMarks = 0;

  for (const { id, label } of PAPER_IDS) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: id },
      select: { questionNum: true, marksAvailable: true, syllabusTopic: true, transcribedOptions: true },
    });
    const m = qs.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
    const inter = qs.filter(q => q.syllabusTopic === "Interactions within the environment");
    const iMarks = inter.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
    console.log(`${label}: ${qs.length}Q, ${m}m total | interactions = ${inter.length}Q, ${iMarks}m`);
    totalQ += qs.length;
    totalMarks += m;
    interQ += inter.length;
    interMarks += iMarks;
  }

  console.log(`\n=== OVERALL ===`);
  console.log(`Total: ${totalQ} questions, ${totalMarks} marks`);
  console.log(`Interactions: ${interQ} questions (${(interQ/totalQ*100).toFixed(1)}%), ${interMarks} marks (${(interMarks/totalMarks*100).toFixed(1)}%)`);
  console.log(`\nReference: PSLE Science = 100 marks/year × 3 years = 300 marks expected`);
  console.log(`Actual marks in DB: ${totalMarks} → suggests ${totalMarks === 300 ? "complete" : "MISSING " + (300 - totalMarks) + " marks"}`);
  await prisma.$disconnect();
})();
