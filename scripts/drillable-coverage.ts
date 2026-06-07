// Better coverage measure: "DRILLABLE" — if the student knows the
// word from the wordlist (with its pinyin + characters), can they
// answer this question?
//
// Previously I treated Q1-2 (pinyin) and Q3-4 (homophone) as NOT
// covered because the options are pinyin strings or single chars,
// not 2-char compounds. But the COMPOUND being TESTED is in the
// stem — and if the student has drilled that compound from the
// wordlist, they know its pinyin AND its characters.
//
// Slot-specific drillable check:
//   Q1-2 Pinyin    — stem contains a wordlist word → student knows pinyin
//   Q3-4 Homophone — stem (with correct char filled in) contains a
//                    wordlist word → student knows the compound the
//                    missing char belongs to
//   Q5-6 Vocab     — correct option is in wordlist (direct)
//   Q7-8 Idiom     — stem contains a wordlist idiom (direct)
//   Q9-10 Connectors — correct option in wordlist
//   Q11-12 Sentence completion — skip (sentence logic, not vocab)
//   Q13-15 Word usage — the target word (common to all 4 options) is
//                       in the wordlist
//
// For other sections (短文填空, 阅读理解, 完成对话), drillable =
// correct answer text contains a wordlist word (same as "strict"
// before — still a good proxy).

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/db";

type RawLesson = { lessonNumber: string | null; recogniseWords: string[]; writeWords: string[]; collocations: string[] };

function cjk(s: string): string { return s.replace(/[^一-鿿]/g, ""); }
function stripWhitespace(s: string): string { return s.replace(/\s+/g, ""); }

(async () => {
  const p4 = (JSON.parse(fs.readFileSync(path.join(__dirname, "p4-spelling-list.json"), "utf8")) as { lessons: RawLesson[] }).lessons;
  const p5 = (JSON.parse(fs.readFileSync(path.join(__dirname, "p5-spelling-list.json"), "utf8")) as { lessons: RawLesson[] }).lessons;
  const p6 = (JSON.parse(fs.readFileSync(path.join(__dirname, "p6-spelling-list.json"), "utf8")) as { lessons: RawLesson[] }).lessons;

  const wordSet = new Set<string>();
  for (const rows of [p4, p5, p6]) {
    for (const r of rows) {
      for (const w of [...r.recogniseWords, ...r.writeWords, ...r.collocations]) {
        if (cjk(w).length >= 2) wordSet.add(w);
      }
    }
  }
  const wordList = [...wordSet].sort((a, b) => b.length - a.length);
  const RX = new RegExp(wordList.map(w => w.replace(/[\\\[\]\(\)\{\}\.\+\*\?\|\^\$]/g, "\\$&")).join("|"), "g");
  function findHits(text: string): string[] {
    if (!text) return [];
    return text.match(RX) ?? [];
  }
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

  type Slot = "Q1-2 Pinyin" | "Q3-4 Homophone" | "Q5-6 Vocab" | "Q7-8 Idiom" | "Q9-10 Connectors" | "Q11-12 Sentence" | "Q13-15 Usage";
  function slotForQ(qNum: string): Slot | null {
    const n = parseInt(qNum, 10);
    if (n >= 1 && n <= 2) return "Q1-2 Pinyin";
    if (n >= 3 && n <= 4) return "Q3-4 Homophone";
    if (n >= 5 && n <= 6) return "Q5-6 Vocab";
    if (n >= 7 && n <= 8) return "Q7-8 Idiom";
    if (n >= 9 && n <= 10) return "Q9-10 Connectors";
    if (n >= 11 && n <= 12) return "Q11-12 Sentence";
    if (n >= 13 && n <= 15) return "Q13-15 Usage";
    return null;
  }

  // ─── Per-question drillable check ─────────────────────────────────
  type Eval = {
    year: string; section: string; qNum: string; slot: Slot | null; marks: number;
    drillable: boolean;
    why: string;       // short description of WHY (or why not) it's covered
    hitWord: string;   // the wordlist word that gives coverage (if any)
  };
  const evals: Eval[] = [];

  for (const q of questions) {
    const section = q.syllabusTopic ?? "?";
    const qNum = q.questionNum ?? "?";
    const stem = q.transcribedStem ?? "";
    const stemCjk = stripWhitespace(cjk(stem)); // strip all non-CJK for cleaner matching
    const opts = (Array.isArray(q.transcribedOptions) ? q.transcribedOptions : []) as string[];
    const ansNum = parseInt((q.answer ?? "").replace(/[^0-9]/g, ""), 10);
    const correctIdx = (ansNum >= 1 && ansNum <= 4) ? ansNum - 1 : -1;
    const correctText = correctIdx >= 0 ? (opts[correctIdx] ?? "") : (q.answer ?? "");
    const slot = section === "语文应用 MCQ" ? slotForQ(qNum) : null;

    let drillable = false;
    let why = "";
    let hitWord = "";

    if (slot === "Q1-2 Pinyin") {
      // Pinyin: stem contains the COMPOUND being pronounced.
      const hits = findHits(stemCjk);
      if (hits.length > 0) { drillable = true; hitWord = hits[0]; why = `stem contains wordlist compound (knowing it → knowing pinyin)`; }
      else why = "no wordlist compound found in stem";
    }
    else if (slot === "Q3-4 Homophone") {
      // Homophone: blank ___ replaced with the correct char (1 char).
      // If the resulting stem contains a wordlist word → student knows
      // the compound and which char fits.
      const correctChar = cjk(opts[correctIdx] ?? "");
      if (correctChar.length === 1) {
        // Substitute the FIRST run of underscores (or blank) with the char.
        const reconstructed = stem
          .replace(/_+|＿+|□+|\s+_+\s+/, correctChar)  // common blank glyphs
          .replace(/\s+/g, "");                          // strip spaces
        const reconstructedCjk = cjk(reconstructed);
        const hits = findHits(reconstructedCjk);
        if (hits.length > 0) { drillable = true; hitWord = hits[0]; why = `stem with "${correctChar}" filled in → wordlist has compound "${hits[0]}"`; }
        else why = `no wordlist compound found after filling in "${correctChar}"`;
      } else {
        why = "correct char missing or multi-char";
      }
    }
    else if (slot === "Q5-6 Vocab" || slot === "Q9-10 Connectors") {
      // The correct option itself should be a wordlist word.
      const correctCjk = cjk(correctText);
      const hits = findHits(correctCjk);
      if (hits.length > 0) { drillable = true; hitWord = hits[0]; why = `correct option "${correctCjk}" is in wordlist`; }
      else why = `correct option "${correctCjk}" not in wordlist`;
    }
    else if (slot === "Q7-8 Idiom") {
      // The idiom is in the stem (usually bolded). If the wordlist has
      // it, the student knows the meaning and picks the right gloss.
      const hits = findHits(stemCjk).filter(h => cjk(h).length >= 2);
      if (hits.length > 0) { drillable = true; hitWord = hits[0]; why = `stem contains wordlist word "${hits[0]}"`; }
      else why = "no wordlist idiom found in stem";
    }
    else if (slot === "Q11-12 Sentence") {
      // Sentence completion is logic, not vocabulary — count as not
      // drillable from wordlist alone.
      why = "sentence-completion slot — logic, not vocab";
    }
    else if (slot === "Q13-15 Usage") {
      // Find the target word — substring common to all 4 options.
      // Take longest such substring of length ≥ 2.
      if (opts.length === 4) {
        // Generate every 2-5 char substring of option 1, find ones in
        // all 4 options.
        const o0 = cjk(opts[0] ?? "");
        const candidates = new Set<string>();
        for (let n = 2; n <= Math.min(5, o0.length); n++) {
          for (let i = 0; i + n <= o0.length; i++) {
            const sub = o0.slice(i, i + n);
            if (opts.every(o => cjk(o ?? "").includes(sub))) candidates.add(sub);
          }
        }
        // Pick the longest candidate that's in the wordlist; otherwise
        // longest candidate.
        const sortedCands = [...candidates].sort((a, b) => b.length - a.length);
        const target = sortedCands.find(c => wordSet.has(c)) ?? sortedCands[0] ?? "";
        if (target && wordSet.has(target)) { drillable = true; hitWord = target; why = `target word "${target}" (common to all 4 options) is in wordlist`; }
        else if (target) why = `target word "${target}" (common to all 4 options) not in wordlist`;
        else why = "could not detect common target word in 4 options";
      } else {
        why = "Q13-15 but not 4 options";
      }
    }
    else {
      // Other PSLE sections (短文填空, 阅读理解 MCQ, 阅读理解 OEQ,
      // 完成对话). Coverage = correct-answer text contains a wordlist
      // word. (Same as previous "strict" measure.)
      const hits = findHits(stripWhitespace(cjk(correctText)));
      if (hits.length > 0) { drillable = true; hitWord = hits[0]; why = `correct-answer text contains wordlist word "${hits[0]}"`; }
      else why = `correct-answer text contains no wordlist word`;
    }

    evals.push({
      year: paperYear.get(q.examPaperId) ?? "?",
      section, qNum, slot, marks: q.marksAvailable ?? 1,
      drillable, why, hitWord,
    });
  }

  // ─── Aggregate ────────────────────────────────────────────────────
  const total = evals.length;
  const totalMarks = evals.reduce((s, e) => s + e.marks, 0);
  const drilled = evals.filter(e => e.drillable);
  const drilledMarks = drilled.reduce((s, e) => s + e.marks, 0);

  // Per section
  const bySection = new Map<string, Eval[]>();
  for (const e of evals) {
    const arr = bySection.get(e.section) ?? [];
    arr.push(e);
    bySection.set(e.section, arr);
  }
  const sectionStats = [...bySection.entries()].map(([section, qs]) => {
    const cov = qs.filter(q => q.drillable);
    const totMarks = qs.reduce((s, q) => s + q.marks, 0);
    const covMarks = cov.reduce((s, q) => s + q.marks, 0);
    return { section, total: qs.length, covered: cov.length, totalMarks: totMarks, coveredMarks: covMarks };
  }).sort((a, b) => b.total - a.total);

  // Per Section 1 slot
  const s1 = evals.filter(e => e.section === "语文应用 MCQ");
  const bySlot = new Map<Slot, Eval[]>();
  for (const e of s1) {
    if (!e.slot) continue;
    const arr = bySlot.get(e.slot) ?? [];
    arr.push(e);
    bySlot.set(e.slot, arr);
  }
  const SLOT_ORDER: Slot[] = ["Q1-2 Pinyin", "Q3-4 Homophone", "Q5-6 Vocab", "Q7-8 Idiom", "Q9-10 Connectors", "Q11-12 Sentence", "Q13-15 Usage"];
  const slotStats = SLOT_ORDER.map(slot => {
    const arr = bySlot.get(slot) ?? [];
    return { slot, total: arr.length, covered: arr.filter(e => e.drillable).length };
  });

  // ─── Markdown report ──────────────────────────────────────────────
  const md: string[] = [];
  md.push("# PSLE Chinese — DRILLABLE coverage (P5+P6 wordlist)\n");
  md.push(`*Revised measure: a question is "drillable" if the student, having mastered the wordlist (with its pinyin + characters), can be expected to answer it correctly.*\n`);
  md.push(`**Combined P5+P6 wordlist**: ${wordList.length} words (≥2 CJK chars).`);
  md.push(`**PSLE corpus**: ${total} questions, ${totalMarks} marks across 6 papers (2019-2024).\n`);

  md.push(`## 🎯 Headline\n`);
  md.push(`If the student memorises the combined P5+P6 wordlist (including pinyin and characters):`);
  md.push(`- **${drilled.length} of ${total} questions** drillable = **${Math.round(100 * drilled.length / total)}%**`);
  md.push(`- **${drilledMarks} of ${totalMarks} marks** drillable = **${Math.round(100 * drilledMarks / totalMarks)}%**\n`);

  md.push(`## 📖 What "drillable" means per slot\n`);
  md.push(`| Slot / Section | What we check |`);
  md.push(`|----------------|---------------|`);
  md.push(`| **Q1-2 Pinyin** | Stem contains a wordlist compound. Knowing the compound → knowing pinyin. |`);
  md.push(`| **Q3-4 Homophone** | After filling the correct char into the blank, the stem contains a wordlist compound. |`);
  md.push(`| **Q5-6 Vocab** | The correct option is a wordlist word. |`);
  md.push(`| **Q7-8 Idiom** | The idiom in the stem is a wordlist word. |`);
  md.push(`| **Q9-10 Connectors** | The correct connector is a wordlist word. |`);
  md.push(`| **Q11-12 Sentence completion** | NOT drillable (this is sentence-level logic, not vocabulary). |`);
  md.push(`| **Q13-15 Word usage** | The target word (common to all 4 options) is a wordlist word. |`);
  md.push(`| **短文填空 / 阅读理解 / 完成对话** | The correct answer text contains a wordlist word. |`);

  md.push(`\n## 📊 Coverage by PSLE section\n`);
  md.push(`| Section | Questions covered | Marks covered |`);
  md.push(`|---------|--------------------|----------------|`);
  for (const s of sectionStats) {
    md.push(`| **${s.section}** | ${s.covered} / ${s.total} = ${Math.round(100 * s.covered / s.total)}% | ${s.coveredMarks} / ${s.totalMarks} = ${Math.round(100 * s.coveredMarks / s.totalMarks)}% |`);
  }

  md.push(`\n## 🔬 Section 1 (语文应用 MCQ) — slot by slot\n`);
  md.push(`| Slot | Drillable | % |`);
  md.push(`|------|-----------|---|`);
  for (const s of slotStats) {
    md.push(`| **${s.slot}** | ${s.covered} / ${s.total} | ${Math.round(100 * s.covered / s.total)}% |`);
  }

  // ─── Diagnostic: which Section 1 questions DIDN'T drill ───────────
  md.push(`\n## ❌ Section 1 questions NOT drillable (and why)\n`);
  md.push(`These are the questions where the wordlist didn't cover the answer — useful for spotting gaps in the textbook list.\n`);
  md.push(`| Year | Q# | Slot | Why not |`);
  md.push(`|------|----|----|---------|`);
  for (const e of s1.filter(e => !e.drillable).sort((a, b) => a.year.localeCompare(b.year) || parseInt(a.qNum) - parseInt(b.qNum))) {
    md.push(`| ${e.year} | Q${e.qNum} | ${e.slot ?? "?"} | ${e.why} |`);
  }

  // ─── Sample drillable hits — proof of why measure works ──────────
  md.push(`\n## ✅ Sample drillable matches (proof the measure works)\n`);
  md.push(`A few of the Section 1 drillable hits, showing the wordlist word that made coverage possible:\n`);
  md.push(`| Year | Q# | Slot | Wordlist hit | How |`);
  md.push(`|------|----|------|---------------|-----|`);
  for (const e of s1.filter(e => e.drillable).sort((a, b) => a.year.localeCompare(b.year) || parseInt(a.qNum) - parseInt(b.qNum)).slice(0, 30)) {
    md.push(`| ${e.year} | Q${e.qNum} | ${e.slot ?? "?"} | **${e.hitWord}** | ${e.why} |`);
  }

  md.push(`\n## 🧭 What changed vs the previous report\n`);
  md.push(`Previously I treated pinyin (Q1-2) and homophone (Q3-4) as ~0% drillable because the OPTIONS don't contain wordlist words. That was wrong:`);
  md.push(`- Pinyin: the COMPOUND in the stem is what you memorise — if the wordlist has it, you can pick the right pinyin.`);
  md.push(`- Homophone: the compound the missing char belongs to is what gets drilled — if the wordlist has the compound, the answer falls out.`);
  md.push(`This revised measure raises Section 1 drillable coverage from low single digits up to ${slotStats.reduce((s, x) => s + x.covered, 0)}/${slotStats.reduce((s, x) => s + x.total, 0)} = ${Math.round(100 * slotStats.reduce((s, x) => s + x.covered, 0) / Math.max(slotStats.reduce((s, x) => s + x.total, 0), 1))}% of Section 1 questions.`);

  const outDir = path.join(__dirname, "..", "..", "documents");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "PSLE Chinese — drillable coverage (P5+P6 wordlist).md");
  fs.writeFileSync(outPath, md.join("\n"), "utf8");
  console.log(`\nWrote ${outPath}`);

  // Console summary
  console.log(`\n=== DRILLABLE coverage (revised) ===`);
  console.log(`  Overall: ${drilled.length}/${total} (${Math.round(100 * drilled.length / total)}%) questions, ${drilledMarks}/${totalMarks} (${Math.round(100 * drilledMarks / totalMarks)}%) marks`);
  console.log(`\n=== By section ===`);
  for (const s of sectionStats) {
    console.log(`  ${s.section.padEnd(20)} ${String(s.covered).padStart(3)}/${s.total} qs (${Math.round(100 * s.covered / s.total)}%)  ${String(s.coveredMarks).padStart(3)}/${s.totalMarks} marks (${Math.round(100 * s.coveredMarks / s.totalMarks)}%)`);
  }
  console.log(`\n=== Section 1 slots ===`);
  for (const s of slotStats) {
    console.log(`  ${s.slot.padEnd(25)} ${String(s.covered).padStart(3)}/${s.total} (${Math.round(100 * s.covered / s.total)}%)`);
  }

  await prisma.$disconnect();
})();
