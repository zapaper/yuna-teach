// Step 1: Re-rank the 730 P5+P6 candidates into Tier 1 (high-confidence
// PSLE-shape) vs Tier 2 (broader exposure). Tier 1 = words that look
// like PSLE Q5-Q8 correct answers in terms of register / abstractness /
// topic. Use the actual past PSLE correct answers as anchors.
//
// Step 2: Generate two Word documents:
//   a) "PSLE 华文词汇学习卡 (Tier 1 — 必背).docx" — PSLE history (125) +
//      Tier 1 candidates (~200). Compact, printable.
//   b) "PSLE 华文词汇学习卡 (Tier 2 — 拓展).docx" — Tier 2 candidates
//      (~530). Optional extra study.

import * as fs from "fs";
import * as path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType, BorderStyle, ShadingType,
} from "docx";

type Entry = {
  word: string;
  chars: number;
  category: "2字词语" | "成语" | "关联词" | "短文填空" | string;
  source: "PSLE" | "P5" | "P6" | "P5+P6" | string;
  psleHistory?: string[];
  pinyin?: string;
  meaningZh?: string;
  meaningEn?: string;
  sample1?: string;
  sample2?: string;
  tier?: 1 | 2;
};

(async () => {
  const jsonPath = path.join(__dirname, "psle-chinese-study-bank.json");
  const bank = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Entry[];

  const pslePast = bank.filter(e => e.source === "PSLE");
  const candidates = bank.filter(e => e.source !== "PSLE");

  // PSLE Q5-Q6 correct answers (as anchor for what Tier 1 should look like)
  const anchors2char = ["陶醉", "贡献", "遵守", "充足", "保护", "解释", "支持", "讨论", "抱怨", "妒忌", "后悔", "迅速"];
  const anchors4char = ["恍然大悟", "垂头丧气", "津津有味", "目不转睛", "神机妙算", "一言为定", "左思右想", "不慌不忙"];

  // ─── Tier-1 ranking via Gemini ────────────────────────────────────
  // Show Gemini the PSLE anchors + ask which candidates are closest in
  // shape (abstractness, register, topic). Yes/no binary.
  console.log(`Ranking ${candidates.length} candidates into Tier 1 / Tier 2...`);

  async function tier1Batch(words: Entry[]): Promise<Record<string, "1" | "2">> {
    const prompt = `你是新加坡 PSLE 华文老师。下面是 6 年 PSLE Q5-Q15 真考过的"正确答案"，作为参考:
- 2字词语 (Q5-Q6 / Q13-Q15): ${anchors2char.join("、")}
- 4字成语 (Q7-Q8 / Q13-Q15): ${anchors4char.join("、")}

这些正确答案有什么共同点：
1. 描述抽象的情感、动作、态度、状态 (不是具体名词)
2. 难度刚好在 P5-P6 水平 (不是 P3 太简单，不是初中太难)
3. 在日常生活 / 学校 / 家庭场景中常用

现在我给你一批候选词，请按上面 3 个标准评分。
- Tier 1 = 这个词的"形状"和 PSLE 真题的正确答案高度相似，下一年很可能考。
- Tier 2 = 仍是有价值的词，但和 PSLE 真题风格匹配度较低 (可能太基础、太书面、或概念太具体)。

返回 JSON: { "<词>": "1" | "2" }，每个词都要有判断。

候选词:
${words.map(w => `- ${w.word} (${w.category}${w.meaningZh ? `: ${w.meaningZh}` : ""})`).join("\n")}`;

    const res = await generateContentWithRetry({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", temperature: 0.1 },
    }, 1, 2000, "tier-rank");
    const text = (res.text ?? "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    try { return JSON.parse(m ? m[0] : text); } catch { return {}; }
  }

  const BATCH = 25;
  const tierMap: Record<string, "1" | "2"> = {};
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    try {
      const out = await tier1Batch(batch);
      Object.assign(tierMap, out);
      process.stdout.write(`  ${Math.min(i + BATCH, candidates.length)}/${candidates.length}\r`);
    } catch (err) {
      console.error(`  batch ${i} failed:`, (err as Error).message);
    }
  }
  console.log();

  for (const e of candidates) {
    e.tier = tierMap[e.word] === "1" ? 1 : 2;
  }
  // PSLE history is implicitly Tier 1 (it's gold)
  for (const e of pslePast) e.tier = 1;

  const tier1 = bank.filter(e => e.tier === 1);
  const tier2 = bank.filter(e => e.tier === 2);
  console.log(`\nTier 1 (PSLE + matched candidates): ${tier1.length}`);
  console.log(`Tier 2 (broader exposure): ${tier2.length}`);

  // Save back with tier tags
  fs.writeFileSync(jsonPath, JSON.stringify(bank, null, 2), "utf8");

  // ─── Build Word doc helpers ───────────────────────────────────────
  function headerRow(): TableRow {
    return new TableRow({
      tableHeader: true,
      children: ["词", "拼音", "中文意思", "English", "例句 1", "例句 2", "来源"].map(t =>
        new TableCell({
          shading: { type: ShadingType.SOLID, color: "DDDDDD" },
          children: [new Paragraph({ children: [new TextRun({ text: t, bold: true })] })],
        })
      ),
    });
  }
  function entryRow(e: Entry): TableRow {
    return new TableRow({
      children: [
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: e.word, bold: true, size: 24 })] })] }),
        new TableCell({ children: [new Paragraph(e.pinyin ?? "—")] }),
        new TableCell({ children: [new Paragraph(e.meaningZh ?? "—")] }),
        new TableCell({ children: [new Paragraph(e.meaningEn ?? "—")] }),
        new TableCell({ children: [new Paragraph(e.sample1 ?? "—")] }),
        new TableCell({ children: [new Paragraph(e.sample2 ?? "—")] }),
        new TableCell({ children: [new Paragraph(e.source === "PSLE" ? "🏆" : `📘 ${e.source}`)] }),
      ],
    });
  }

  function buildSectionTable(entries: Entry[]): Table {
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [headerRow(), ...entries.map(entryRow)],
    });
  }

  function buildDoc(title: string, intro: string, sections: Array<{ title: string; note: string; entries: Entry[] }>): Document {
    const children: (Paragraph | Table)[] = [];
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(title)] }));
    children.push(new Paragraph(intro));
    for (const s of sections) {
      if (s.entries.length === 0) continue;
      children.push(new Paragraph({ children: [new TextRun("")] }));
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(`${s.title} (${s.entries.length} 个)`)] }));
      children.push(new Paragraph({ children: [new TextRun({ text: s.note, italics: true, size: 18 })] }));
      children.push(buildSectionTable(s.entries));
    }
    return new Document({ sections: [{ children }] });
  }

  // ─── Tier 1 doc ──────────────────────────────────────────────────
  const t1Sections = [
    { title: "一、二字词语 (Q5-Q6 / Q13-Q15 风格)", note: "考的是抽象动词、形容词、情感动作词。这一类最容易丢分。", entries: tier1.filter(e => e.category === "2字词语") },
    { title: "二、四字成语 (Q7-Q8 风格)", note: "考的是成语的真正意思 (不是字面意思)。背的时候要连\"用在什么场景\"一起记。", entries: tier1.filter(e => e.category === "成语") },
    { title: "三、关联词 (Q9-Q10)", note: "数量少，但每年都考。务必全部背熟。", entries: tier1.filter(e => e.category === "关联词") },
    { title: "四、短文填空高频词 (Q16-Q20)", note: "短文填空的正确答案。这些词每年都换，但风格类似。", entries: tier1.filter(e => e.category === "短文填空") },
  ];
  const t1Doc = buildDoc(
    "PSLE 华文词汇学习卡 — Tier 1 (必背)",
    `把这本带回家，让孩子每天背 10-15 个，每周复习一次。
来源：🏆 PSLE 真题归纳 (6 年) + 📘 P5/P6 词语单中最匹配 PSLE 风格的核心词。
共 ${tier1.length} 个词。`,
    t1Sections
  );

  // ─── Tier 2 doc ──────────────────────────────────────────────────
  const t2Sections = [
    { title: "一、二字词语 (扩展)", note: "属于 P5/P6 词语单里有价值但不是 PSLE 主流风格的词。学有余力时再背。", entries: tier2.filter(e => e.category === "2字词语") },
    { title: "二、四字成语 (扩展)", note: "P5/P6 词语单里的其他成语。能多认识总没坏处。", entries: tier2.filter(e => e.category === "成语") },
    { title: "三、关联词 (扩展)", note: "其他可能出现的关联词。", entries: tier2.filter(e => e.category === "关联词") },
    { title: "四、短文填空高频词 (扩展)", note: "扩展词汇。", entries: tier2.filter(e => e.category === "短文填空") },
  ];
  const t2Doc = buildDoc(
    "PSLE 华文词汇学习卡 — Tier 2 (拓展)",
    `这本是学有余力时的拓展词库。先把 Tier 1 (必背) 背好，再来看这本。
共 ${tier2.length} 个词。`,
    t2Sections
  );

  // ─── Export ──────────────────────────────────────────────────────
  const outDir = path.join(__dirname, "..", "..", "documents");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const t1Path = path.join(outDir, "PSLE 华文词汇学习卡 (Tier 1 — 必背).docx");
  const t2Path = path.join(outDir, "PSLE 华文词汇学习卡 (Tier 2 — 拓展).docx");
  fs.writeFileSync(t1Path, await Packer.toBuffer(t1Doc));
  fs.writeFileSync(t2Path, await Packer.toBuffer(t2Doc));
  console.log(`\nWrote ${t1Path} (${tier1.length} entries)`);
  console.log(`Wrote ${t2Path} (${tier2.length} entries)`);
})();
