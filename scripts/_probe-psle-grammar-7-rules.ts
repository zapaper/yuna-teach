// Verify the 7 grammar questions in the "Top Grammar Rules Tested
// in PSLE" infographic against our master bank:
//   A. Mr Thomas had ___ trouble  … (claimed PSLE 2022)
//   B. Mrs Phua is someone ___ opinions  … (2023)
//   C. She never ever visits the museum, ___?  (2024)
//   D. These days, the number of people … ___ on the rise. (2019)
//   E. Suresh nearly shut the door ___ Mei Yun's face  (2020)
//   F. Kamal made his baby sister ___ by playing peek-a-boo  (2021)
//   G. ___ the continual support from the villagers  (2022)
//
// For each, we search master Grammar MCQ rows whose stem matches a
// distinctive keyword, then print the actual PSLE paper (title/year)
// where it lives, plus the correct answer as recorded.

import "dotenv/config";
import { prisma } from "../src/lib/db";

type Probe = { label: string; keyword: string; expectedYear: string; expectedAnswer: string };
const PROBES: Probe[] = [
  { label: "A", keyword: "Mr Thomas had",              expectedYear: "2022", expectedAnswer: "little" },
  { label: "B", keyword: "Mrs Phua is someone",        expectedYear: "2023", expectedAnswer: "whose" },
  { label: "C", keyword: "never ever visits the museum", expectedYear: "2024", expectedAnswer: "does she" },
  { label: "D", keyword: "the number of people",       expectedYear: "2019", expectedAnswer: "is" },
  { label: "E", keyword: "Suresh nearly shut the door", expectedYear: "2020", expectedAnswer: "in" },
  { label: "F", keyword: "Kamal made his baby sister", expectedYear: "2021", expectedAnswer: "giggle" },
  { label: "G", keyword: "continual support from the villagers", expectedYear: "2022", expectedAnswer: "In spite of" },
];

(async () => {
  for (const p of PROBES) {
    const hits = await prisma.examQuestion.findMany({
      where: {
        transcribedStem: { contains: p.keyword, mode: "insensitive" },
        examPaper: {
          sourceExamId: null, paperType: null,
          subject: { contains: "english", mode: "insensitive" },
        },
      },
      select: {
        id: true, questionNum: true, transcribedStem: true,
        transcribedOptions: true, answer: true, syllabusTopic: true, subTopic: true,
        examPaper: { select: { id: true, title: true, year: true, level: true } },
      },
    });
    console.log(`── ${p.label}. keyword="${p.keyword}" (claimed ${p.expectedYear}, ans: ${p.expectedAnswer}) ──`);
    if (hits.length === 0) {
      console.log(`   NOT FOUND in the master bank`);
    } else {
      for (const h of hits) {
        const opts = Array.isArray(h.transcribedOptions) ? (h.transcribedOptions as string[]).join(" / ") : "—";
        const stemSnip = (h.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 160);
        const ansOk = (h.answer ?? "").toLowerCase().includes(p.expectedAnswer.toLowerCase());
        const yearOk = h.examPaper.year === p.expectedYear;
        const flags: string[] = [];
        if (!yearOk) flags.push(`YEAR MISMATCH (bank says "${h.examPaper.year ?? "?"}", not "${p.expectedYear}")`);
        if (!ansOk) flags.push(`ANS MISMATCH (bank says "${h.answer}", not "${p.expectedAnswer}")`);
        console.log(`   • ${h.examPaper.title} · Q${h.questionNum} · y=${h.examPaper.year ?? "?"} · ${h.syllabusTopic}${h.subTopic ? ` / ${h.subTopic}` : ""}`);
        console.log(`     stem: ${stemSnip}${(h.transcribedStem?.length ?? 0) > 160 ? " …" : ""}`);
        console.log(`     options: ${opts}`);
        console.log(`     official answer: ${h.answer}`);
        if (flags.length > 0) for (const f of flags) console.log(`     ⚠ ${f}`);
        else console.log(`     ✓ matches infographic year + answer`);
      }
    }
    console.log();
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
