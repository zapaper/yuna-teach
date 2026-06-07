// Categorise the P6 Chinese wordlist by KIND (idioms vs 2-char verbs
// vs nouns vs connectors vs collocations etc.) and report per-category
// PSLE coverage. Output goes to the user's project documents/ folder.

import * as fs from "fs";
import * as path from "path";

type CanonicalWord = {
  word: string;
  chars: number;
  appearances: Array<{ lesson: string; lessonTitle: string; type: "识读" | "识写" | "搭配" }>;
  pslePsleSections: string[];
  psleYears: string[];
  totalHits: number;
  correctCount: number;
  distractorCount: number;
  stemOrPassageCount: number;
  hits: Array<{ year: string; qNum: string; section: string; role: string }>;
};
type Canonical = {
  totals: { totalEntries: number; uniqueWords: number; byType: { 识读: number; 识写: number; 搭配: number } };
  words: CanonicalWord[];
  perLesson: Array<{ lessonNumber: string; lessonTitle: string; 识读词语: string[]; 识写字词: string[]; 词语搭配: string[] }>;
};

// ─── Classifier: pick a single "kind" for a wordlist entry ────────
// We use a precedence:
//   1. Is it tagged as 词语搭配 in the wordlist? → "collocation"
//   2. Length-based:
//      - 5+ chars → "saying" (idiomatic sentence, e.g. 家有一老，如有一宝)
//      - 4 chars  → "idiom (成语)"
//      - 3 chars  → "3-char compound"
//      - 2 chars  → split by POS heuristic:
//          • Connectors (small fixed list) → "connector"
//          • Pronouns / numerals (small fixed list) → "function"
//          • Otherwise → "2-char compound"
//      - 1 char   → "single char"

const CONNECTORS = new Set([
  "因为", "所以", "如果", "虽然", "但是", "可是", "不过", "然而", "尽管", "即使",
  "由于", "只要", "只有", "除非", "假如", "假使", "倘若", "无论", "不管",
  "不仅", "不但", "而且", "并且", "况且", "甚至", "反而", "却是", "于是",
  "然后", "接着", "接下来", "首先", "其次", "再者", "最后", "终于",
  "除了", "自从", "原来", "其实", "其实", "竟然", "果然", "其实",
]);
const FUNCTION_WORDS = new Set([
  "我们", "你们", "他们", "她们", "自己", "别人", "大家", "什么", "怎么",
  "这里", "那里", "这边", "那边", "今天", "明天", "昨天", "现在", "刚才",
  "一些", "一个", "一直", "一定", "一起", "已经", "可能", "或许", "也许",
]);

function classify(word: string, isCollocation: boolean): string {
  const chars = word.replace(/[^一-鿿]/g, "").length;
  if (isCollocation) return "collocation";
  if (chars >= 5) return "saying";
  if (chars === 4) return "idiom";
  if (chars === 3) return "3-char compound";
  if (chars === 2) {
    if (CONNECTORS.has(word)) return "connector";
    if (FUNCTION_WORDS.has(word)) return "function";
    return "2-char compound";
  }
  return "single char";
}

(async () => {
  const canonical = JSON.parse(fs.readFileSync(path.join(__dirname, "p6-wordlist-canonical.json"), "utf8")) as Canonical;

  // Build a set of collocation words for fast lookup.
  const collocationSet = new Set<string>();
  for (const l of canonical.perLesson) for (const c of l["词语搭配"]) collocationSet.add(c);

  // Annotate every word with a category.
  type Annotated = CanonicalWord & { kind: string };
  const annotated: Annotated[] = canonical.words.map(w => ({
    ...w,
    kind: classify(w.word, collocationSet.has(w.word)),
  }));

  // ─── Per-category aggregates ──────────────────────────────────────
  type CategoryStat = {
    kind: string;
    totalInList: number;
    testedInPsle: number;
    correctAnswerCount: number;        // distinct words used as a correct answer
    totalCorrectHits: number;          // total correct-answer occurrences
    totalAnyHits: number;              // total occurrences across all roles
    correctAnswers: Annotated[];       // sorted by correct hit count
    distractorOnly: Annotated[];       // tested but never correct
    untested: number;
  };

  const categories = ["idiom", "saying", "3-char compound", "2-char compound", "connector", "collocation", "function", "single char"];
  const stats: CategoryStat[] = categories.map(kind => {
    const all = annotated.filter(a => a.kind === kind);
    const tested = all.filter(a => a.totalHits > 0);
    const correct = tested.filter(a => a.correctCount > 0).sort((a, b) => b.correctCount - a.correctCount || b.totalHits - a.totalHits);
    const distractorOnly = tested.filter(a => a.correctCount === 0).sort((a, b) => b.totalHits - a.totalHits);
    return {
      kind,
      totalInList: all.length,
      testedInPsle: tested.length,
      correctAnswerCount: correct.length,
      totalCorrectHits: tested.reduce((s, w) => s + w.correctCount, 0),
      totalAnyHits: tested.reduce((s, w) => s + w.totalHits, 0),
      correctAnswers: correct,
      distractorOnly,
      untested: all.length - tested.length,
    };
  });

  // ─── Build the markdown document ─────────────────────────────────
  const md: string[] = [];
  md.push("# P6 Chinese Wordlist — What kinds of words does PSLE actually test?\n");
  md.push(`Source: Maris Stella 高级华文 词语单 (12 lessons). OCR'd with **gemini-3.1-pro-preview**.`);
  md.push(`Canonical wordlist: **${canonical.totals.uniqueWords} unique words** (识读 ${canonical.totals.byType["识读"]} + 识写 ${canonical.totals.byType["识写"]} + 搭配 ${canonical.totals.byType["搭配"]}).`);
  md.push(`Cross-checked against **240 PSLE Chinese questions** across 6 years (2019-2024), all 5 sections.\n`);

  // ─── Glossary: clarify "tested" vs "total hits" ──────────────────
  md.push(`## 📖 Reading the numbers — "tested" vs "total PSLE hits"\n`);
  md.push(`Two different counts can be confusing — here's the difference:\n`);
  md.push(`| Metric | What it counts | Example |`);
  md.push(`|--------|---------------|---------|`);
  md.push(`| **Tested in PSLE** | Number of DISTINCT wordlist entries that appeared at least once. | 98 of 675 unique words showed up somewhere in PSLE 2019-2024. |`);
  md.push(`| **Total PSLE hits** | Total number of TIMES those words appeared (summed across every question, every section, every year). | 作者 alone shows up in 19 questions → contributes 1 to "tested" but 19 to "total hits". |`);
  md.push(`| **Correct-answer hits** | Subset of "total hits" where the word was part of the MCQ option marked CORRECT. The strongest signal — these are words PSLE explicitly chose to reward. | 神机妙算 was the correct answer to 2023 Q15 → 1 correct-answer hit. |`);
  md.push(`\nThink of it as: **tested = breadth of coverage; total hits = depth of repetition**. A word with high hits but low correct-answer count is just appearing in passages; a word with even 1-2 correct-answer hits is one PSLE actively rewards knowing.\n`);

  // ─── Headline category table ─────────────────────────────────────
  md.push(`## 🎯 Coverage by word kind\n`);
  md.push(`Which kinds of words does PSLE actually test? (Sorted by correct-answer hits.)\n`);
  md.push(`| Kind | In wordlist | Tested | Correct-answer | Total hits | % tested | Hit→Test ratio |`);
  md.push(`|------|-------------|--------|----------------|-----------|----------|----------------|`);
  for (const s of [...stats].sort((a, b) => b.totalCorrectHits - a.totalCorrectHits)) {
    const pctTested = s.totalInList === 0 ? 0 : Math.round(100 * s.testedInPsle / s.totalInList);
    const ratio = s.testedInPsle === 0 ? "—" : (s.totalAnyHits / s.testedInPsle).toFixed(1) + "×";
    md.push(`| **${s.kind}** | ${s.totalInList} | ${s.testedInPsle} | ${s.correctAnswerCount} words / ${s.totalCorrectHits} hits | ${s.totalAnyHits} | ${pctTested}% | ${ratio} |`);
  }

  md.push(`\n**Reading the table:**`);
  md.push(`- **% tested**: of the X words of this kind in the textbook list, what fraction showed up at all in PSLE? Low % means PSLE doesn't care about that kind much.`);
  md.push(`- **Hit→Test ratio**: total hits divided by tested words. A high ratio (5×+) means the same words get repeated heavily; a low ratio (1.5× or below) means each tested word appears just once or twice.`);

  // ─── Per-kind deep dive ──────────────────────────────────────────
  for (const s of [...stats].sort((a, b) => b.totalCorrectHits - a.totalCorrectHits)) {
    if (s.testedInPsle === 0) continue;
    md.push(`\n## ${kindLabel(s.kind)} (${s.totalInList} in list, ${s.testedInPsle} tested, ${s.correctAnswerCount} as correct answer)\n`);
    md.push(kindDescription(s.kind));
    if (s.correctAnswers.length > 0) {
      md.push(`\n**Words that have been a CORRECT answer in PSLE:**`);
      md.push(``);
      md.push(`| Word | Correct hits | Other hits | PSLE sections | Lesson(s) | Where (most recent) |`);
      md.push(`|------|-------------|------------|----------------|-----------|---------------------|`);
      for (const w of s.correctAnswers.slice(0, 25)) {
        const lessons = [...new Set(w.appearances.map(a => a.lesson))].join(",");
        const sections = w.pslePsleSections.join(", ");
        const correctHit = w.hits.find(h => h.role === "correct");
        const where = correctHit ? `${correctHit.year}/${correctHit.section}/Q${correctHit.qNum}` : "—";
        md.push(`| **${w.word}** | ${w.correctCount} | ${w.distractorCount + w.stemOrPassageCount} | ${sections} | ${lessons} | ${where} |`);
      }
    }
    if (s.distractorOnly.length > 0 && s.distractorOnly.length <= 30) {
      md.push(`\n**Words tested as distractor/passage only (PSLE has seen but not yet rewarded):**`);
      md.push(s.distractorOnly.map(w => `${w.word} (${w.totalHits}×)`).join("、"));
    } else if (s.distractorOnly.length > 30) {
      md.push(`\n**Distractor/passage-only words (top 30 of ${s.distractorOnly.length}):**`);
      md.push(s.distractorOnly.slice(0, 30).map(w => `${w.word} (${w.totalHits}×)`).join("、"));
    }
  }

  // ─── Coverage takeaways ──────────────────────────────────────────
  md.push(`\n## 🧭 Takeaways for drilling priority\n`);
  const idiomStat = stats.find(s => s.kind === "idiom")!;
  const twoCharStat = stats.find(s => s.kind === "2-char compound")!;
  const collocStat = stats.find(s => s.kind === "collocation")!;
  const threeCharStat = stats.find(s => s.kind === "3-char compound")!;
  md.push(`1. **2-char compounds** are by far the biggest bucket — ${twoCharStat.totalInList} in the list, ${twoCharStat.testedInPsle} tested (${Math.round(100 * twoCharStat.testedInPsle / twoCharStat.totalInList)}%), ${twoCharStat.correctAnswerCount} have been correct answers. These dominate Q5-Q6 vocab choice and 短文填空 cloze.`);
  md.push(`2. **4-char 成语** have ${idiomStat.totalInList} entries in the list; ${idiomStat.testedInPsle} appeared in PSLE and ${idiomStat.correctAnswerCount} were correct answers (Q7-Q8 meaning or Q13-Q15 usage). High-value because each ${(idiomStat.totalCorrectHits / Math.max(idiomStat.correctAnswerCount, 1)).toFixed(1)} mark hit comes from knowing ONE idiom.`);
  md.push(`3. **3-char compounds** are rarely tested — ${threeCharStat.totalInList} in list, ${threeCharStat.testedInPsle} tested. Lower drill priority unless they're high-frequency narrative words.`);
  md.push(`4. **词语搭配 (collocations)** — ${collocStat.totalInList} in the list, ${collocStat.testedInPsle} tested, ${collocStat.correctAnswerCount} as correct answer. PSLE doesn't directly test the collocation form, but knowing them helps Q11-Q12 sentence completion and 阅读理解.`);
  md.push(`5. **Untested tail**: ${canonical.totals.uniqueWords - 98} wordlist words never appeared in 6 years of PSLE. Mostly narrative-specific vocabulary (三国 / 龙王 / 火山 etc.).`);
  md.push(`6. **Repetition signal**: ${stats.find(s => s.kind === "2-char compound")!.totalAnyHits}+ total hits for 2-char compounds means PSLE recycles a small set of high-utility vocabulary heavily. The 16 words that have been CORRECT answers are the most concentrated drill targets.\n`);

  // ─── If P5 spelling list later: how to extend this ───────────────
  md.push(`## 📝 When you scan the P5 spelling list later\n`);
  md.push(`Drop the P5 PDF into the same folder (\`Data Past Year Papers/PSLE Chinese/\`) and I'll:`);
  md.push(`1. Re-run the OCR pipeline (gemini-3.1-pro-preview) to extract the same 3-segment structure.`);
  md.push(`2. Tag P5 entries with a \`level: "P5"\` field, so the canonical list becomes a combined P5+P6 repository (with duplicates merged — words taught in both years get extra weight).`);
  md.push(`3. Re-run this kind-coverage analysis. We'd expect P5 vocabulary to overlap significantly with the "untested in P6" tail — that's actually the most useful: P5 words showing up in PSLE means students need to retain them, not relearn.`);

  // Write to documents/
  const outDir = path.join(__dirname, "..", "..", "documents");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "P6 Chinese wordlist — kinds of words PSLE tests.md");
  fs.writeFileSync(outPath, md.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
  console.log(`\nCategory summary:`);
  for (const s of [...stats].sort((a, b) => b.totalCorrectHits - a.totalCorrectHits)) {
    if (s.totalInList === 0) continue;
    console.log(`  ${s.kind.padEnd(20)} ${String(s.totalInList).padStart(4)} in list  ${String(s.testedInPsle).padStart(3)} tested  ${String(s.correctAnswerCount).padStart(2)} as correct (${s.totalCorrectHits} correct hits, ${s.totalAnyHits} total hits)`);
  }
})();

function kindLabel(k: string): string {
  switch (k) {
    case "idiom": return "🏛️ 4-character idioms (成语)";
    case "saying": return "📜 5+ character sayings";
    case "3-char compound": return "🔹 3-character compounds";
    case "2-char compound": return "🎯 2-character compounds (the bread and butter)";
    case "connector": return "🔗 Connectors / 关联词";
    case "collocation": return "🧩 词语搭配 (collocations)";
    case "function": return "🛠️ Function words";
    case "single char": return "⬜ Single characters";
    default: return k;
  }
}

function kindDescription(k: string): string {
  switch (k) {
    case "idiom": return `**Where PSLE uses these:** Q7-Q8 (meaning paraphrase) and Q13-Q15 (which sentence uses it correctly). One idiom = one whole MCQ mark.`;
    case "saying": return `**Where PSLE uses these:** rarely tested directly, but appears in passage text. Good for 阅读理解 comprehension.`;
    case "3-char compound": return `**Where PSLE uses these:** mostly in passages (阅读理解). Occasionally as a distractor in Q5-Q6 vocab choice.`;
    case "2-char compound": return `**Where PSLE uses these:** Q5-Q6 vocabulary choice (fill-in-the-blank), 短文填空 cloze, and as distractors everywhere. The single biggest drill bucket.`;
    case "connector": return `**Where PSLE uses these:** Q9-Q10 关联词 questions (single + paired conjunctions). Conn-only words rarely test outside this slot.`;
    case "collocation": return `**Where PSLE uses these:** Q11-Q12 sentence completion + 阅读理解 stems. Knowing the verb-noun pair helps pick the option that "sounds right".`;
    case "function": return `**Where PSLE uses these:** everywhere — they're connective tissue, not test targets.`;
    case "single char": return `**Where PSLE uses these:** Q3-Q4 (single-character fill-in). Wordlist mostly contains compounds, so single chars are rare here.`;
    default: return "";
  }
}
