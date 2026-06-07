// Question-centric PSLE coverage: of all PSLE Chinese 2019-2024
// questions, what fraction has its CORRECT ANSWER covered by the
// combined P5+P6 wordlist?
//
// Three coverage levels per question:
//   - STRICT  — the correct answer text contains at least one
//                wordlist word (≥2 CJK chars).
//   - MEDIUM  — at least one MCQ option contains a wordlist word.
//   - LOOSE   — anywhere in stem/options/answer contains one.
//
// We also break down by PSLE section AND by Section 1 question slot
// (Q1-2 pinyin / Q3-4 homophone / Q5-6 vocab / Q7-8 idiom /
//  Q9-10 connectors / Q11-12 sentence completion / Q13-15 usage).

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/db";

type RawLesson = { lessonNumber: string | null; recogniseWords: string[]; writeWords: string[]; collocations: string[] };

(async () => {
  const p5 = (JSON.parse(fs.readFileSync(path.join(__dirname, "p5-spelling-list.json"), "utf8")) as { lessons: RawLesson[] }).lessons;
  const p6 = (JSON.parse(fs.readFileSync(path.join(__dirname, "p6-spelling-list.json"), "utf8")) as { lessons: RawLesson[] }).lessons;

  const wordSet = new Set<string>();
  for (const rows of [p5, p6]) {
    for (const r of rows) {
      for (const w of [...r.recogniseWords, ...r.writeWords, ...r.collocations]) {
        const cjk = w.replace(/[^一-鿿]/g, "");
        if (cjk.length >= 2) wordSet.add(w);
      }
    }
  }
  const wordList = [...wordSet];
  console.log(`Combined P5+P6 wordlist: ${wordList.length} words (≥2 CJK chars)`);

  // ─── Pull PSLE corpus ─────────────────────────────────────────────
  const papers = await prisma.examPaper.findMany({
    where: {
      OR: [
        { title: { contains: "PSLE", mode: "insensitive" } },
        { level: { equals: "PSLE", mode: "insensitive" } },
      ],
      subject: { contains: "chinese", mode: "insensitive" },
      sourceExamId: null,
      paperType: null,
    },
    select: { id: true, year: true },
  });
  const paperYear = new Map(papers.map(p => [p.id, p.year]));
  const questions = await prisma.examQuestion.findMany({
    where: { examPaperId: { in: papers.map(p => p.id) } },
    select: {
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      transcribedSubparts: true,
      syllabusTopic: true,
      answer: true,
      marksAvailable: true,
      examPaperId: true,
    },
  });

  // Build a regex per word to find ALL hits at once. To stay fast,
  // build a single alternation regex. Sort by length DESC so longer
  // matches (e.g. 一系列) win over short ones (e.g. 系列).
  const sortedWords = wordList.slice().sort((a, b) => b.length - a.length);
  // Escape any regex special chars (none expected in CJK but defensive).
  const RX = new RegExp(sortedWords.map(w => w.replace(/[\\\[\]\(\)\{\}\.\+\*\?\|\^\$]/g, "\\$&")).join("|"), "g");

  function findHits(text: string): string[] {
    if (!text) return [];
    const hits = text.match(RX);
    return hits ?? [];
  }

  // ─── Per-question evaluation ──────────────────────────────────────
  type QRecord = {
    year: string;
    section: string;
    qNum: string;
    marks: number;
    correctText: string;     // text of the correct MCQ option (or full answer for OEQ)
    optionsText: string;     // joined options
    stem: string;
    correctHits: string[];   // wordlist words found in correctText
    optionHits: string[];    // wordlist words found in optionsText
    stemHits: string[];      // wordlist words found in stem
  };
  const records: QRecord[] = [];
  for (const q of questions) {
    const opts = (Array.isArray(q.transcribedOptions) ? q.transcribedOptions : []) as string[];
    const ansNum = parseInt((q.answer ?? "").replace(/[^0-9]/g, ""), 10);
    const correctIdx = (ansNum >= 1 && ansNum <= 4) ? ansNum - 1 : -1;
    const correctText = correctIdx >= 0 ? (opts[correctIdx] ?? "") : (q.answer ?? "");
    const stem = q.transcribedStem ?? "";
    const optionsText = opts.join(" | ");
    records.push({
      year: paperYear.get(q.examPaperId) ?? "?",
      section: q.syllabusTopic ?? "?",
      qNum: q.questionNum ?? "?",
      marks: q.marksAvailable ?? 1,
      correctText, optionsText, stem,
      correctHits: [...new Set(findHits(correctText))],
      optionHits: [...new Set(findHits(optionsText))],
      stemHits: [...new Set(findHits(stem))],
    });
  }

  // ─── Section-level aggregate ──────────────────────────────────────
  const bySection = new Map<string, QRecord[]>();
  for (const r of records) {
    const arr = bySection.get(r.section) ?? [];
    arr.push(r);
    bySection.set(r.section, arr);
  }
  type SectionStat = {
    section: string;
    total: number;
    strictCovered: number;     // correct-answer text contains a wordlist word
    mediumCovered: number;     // at least one option contains a wordlist word
    looseCovered: number;       // any of (stem | options | correct) contains
    totalMarks: number;
    strictMarks: number;
    mediumMarks: number;
    looseMarks: number;
  };
  const sectionStats: SectionStat[] = [...bySection.entries()].map(([section, qs]) => {
    const strict = qs.filter(q => q.correctHits.length > 0);
    const medium = qs.filter(q => q.optionHits.length > 0);
    const loose = qs.filter(q => q.correctHits.length > 0 || q.optionHits.length > 0 || q.stemHits.length > 0);
    const totalMarks = qs.reduce((s, q) => s + q.marks, 0);
    return {
      section,
      total: qs.length,
      strictCovered: strict.length,
      mediumCovered: medium.length,
      looseCovered: loose.length,
      totalMarks,
      strictMarks: strict.reduce((s, q) => s + q.marks, 0),
      mediumMarks: medium.reduce((s, q) => s + q.marks, 0),
      looseMarks: loose.reduce((s, q) => s + q.marks, 0),
    };
  }).sort((a, b) => b.total - a.total);

  // ─── Section 1 (语文应用 MCQ) slot-by-slot breakdown ─────────────
  // Q1-2 pinyin, Q3-4 homophone, Q5-6 vocab, Q7-8 idiom meaning,
  // Q9-10 connectors, Q11-12 sentence completion, Q13-15 usage
  const s1 = records.filter(r => r.section === "语文应用 MCQ");
  type SlotStat = { slot: string; range: string; total: number; strict: number; medium: number; loose: number };
  function slotForQ(qNum: string): string {
    const n = parseInt(qNum, 10);
    if (n >= 1 && n <= 2) return "Q1-2 Pinyin";
    if (n >= 3 && n <= 4) return "Q3-4 Homophone";
    if (n >= 5 && n <= 6) return "Q5-6 Vocabulary";
    if (n >= 7 && n <= 8) return "Q7-8 Idiom meaning";
    if (n >= 9 && n <= 10) return "Q9-10 Connectors";
    if (n >= 11 && n <= 12) return "Q11-12 Sentence completion";
    if (n >= 13 && n <= 15) return "Q13-15 Word usage";
    return "other";
  }
  const slotMap = new Map<string, QRecord[]>();
  for (const r of s1) {
    const slot = slotForQ(r.qNum);
    const arr = slotMap.get(slot) ?? [];
    arr.push(r);
    slotMap.set(slot, arr);
  }
  const SLOT_ORDER = ["Q1-2 Pinyin", "Q3-4 Homophone", "Q5-6 Vocabulary", "Q7-8 Idiom meaning", "Q9-10 Connectors", "Q11-12 Sentence completion", "Q13-15 Word usage"];
  const slotStats: SlotStat[] = SLOT_ORDER.map(slot => {
    const arr = slotMap.get(slot) ?? [];
    return {
      slot,
      range: slot,
      total: arr.length,
      strict: arr.filter(q => q.correctHits.length > 0).length,
      medium: arr.filter(q => q.optionHits.length > 0).length,
      loose: arr.filter(q => q.correctHits.length > 0 || q.optionHits.length > 0 || q.stemHits.length > 0).length,
    };
  });

  // ─── Build markdown report ────────────────────────────────────────
  const md: string[] = [];
  md.push("# PSLE Chinese 2019-2024 — Question coverage by P5+P6 wordlist\n");
  md.push(`This flips the lens: instead of "what % of the wordlist appears in PSLE", we ask "what % of PSLE QUESTIONS can be answered using only the wordlist".\n`);
  md.push(`**Combined P5+P6 wordlist**: ${wordList.length} words (≥2 CJK chars), drawn from 识读词语 + 识写字词 + 词语搭配.`);
  md.push(`**PSLE corpus**: ${records.length} questions across ${papers.length} papers (2019-2024).\n`);

  md.push(`## 📖 Three coverage measures (what each one means)\n`);
  md.push(`| Measure | Definition | Why it matters |`);
  md.push(`|---------|-----------|-----------------|`);
  md.push(`| **Strict** | The CORRECT answer text contains at least one wordlist word. | The student likely picks the right answer if they know it. The cleanest "can the wordlist alone answer this question" measure. |`);
  md.push(`| **Medium** | At least ONE of the 4 MCQ options contains a wordlist word. | The wordlist gives the student traction on the question even if it doesn't directly give the answer. |`);
  md.push(`| **Loose** | Wordlist word appears anywhere — stem, options, or answer. | The student understands the question's vocabulary at all. Maximum reach. |`);
  md.push(``);
  md.push(`Strict is the most honest answer to "can the student answer this question with the wordlist?". Medium/Loose show wider exposure.\n`);

  // ─── Overall coverage table ──────────────────────────────────────
  const totalQs = records.length;
  const totalMarks = records.reduce((s, q) => s + q.marks, 0);
  const strictTotal = records.filter(q => q.correctHits.length > 0).length;
  const mediumTotal = records.filter(q => q.optionHits.length > 0).length;
  const looseTotal = records.filter(q => q.correctHits.length > 0 || q.optionHits.length > 0 || q.stemHits.length > 0).length;
  const strictMarks = records.filter(q => q.correctHits.length > 0).reduce((s, q) => s + q.marks, 0);
  const mediumMarks = records.filter(q => q.optionHits.length > 0).reduce((s, q) => s + q.marks, 0);
  const looseMarks = records.filter(q => q.correctHits.length > 0 || q.optionHits.length > 0 || q.stemHits.length > 0).reduce((s, q) => s + q.marks, 0);

  md.push(`## 🎯 Overall PSLE coverage (combined P5+P6 wordlist)\n`);
  md.push(`| Measure | Questions covered | % of total questions | Marks covered | % of total marks |`);
  md.push(`|---------|--------------------|-----------------------|----------------|-------------------|`);
  md.push(`| **Strict** | ${strictTotal} / ${totalQs} | **${Math.round(100 * strictTotal / totalQs)}%** | ${strictMarks} / ${totalMarks} | **${Math.round(100 * strictMarks / totalMarks)}%** |`);
  md.push(`| **Medium** | ${mediumTotal} / ${totalQs} | ${Math.round(100 * mediumTotal / totalQs)}% | ${mediumMarks} / ${totalMarks} | ${Math.round(100 * mediumMarks / totalMarks)}% |`);
  md.push(`| **Loose** | ${looseTotal} / ${totalQs} | ${Math.round(100 * looseTotal / totalQs)}% | ${looseMarks} / ${totalMarks} | ${Math.round(100 * looseMarks / totalMarks)}% |`);
  md.push(``);

  // ─── Per-section breakdown ────────────────────────────────────────
  md.push(`## 📊 Coverage by PSLE section\n`);
  md.push(`| Section | Questions | Marks | Strict % (Qs / marks) | Medium % | Loose % |`);
  md.push(`|---------|-----------|-------|------------------------|----------|---------|`);
  for (const s of sectionStats) {
    md.push(`| **${s.section}** | ${s.total} | ${s.totalMarks} | ${Math.round(100 * s.strictCovered / s.total)}% / ${Math.round(100 * s.strictMarks / s.totalMarks)}% | ${Math.round(100 * s.mediumCovered / s.total)}% | ${Math.round(100 * s.looseCovered / s.total)}% |`);
  }
  md.push(`\n**Reading this table:** "Strict %" is the cleanest signal. If a row shows 60% strict, it means 60% of that section's questions have their correct answer text overlapping with the wordlist.\n`);

  // ─── Section 1 slot breakdown ────────────────────────────────────
  md.push(`## 🔬 Section 1 (语文应用 MCQ) — slot-by-slot\n`);
  md.push(`Each PSLE paper's Section 1 has 15 questions in fixed slots. Coverage varies sharply by slot type:\n`);
  md.push(`| Slot | Questions (6 papers) | Strict coverage | Medium | Loose |`);
  md.push(`|------|----------------------|------------------|--------|--------|`);
  for (const s of slotStats) {
    if (s.total === 0) continue;
    md.push(`| **${s.slot}** | ${s.total} | ${s.strict} (${Math.round(100 * s.strict / s.total)}%) | ${s.medium} (${Math.round(100 * s.medium / s.total)}%) | ${s.loose} (${Math.round(100 * s.loose / s.total)}%) |`);
  }
  md.push(``);

  // Slot interpretation
  md.push(`**What this means per slot:**`);
  md.push(`- **Q1-2 Pinyin** — the underlined COMPOUND in the stem is the target. Strict measures whether the wordlist contains that compound.`);
  md.push(`- **Q3-4 Homophone** — single-char fill. Options are 4 candidate chars. Wordlist mostly has 2+ char compounds, so strict coverage is naturally low — looking for the COMPOUND in the stem is the real test (see Loose %).`);
  md.push(`- **Q5-6 Vocabulary** — options are 2-char compounds. Strict = wordlist contains the correct compound.`);
  md.push(`- **Q7-8 Idiom meaning** — stem has a 成语. Wordlist contains the idiom → student knows the meaning.`);
  md.push(`- **Q9-10 Connectors** — small fixed vocabulary, mostly in wordlist already.`);
  md.push(`- **Q11-12 Sentence completion** — full clauses; depends on logic, not vocabulary.`);
  md.push(`- **Q13-15 Word usage** — target word appears in all 4 options. Wordlist contains that target → student knows the word's collocations.\n`);

  // ─── Bottom-line summary ─────────────────────────────────────────
  md.push(`## 🧭 Bottom line\n`);
  md.push(`If a student fully memorises the combined P5+P6 wordlist (${wordList.length} words, both 识读+识写+搭配):`);
  md.push(`- They have direct vocabulary support for **${Math.round(100 * strictMarks / totalMarks)}% of PSLE Chinese marks** (strict).`);
  md.push(`- They have *some* vocabulary footprint on **${Math.round(100 * looseMarks / totalMarks)}% of marks** (loose — at least one wordlist word appears somewhere in the question).`);
  md.push(`- The strict coverage is concentrated in **Section 1 (语文应用 MCQ)** and **短文填空** — the explicit vocabulary-testing sections.`);
  md.push(`- **阅读理解 OEQ** has the highest loose coverage but lowest strict — the wordlist helps READ the passage, not WRITE the answer.\n`);

  const outDir = path.join(__dirname, "..", "..", "documents");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "PSLE Chinese — question coverage by P5+P6 wordlist.md");
  fs.writeFileSync(outPath, md.join("\n"), "utf8");
  console.log(`\nWrote ${outPath}`);

  // Console summary
  console.log(`\n=== Overall coverage ===`);
  console.log(`  Strict: ${strictTotal}/${totalQs} (${Math.round(100 * strictTotal / totalQs)}%) questions, ${strictMarks}/${totalMarks} (${Math.round(100 * strictMarks / totalMarks)}%) marks`);
  console.log(`  Medium: ${mediumTotal}/${totalQs} (${Math.round(100 * mediumTotal / totalQs)}%) questions`);
  console.log(`  Loose:  ${looseTotal}/${totalQs} (${Math.round(100 * looseTotal / totalQs)}%) questions`);
  console.log(`\n=== By section ===`);
  for (const s of sectionStats) {
    console.log(`  ${s.section.padEnd(20)}  ${String(s.total).padStart(3)} qs  strict=${String(s.strictCovered).padStart(3)}/${s.total} (${Math.round(100 * s.strictCovered / s.total)}%)  loose=${String(s.looseCovered).padStart(3)}/${s.total} (${Math.round(100 * s.looseCovered / s.total)}%)`);
  }
  console.log(`\n=== Section 1 slots ===`);
  for (const s of slotStats) {
    if (s.total === 0) continue;
    console.log(`  ${s.slot.padEnd(30)} ${String(s.strict).padStart(3)}/${s.total} strict  ${String(s.medium).padStart(3)}/${s.total} medium  ${String(s.loose).padStart(3)}/${s.total} loose`);
  }

  await prisma.$disconnect();
})();
