// Chinese composition marker — admin-side pipeline.
//
// One entry point: `analyseCompoAttempt(attemptId)`. It runs the four
// pipeline stages in order, persisting partial results so a re-run
// can resume:
//   1. OCR     — read the scanned composition (and the question
//                scan if provided) into clean text.
//   2. Wrong words — flag stroke errors, meaning errors, and
//                near-synonym misuses.
//   3. Critique — score against the PSLE 40-mark rubric
//                (内容 20 / Vocabulary & Phrases 10 / Sentence
//                Structure & Organization 10), benchmarked against
//                the 10 years of model essays in
//                ChineseSupplementaryPaper.
//   4. Recommend — structural pieces missing + 3-5 language
//                upgrades drawn from the playbook (universal
//                openings / closings + theme-specific banks).
//
// Best model for Chinese text: gemini-3.1-pro-preview. We pin to it
// and let the existing fallback chain (in gemini.ts) cover transient
// flakiness — same chain marking uses.

import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/db";
import { generateContentWithRetry } from "@/lib/gemini";
import playbookJson from "@/data/chinese-compo/playbook.json";
import featuredJson from "@/data/chinese-compo/featured.json";
import extendedJson from "@/data/chinese-compo/extended-highlights.json";
import sentencesJson from "@/data/chinese-compo/sentences.json";
import phrasesJson from "@/data/chinese-compo/phrases.json";

// Robust JSON extraction. Gemini occasionally appends a stray trailing
// paragraph after the JSON object — e.g. a model essay snippet or a
// "希望对你有帮助" sign-off — which trips `JSON.parse` with
// "Unexpected non-whitespace character after JSON at position N".
// We slice only the balanced outer object / array.
function extractJson(raw: string): string {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  const braceAt = cleaned.indexOf("{");
  const bracketAt = cleaned.indexOf("[");
  const start =
    braceAt < 0 ? bracketAt :
    bracketAt < 0 ? braceAt :
    Math.min(braceAt, bracketAt);
  if (start < 0) return cleaned;
  const open = cleaned[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return cleaned;
}

// Repair common Gemini JSON malformations that trip strict JSON.parse:
//   - missing commas between adjacent properties or array elements
//     (most common — e.g. `"a": "x"\n  "b": "y"` instead of `"a": "x",`)
//   - trailing commas before } or ]
//   - smart/full-width quotes inserted around CJK strings
// The walker operates OUTSIDE of strings by tracking the open/close
// state BEFORE consuming each character — opening `"` is reached from
// outside a string and closing `"` is reached from inside, so a single
// `stateBefore[i]` boolean disambiguates them.
function repairJson(s: string): string {
  // 1. Normalize curly quotes to straight ASCII quotes. Gemini sometimes
  //    emits "…" or '…' when generating Chinese-mixed JSON.
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  // 1b. Escape unescaped newlines / tabs / carriage returns INSIDE
  //     strings. Gemini occasionally writes a real "\n" line break
  //     in a multi-paragraph "reason" / "essay" / "draft" field —
  //     V8's parser sees the newline as ending the string prematurely
  //     and then either bails ("Unterminated string") or, more
  //     insidiously, succeeds at re-anchoring on a structural char
  //     and crashes a few elements later with a confusing position.
  //     Walk the text, track open/close, and rewrite any control
  //     char between quotes into its escape form.
  {
    let open = false;
    let escaped = false;
    const out: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (open && !escaped) {
        if (c === "\n") { out.push("\\n"); continue; }
        if (c === "\r") { out.push("\\r"); continue; }
        if (c === "\t") { out.push("\\t"); continue; }
      }
      out.push(c);
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === '"') open = !open;
    }
    s = out.join("");
  }

  // 2. For every char, was the parser INSIDE a string before consuming it?
  function buildStateBefore(str: string): boolean[] {
    const sb: boolean[] = new Array(str.length);
    let open = false;
    let escaped = false;
    for (let i = 0; i < str.length; i++) {
      sb[i] = open;
      const c = str[i];
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === '"') open = !open;
    }
    return sb;
  }

  // 3. Strip trailing commas before `}` or `]` (only when outside strings).
  let sb = buildStateBefore(s);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "," && !sb[i]) {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (j < s.length && (s[j] === "}" || s[j] === "]") && !sb[j]) continue;
    }
    out += s[i];
  }
  s = out;

  // 4. Insert missing commas between a value-end and the next value
  //    start. Covers both:
  //      - object property pairs:   `"a": 1\n  "b": 2` → insert comma
  //      - array element pairs:     `}\n  {`, `1\n  2`, `"a"\n  "b"`
  //    State-before-consuming model disambiguates opening vs closing
  //    `"`:
  //      - closing `"` of a string value:  stateBefore[i] = true
  //      - opening `"` of next key/value:  stateBefore[j] = false
  sb = buildStateBefore(s);
  // Value-end chars (outside strings): closing of string / object / array,
  // last digit of a number, `e` (end of true/false), `l` (end of null).
  const isValueEnd = (i: number) => {
    const c = s[i];
    if (c === '"') return sb[i];           // closing quote
    if (c === '}' || c === ']') return !sb[i];
    if (/[0-9]/.test(c) || c === "e" || c === "l") return !sb[i];
    return false;
  };
  // Value-start chars (outside strings): opening of string / object /
  // array, sign or first digit of number, first letter of true/false/null.
  // Note: previous version only accepted `"`, `{`, `[`, which silently
  // skipped missing commas between array elements that were
  // numbers/literals (and an over-restrictive `":"` peek dropped
  // missing commas between string-array elements too). Both gaps caused
  // the wrong-words array Gemini occasionally emits to fail repair.
  const isValueStart = (j: number) => {
    if (j >= s.length) return false;
    if (sb[j]) return false;
    const c = s[j];
    return c === '"' || c === '{' || c === '['
      || c === '-' || /[0-9]/.test(c)
      || c === "t" || c === "f" || c === "n";
  };

  out = "";
  for (let i = 0; i < s.length; i++) {
    out += s[i];
    if (!isValueEnd(i)) continue;
    let j = i + 1;
    while (j < s.length && /\s/.test(s[j])) j++;
    if (!isValueStart(j)) continue;
    // Must have whitespace between value-end and value-start — guards
    // legitimate `{"a":1,"b":2}` / `[1,2]` from spurious commas.
    if (j === i + 1) continue;
    out += ",";
  }

  // 5. Balanced-close pass — handles Gemini truncation at the model's
  //    max-output-tokens limit. Walk the string tracking the bracket
  //    stack + string-open state; if anything is unclosed at the end,
  //    close it. Specifically handles:
  //      - response cut mid-string  → close the quote
  //      - response cut after `:`   → insert null
  //      - dangling trailing comma  → strip
  //      - unclosed { [             → pop the stack in LIFO order
  //    Means a 1-byte truncation (most common: missing outer `}`) still
  //    parses with all the fields intact. Larger truncations lose the
  //    cut-off tail but recover everything that did make it through.
  return closeUnbalanced(out);
}

// Last-resort repair: produce a structurally-balanced JSON document
// from a string that may have been truncated mid-response. See step 5
// in repairJson for the cases handled.
function closeUnbalanced(s: string): string {
  const stack: ("{" | "[")[] = [];
  let inStr = false;
  let escaped = false;
  let openStringAt = -1; // index where the most recent string was opened
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (c === '"') {
      if (!inStr) openStringAt = i;
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      const expect = c === "}" ? "{" : "[";
      if (stack[stack.length - 1] === expect) stack.pop();
    }
  }
  if (!inStr && stack.length === 0) return s;
  let out = s;
  // Close any unterminated string. If the open quote was at a KEY
  // position (right after `{` or `,` inside an object), also insert
  // `:null` so the property has a value — otherwise we'd produce
  // `{"foo":"bar","baz"}` which still doesn't parse.
  if (inStr) {
    let j = openStringAt - 1;
    while (j >= 0 && /\s/.test(s[j])) j--;
    const prev = j >= 0 ? s[j] : "";
    const stackTop = stack[stack.length - 1];
    const isKeyPosition = stackTop === "{" && (prev === "{" || prev === ",");
    out += isKeyPosition ? '":null' : '"';
  }
  // Strip trailing whitespace + dangling commas before closing structure.
  out = out.replace(/\s+$/, "");
  while (out.endsWith(",")) out = out.slice(0, -1).replace(/\s+$/, "");
  // Cut off right after a key+colon ("foo":) — append null so the
  // property has a value before we close.
  if (out.endsWith(":")) out += "null";
  // Now close brackets LIFO.
  while (stack.length > 0) {
    const top = stack.pop();
    out += top === "{" ? "}" : "]";
  }
  return out;
}

// Tries JSON.parse on the extracted text. On failure, runs a repair
// pass for common Gemini malformations and retries. Throws the original
// error if both attempts fail — so the failure message still points at
// the real malformation, not the (potentially mangled) repaired version.
// Returns `any` to match the original `JSON.parse(...)` ergonomics —
// call sites do their own field-by-field validation downstream.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function safeJsonParse(raw: string, label = "json"): any {
  const cleaned = extractJson(raw);
  try {
    return JSON.parse(cleaned);
  } catch (err1) {
    try {
      const repaired = repairJson(cleaned);
      const out = JSON.parse(repaired);
      console.warn(`[compo:${label}] JSON repaired — original parse failed (${(err1 as Error).message}), repaired parse succeeded.`);
      return out;
    } catch {
      throw err1;
    }
  }
}

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
export const COMPO_DIR = path.join(VOLUME_PATH, "compo");

const OCR_MODEL = "gemini-3.1-pro-preview";
const ANALYSIS_MODEL = "gemini-3.1-pro-preview";

type PlaybookBucket = "opening" | "closing" | "accident" | "careless" |
  "transition" | "emotion" | "scenery" | "action" | "moral" | "other";

export type WrongWord = {
  original: string;
  suggestion: string;
  kind: "stroke" | "meaning" | "misuse" | "omission" | "awkward";
  reason: string;
};

// One full PSLE-style rubric breakdown (3 axes + total + why).
// Used for the as-submitted critique, the clean-rewrite projection,
// and the elevated-draft self-assessment so the UI can swap which
// breakdown is shown based on the active composition view.
export type RubricBreakdown = {
  contentScore: number;        // 0..20
  contentNotes: string;
  contentNotesEn: string;
  vocabScore: number;          // 0..10
  vocabNotes: string;
  vocabNotesEn: string;
  sentenceScore: number;       // 0..10
  sentenceNotes: string;
  sentenceNotesEn: string;
  overallScore: number;        // sum of the three
  // What changed from the as-submitted score — 1-2 sentences each.
  // Empty for the original critique (no delta to explain).
  whyChanged?: string;
  whyChangedEn?: string;
};

export type Critique = RubricBreakdown & {
  // Original-only fields.
  overallSummary: string;
  overallSummaryEn: string;
  // Clean rewrite = same essay with only wrong-word / omission fixes
  // applied. Full rubric breakdown so the side panel can swap when
  // the user toggles the Clean view.
  cleanRewrite?: RubricBreakdown;
  // Legacy aggregate kept for older rows that pre-date cleanRewrite.
  cleanRewriteScore?: number;
  benchmarkYears: string[];
};

export type Recommendations = {
  structural: Array<{
    piece: string;
    pieceEn: string;
    issue: string;
    issueEn: string;
    suggestion: string;
    suggestionEn: string;
    exampleFromModel?: { year: string; snippet: string; bucket: string };
  }>;
  language: Array<{
    phraseCn: string;
    phraseEn?: string;
    fromYear?: string;
    bucket: PlaybookBucket | string;
    whyItHelps: string;
  }>;
  // Stage 5 output — a 35-40-range rewrite anchored to the kid's
  // original draft. Plot is kept; surgical upgrades only (wrong-word
  // fixes, idiom + 好句 substitutions, opening hook, transitions,
  // climax intensification, ending moral).
  elevatedDraft?: string;
  elevatedDraftScore?: number; // self-assessed score of the elevated draft (legacy aggregate)
  // Full rubric breakdown for the elevated draft, so the side panel
  // can swap to it when the user is viewing the Elevated tab.
  elevatedDraftRubric?: RubricBreakdown;
  // Context-fit phrase alternatives — one entry per substitutable
  // phrase tagged in the elevated draft. The detail page renders each
  // tagged phrase as a clickable span; clicking opens a popup with
  // the current phrase's English meaning + this dropdown.
  elevatedDraftSwaps?: PhraseSwap[];
};

export type PhraseSwap = {
  // Exact text wrapped in [+...+] inside the draft. Used as the
  // lookup key when the user clicks a span.
  originalText: string;
  // What kind of phrase: opening | closing | moral | transition |
  // accident | careless | idiom | description | connector | other.
  bucket: string;
  // Sub-type within the bucket (e.g. '天气/景物开头' / '时间紧接' /
  // '心理描写'). Surface in the popup so the admin sees what flavour
  // they're swapping within. Empty when the AI couldn't classify.
  subType?: string;
  // Short English meaning of the CURRENT phrase.
  originalEn: string;
  // 2-4 alternatives that ALSO fit this essay's specific situation.
  // pattern is optional and used mainly by the `sentence` bucket so the
  // popup can label each alternative with the rhetorical device it uses
  // (比喻句 / 排比句 / 反问句 / 感叹句 / 对比句 / 倒装句). Other buckets
  // can omit it.
  alternatives: Array<{ cn: string; en: string; pattern?: string }>;
};

// ─── OCR ─────────────────────────────────────────────────────────────

// Safety-net post-pass for the most common OCR misread:
// handwritten 了 → '3'. Even with the prompt's screaming about this,
// Gemini still ships an essay with stray '3' in 了 positions. Only
// rewrites in contexts that are statistically unambiguous, so a real
// digit '3' in a quantifier or multi-digit context can't be touched:
//
//   ✓ rewrite: (CJK)3(CJK-not-quantifier | sentence-end punctuation)
//   ✗ keep:    after a digit (multi-digit number)
//   ✗ keep:    before a quantifier (个 / 只 / 人 / 天 / 元 / etc.)
//
// Logs the count of substitutions so an admin can spot when this
// safety net is overfitting and tighten the regex.
const QUANTIFIERS = "个只人天元分岁年月点时秒次本张片块条段步岁号位条棵把件双只匹群队组层次种类米厘公千吨";
function fixHandwriting3ToLe(text: string): string {
  if (!text) return text;
  // (?<=CJK) digit '3' (?=CJK-not-quantifier | sentence punct | line end)
  const re = new RegExp(
    `(?<=[\\u4e00-\\u9fff])3(?=[\\u4e00-\\u9fff，。！？、；：""''「」、]|\\s*$|\\s*\\n)`,
    "gu",
  );
  // First pass — gather candidate indices so we can apply a quantifier
  // look-ahead negative-filter ourselves (lookbehind+lookahead-with-set
  // doesn't compose cleanly in JS regex).
  let out = text;
  let removed = 0;
  out = out.replace(re, (_match, offset: number, full: string) => {
    const next = full[offset + 1] ?? "";
    if (QUANTIFIERS.includes(next)) return "3"; // "3个", "3只" → keep
    removed++;
    return "了";
  });
  if (removed > 0) {
    console.log(`[compo:ocr] safety-net replaced ${removed} handwriting '3' → '了' (post-pass)`);
  }
  return out;
}

async function readFileForGemini(relPath: string): Promise<{ data: string; mimeType: string }> {
  const abs = path.join(COMPO_DIR, relPath);
  const buf = await fs.readFile(abs);
  const ext = path.extname(relPath).toLowerCase();
  // Gemini inlineData accepts image/* AND application/pdf. A user can
  // upload either a multi-page PDF (single file) or one image per page.
  const mimeType =
    ext === ".pdf"  ? "application/pdf" :
    ext === ".png"  ? "image/png"       :
    ext === ".webp" ? "image/webp"      :
                      "image/jpeg";
  return { data: buf.toString("base64"), mimeType };
}

// For text-bearing formats (.txt / .docx), pull plain text directly
// so the OCR Gemini call can be skipped. .docx uses mammoth (handles
// modern Word; older .doc not supported — kid would need to convert).
async function readTextDirectly(relPath: string): Promise<string | null> {
  const abs = path.join(COMPO_DIR, relPath);
  const ext = path.extname(relPath).toLowerCase();
  if (ext === ".txt") {
    return (await fs.readFile(abs, "utf8")).trim();
  }
  if (ext === ".docx") {
    const mammoth = (await import("mammoth")) as unknown as {
      extractRawText: (opts: { path: string }) => Promise<{ value: string }>;
    };
    const { value } = await mammoth.extractRawText({ path: abs });
    return value.trim();
  }
  return null;
}

const OCR_PROMPT_BODY = `你正在从扫描的手写小学华文作文页面中提取文字。

🚨🚨🚨 第一优先级 — "3" 几乎一定是 "了" 🚨🚨🚨
小学手写体的 "了" 字 (尤其在句尾) 经常被 OCR 看成数字 "3"。这是 **最常见、最严重** 的错误。

【硬性规则】 — 输出 essay 字段前，必须执行以下扫描:
1. 找出 essay 里每一个数字 "3"。
2. 对每一个 "3" 自问: 它的前一个字是中文吗？后面是中文 / 标点 (，。！？)、或行尾吗？
3. 如果是，**几乎可以肯定是 "了"** — 不要犹豫，直接改成 "了"。
4. 只有在以下情况才保留数字 "3":
   · "3" 后面紧跟量词 (个 / 只 / 人 / 天 / 元 / 分 / 岁 / 年 / 月 / 点 / 小时 / 公斤 / 等等)
   · "3" 是多位数字的一部分 (13, 23, 30, 31, 等)
   · "3" 出现在明显的数字上下文中 (例 "13岁", "第3名")

【典型例子】
- "他走3。"           → "他走了。"       ✓ 改
- "妈妈笑3！"         → "妈妈笑了！"     ✓ 改
- "我吃3，"           → "我吃了，"       ✓ 改
- "她哭3起来。"       → "她哭了起来。"   ✓ 改 (3 后面不是量词)
- "我吃了3个苹果。"   → 保留 (3 后面是量词 "个")  ✗ 不改
- "他13岁。"          → 保留 (多位数字)            ✗ 不改

完成扫描后再写 JSON。

【任务】输出严格的 JSON:
{
  "essay": "<学生手写作文正文，按段落顺序转录成简体中文，段落之间用空行分隔。看不清的字用 [?] 标注。错别字保留不要改。>",
  "detectedQuestion": {
    "title":   "<如果页面上印有题目 (例如 '题目一: 一件让我难忘的事' / '这件事让我明白了…')，写出来。没有就空字串。>",
    "pictures":["<如果页面上印有看图作文的图片，逐图简短描述 (1-2 句中文)。没有就空数组。>"]
  }
}

【转录规则】
0. **学生的行间插入 — 必须捕捉**:
   小学生发现漏字后，常用以下方式补字:
   · 在格子上方空白处写一个或几个字
   · 用 ↑ 箭头、^ 倒插符、或一根细线指向插入位置
   · 偶尔在格子下方补字
   你必须把这些插入字 **直接放入正文** 在它应该插入的位置 (跟着箭头 / 插入符指向的位置)。不要忽略它们。
   例如: 格子里写 "明杰兴勃勃地玩" + 上方写 "致" + 箭头指向 "兴" 和 "勃" 之间 → 转录为 "明杰兴致勃勃地玩"。
   插入字也会有错字 (例如学生把 "致" 写成 "至") — 按学生写的样子转录，不要纠正。

0a. **学生划掉的字 — 必须跳过 (不转录)**:
   学生写错字常用以下方式删除:
   · 在字上画一个或多个斜线 (/, \, ✗, ✕)
   · 在字上画横线、竖线、或叉叉
   · 把整个字涂黑 / 圈住后再划掉
   · 用波浪线在字上方做删除标记
   这些被划掉的字 **绝对不要转录**。学生的意图是删除，你应该当它不存在。
   例如: 格子写 "女生憋气得火冒三丈" 但 "气" 上有斜线 (学生划掉它) → 转录为 "女生憋得火冒三丈" (跳过 "气")。
   注意区分: 老师用红笔在字上划掉是另一回事 (见 STRIP_MARKINGS_INSTRUCTION 的规则)。这里说的是学生本人用黑/蓝/铅笔在字上做的删除痕迹。
   特别警示: 即使被划掉的字本身看起来通顺、能形成一个词，也不要保留它。学生选择删掉就是删掉了。
1. 标点符号 (，。！？""''「」《》) 保留并用全角。
2. **段落分隔 — 非常重要**:
   · 学生作文每一段开头通常会缩进两格 (有的写两个全角空格，有的留出明显空隙)。看到缩进、空白行、或者一段意思明显结束、新段开始的视觉信号，都要把段落分开。
   · 段落之间必须输出 **一个空行** (即 \\n\\n)。不是 \\n，是 \\n\\n。
   · 在 JSON 中写成 \`"essay": "第一段。\\n\\n第二段。\\n\\n第三段。"\` — 每段之间双换行。
   · 即使页面上的缩进不明显，看到 4-6 句话结束 + 新话题/场景开始也应该分段。一篇 5 段的作文不要塞成一大段。
   · **如果你只输出一段，几乎可以肯定是错的** — 小学作文很少只有 1 段。典型 PSLE 作文有 4-6 段。
3. **完整性 — 必须转录到最后一个字**:
   · 不要在中间停下。从作文第一句到最后一句，每一段都要转录。
   · 学生作文的最后一段经常是反思 / 道理 / 结尾点题，**绝对不能漏**。
   · 在你输出 JSON 前，自己心里检查一遍: 我有没有写到学生最后一个字？最后一段的标点 (通常是。) 有没有？如果没有，回去补上。
   · 如果你看不清最后一段 (扫描质量差 / 被裁掉)，仍然要尽力转录，看不清的字用 [?] 标注 — 而不是直接省略整段。
4. 不要加 "学生写道:" 这类元信息。
5. 不要纠正错别字 — 错字必须保留 (后续步骤会处理)。
6. 不要补充学生没写的字。

【手写常见误读 — 必查】
小学生手写体中，这些容易被 OCR 看错:
- **"3" → "了"**: 句末或动词后的 "3" 几乎一定是 "了"。例 "他走3" → "他走了"。
- "1" / "l" / "I" → "一"
- "0" → "口" 或 "○"
- 中文夹杂的孤立拉丁字母通常是误读，回去再看一次原图。

字形相近的汉字 (按上下文判断):
- 已/己/巳, 末/未, 戍/戌/戊, 干/千/于, 八/入/人, 太/大/犬, 自/白, 日/目, 土/士

【题目检测说明】
- 印刷字体 (规整的方块字 / 印刷宋体) 通常是题目，手写字体 (笔画风格自然的) 是学生答案。
- 看图作文的图片如果出现在页面上，逐图描述 (人物动作 / 场景 / 表情)。
- 如果是纯学生作文页面 (没有印刷题目和图片)，title 和 pictures 留空 / 空数组。

不要 markdown 包围。`;

// Appended to OCR_PROMPT_BODY when the admin checked
// 'remove red/green markings'. Tells Gemini to transcribe the
// student's ORIGINAL handwriting only, treating red / green pen
// strokes (which are typically the teacher's corrections,
// additions, and crossings-out) as if they weren't there.
const STRIP_MARKINGS_INSTRUCTION = `

🚨 重要 — **忽略红色和绿色批改痕迹**
本扫描包含老师用红笔 / 绿笔做的批改 (划掉、改字、加字、圈起来等)。请按以下规则:

1. **完全忽略** 红色 / 绿色的笔记 — 当作不存在。
2. 只转录 **学生用黑笔 / 铅笔 / 蓝笔写的原文**。
3. 即使学生原文有错字、漏字 — 也要原原本本写出来 (后续步骤会找错)。**不要按老师批改后的版本写**。
4. 老师圈起来的字、划掉的字 — 仍然按学生当初写的样子转录。
5. 老师补加的字 — 不要转录。

【举例】
学生原文: "我吃饭3。" (这里 "3" 是错字，应该是 "了")
老师在 "3" 上划掉，旁边加了红色 "了"。
你应该输出: "我吃饭3。" (保留学生原写的 3，不要写 "了")。后续步骤会自动检测这是 "了" 被误写成了 "3"。
`;

const OCR_WITH_MARKINGS_PROMPT = `你正在从扫描的小学华文作文中提取文字 — **包括** 老师的批改痕迹。

【任务】输出严格的 JSON: { "essay": "<...>" }

【规则】
1. 按段落顺序转录所有可见文字 — **包括学生原文和老师批改**。
2. 学生原文用普通字体直接写出。
3. **老师的批改用 markdown 标注**:
   · 老师划掉的字 / 词 / 句子 — 用 ~~删除线~~ 包起来，例: "我吃饭~~3~~了。"
   · 老师加上的字 / 词 / 句子 — 用 **粗体** 包起来，例: "**那天**早上我吃饭了。"
   · 老师在旁边写的评语 — 放在段落末尾，用方括号包起来，例: "我吃饭了。[老师评: 用词得当]"
4. 标点符号用全角 (，。！？)。段落间用空行分隔。
5. 不要省略任何老师改的内容 — 重点就是要看老师改了什么。
6. 如果某处看不清，用 [?] 标记。

只输出 JSON，不要 markdown 包围、不要解释。`;

const OCR_QUESTION_PROMPT_BODY = `你正在从扫描的小学华文 PSLE Paper 1 写作题目中提取信息。

【任务】
转录题目说明、所有题目选项的标题、以及（如果有的话）看图作文的图片提示词。

输出格式（纯文本）：
说明：<说明全文>

题目一：<标题>
题目二：<标题>
（若有更多题目继续列出）

看图作文图片提示词：
- <提示词1>
- <提示词2>
...

如果某些信息缺失，直接省略对应的段落，不要写 "无" 或 "N/A"。只输出转录文本，不要 markdown 包围。`;

export async function runOcr(
  compositionImagePaths: string[],
  questionImagePath: string | null,
  // Admin "remove red/green markings" path. When true, runOcr makes
  // TWO Gemini calls on the composition pages: one verbatim (so the
  // admin can see what the teacher wrote in red / green), one with a
  // prompt that ignores red/green annotations (so the wrong-word +
  // critique pipeline sees the original student text).
  compareToMarkings: boolean = false,
): Promise<{ ocrText: string; ocrTextWithMarkings: string | null; ocrQuestionText: string | null }> {
  // Fast path — if every composition file is a text-bearing format
  // (.txt or .docx), skip the OCR Gemini call entirely. The kid
  // typed the composition; there's nothing for the model to OCR.
  const textParts: string[] = [];
  let allTextOnly = compositionImagePaths.length > 0;
  for (const p of compositionImagePaths) {
    const t = await readTextDirectly(p);
    if (t === null) { allTextOnly = false; break; }
    textParts.push(t);
  }
  let ocrText: string;
  // Auto-detected question/picture content on the composition page —
  // populated by the Gemini OCR branch when the page also carries the
  // printed prompt or picture series. The dedicated questionImagePath
  // upload below (if any) overrides this.
  let detectedQuestionText: string | null = null;
  let ocrTextWithMarkings: string | null = null;
  if (allTextOnly) {
    ocrText = textParts.join("\n\n").trim();
    console.log(`[compo:ocr] text-only fast path: skipped Gemini, ${ocrText.length} chars from ${compositionImagePaths.length} file(s)`);
  } else {
    // Compose all composition pages into one Gemini call so the model
    // can stitch paragraph breaks across page boundaries AND detect
    // any printed question prompt / picture series on the same page.
    const compParts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = [];
    let totalBytes = 0;
    for (const p of compositionImagePaths) {
      const img = await readFileForGemini(p);
      totalBytes += Math.ceil(img.data.length * 0.75); // base64 -> bytes
      console.log(`[compo:ocr] read ${p} (${img.mimeType}, ~${(totalBytes / 1024).toFixed(0)}KB cumulative)`);
      compParts.push({ inlineData: img });
    }

    const cleanPromptText = compareToMarkings
      ? OCR_PROMPT_BODY + STRIP_MARKINGS_INSTRUCTION
      : OCR_PROMPT_BODY;
    const cleanCallParts = [...compParts, { text: cleanPromptText }];

    console.log(`[compo:ocr] calling ${OCR_MODEL} with ${compositionImagePaths.length} part(s), ~${(totalBytes / 1024).toFixed(0)}KB${compareToMarkings ? " (strip-markings mode)" : ""}...`);
    const ocrStart = Date.now();
    // When compareToMarkings is on, fire BOTH OCR passes in parallel:
    //   · cleanResp   — student's original text, red/green stripped.
    //   · markedResp  — verbatim transcription incl. teacher edits.
    // Otherwise just do the single clean pass.
    const cleanRespP = generateContentWithRetry({
      model: OCR_MODEL,
      contents: [{ role: "user", parts: cleanCallParts }],
      // Long handwritten compositions can run 800-1200 Chinese chars
      // = ~2-3k tokens, plus the JSON wrapper + escaped newlines + the
      // detectedQuestion block. 8k cap was too tight — long essays
      // got truncated mid-string, JSON parse failed, raw '{ "essay":'
      // leaked into the displayed text. Bumped to 24k.
      config: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 24576 },
    }, 2, 5000, "compo-ocr");
    const markedRespP = compareToMarkings ? generateContentWithRetry({
      model: OCR_MODEL,
      contents: [{ role: "user", parts: [...compParts, { text: OCR_WITH_MARKINGS_PROMPT }] }],
      config: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 24576 },
    }, 2, 5000, "compo-ocr-with-markings") : null;

    const [ocrResp, markedResp] = await Promise.all([cleanRespP, markedRespP]);
    const ocrRaw = (ocrResp.text ?? "").trim();
    console.log(`[compo:ocr] composition done in ${((Date.now() - ocrStart) / 1000).toFixed(1)}s, ${ocrRaw.length} chars raw`);
    if (markedResp) {
      // Parse the marked-version OCR — same JSON shape, but we only
      // care about the essay field (we don't double-extract questions).
      const markedRaw = (markedResp.text ?? "").trim();
      try {
        const mp = safeJsonParse(markedRaw, "ocr-markings");
        if (typeof mp.essay === "string" && mp.essay.trim().length > 0) {
          ocrTextWithMarkings = mp.essay.trim();
        } else {
          ocrTextWithMarkings = markedRaw;
        }
      } catch {
        ocrTextWithMarkings = markedRaw;
      }
      console.log(`[compo:ocr] with-markings OCR done, ${ocrTextWithMarkings?.length ?? 0} chars`);
    }

    // Parse the structured OCR output. Fall back to treating the
    // whole response as plain essay text if JSON parsing fails.
    ocrText = ocrRaw;
    try {
      const parsed = safeJsonParse(ocrRaw, "ocr");
      if (typeof parsed.essay === "string" && parsed.essay.trim().length > 0) {
        ocrText = parsed.essay.trim();
      }
      if (parsed.detectedQuestion && typeof parsed.detectedQuestion === "object") {
        const dq = parsed.detectedQuestion as { title?: unknown; pictures?: unknown };
        const parts: string[] = [];
        if (typeof dq.title === "string" && dq.title.trim().length > 0) {
          parts.push(`题目: ${dq.title.trim()}`);
        }
        if (Array.isArray(dq.pictures)) {
          const pics = dq.pictures.filter((p): p is string => typeof p === "string" && p.trim().length > 0);
          if (pics.length > 0) {
            parts.push("看图作文图片描述:");
            pics.forEach((p, i) => parts.push(`  图 ${i + 1}: ${p.trim()}`));
          }
        }
        if (parts.length > 0) {
          detectedQuestionText = parts.join("\n");
          console.log(`[compo:ocr] auto-detected printed prompt / pictures (${detectedQuestionText.length} chars)`);
        }
      }
    } catch (err) {
      // Truncated / malformed JSON. The previous fallback dumped the
      // raw JSON wrapper into the displayed essay ('{ "essay": "..."').
      // Heuristic recovery: regex-extract just the essay field's
      // string content. We unescape \n / \" so paragraph breaks
      // survive into the displayed text.
      console.warn(`[compo:ocr] structured parse failed (${err instanceof Error ? err.message : err}); attempting essay-regex recovery from ${ocrRaw.length}-char output`);
      const essayMatch = ocrRaw.match(/"essay"\s*:\s*"([\s\S]*?)(?:"\s*,\s*"detectedQuestion"|"\s*}\s*$)/);
      const candidateBody = essayMatch?.[1];
      if (candidateBody && candidateBody.length > 50) {
        ocrText = candidateBody
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\")
          .trim();
        console.warn(`[compo:ocr] regex recovery extracted ${ocrText.length} chars from truncated JSON`);
      } else {
        // Open-quote-never-closed case: take everything after
        // "essay":" up to the last newline that looks like a
        // sentence end. Better than dumping the whole JSON wrapper.
        const openIdx = ocrRaw.indexOf('"essay"');
        if (openIdx >= 0) {
          const after = ocrRaw.slice(openIdx).replace(/^"essay"\s*:\s*"/, "");
          ocrText = after
            .replace(/\\n/g, "\n")
            .replace(/\\r/g, "")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\")
            .trim();
          console.warn(`[compo:ocr] partial recovery from open-string JSON, ${ocrText.length} chars`);
        }
      }
    }
  }

  let ocrQuestionText: string | null = detectedQuestionText;
  if (questionImagePath) {
    const img = await readFileForGemini(questionImagePath);
    console.log(`[compo:ocr] separate question scan: ${questionImagePath} (${img.mimeType})`);
    const qStart = Date.now();
    const qResp = await generateContentWithRetry({
      model: OCR_MODEL,
      contents: [{ role: "user", parts: [
        { inlineData: img },
        { text: OCR_QUESTION_PROMPT_BODY },
      ] }],
      config: { temperature: 0 },
    }, 2, 5000, "compo-ocr-question");
    const qText = (qResp.text ?? "").trim();
    console.log(`[compo:ocr] separate question done in ${((Date.now() - qStart) / 1000).toFixed(1)}s, ${qText.length} chars`);
    // Dedicated question scan always wins — it's higher fidelity
    // than picking the prompt out of a half-page above the essay.
    if (qText.length > 0) ocrQuestionText = qText;
  }

  // Final post-pass: rewrite handwriting-3-mistaken-for-了 in safe
  // contexts. Applied LAST so a fresh OCR run, the text-only
  // fast-path, and the regex-recovery fallback all benefit.
  ocrText = fixHandwriting3ToLe(ocrText);
  if (ocrTextWithMarkings) {
    ocrTextWithMarkings = fixHandwriting3ToLe(ocrTextWithMarkings);
  }
  return { ocrText, ocrTextWithMarkings, ocrQuestionText };
}

// ─── Wrong-word pass ────────────────────────────────────────────────

const WRONG_WORDS_PROMPT = (ocrText: string) => `下面是一篇小学华文作文的转录。请找出用字 / 语法 / 表达问题，分为五类：

1. **stroke (错别字)**: 写错笔画或字形，导致不是字典里的字。例 "兔" 写成 "免"，"默" 写成 "黑+口"。
   · 字形相近的常见错字必须查 — 别因为 "看起来像" 就放过：默/黑 · 已/己 · 末/未 · 戍/戌/戊 · 干/千/于 · 玻璃 (常写错璃)
2. **meaning (用词不当)**: 是真字，但意思不通顺或与上下文不符。例 "保险柜" 用在不需要保险的情境。
3. **misuse (近义词混淆)**: 是真字，但用了意思相近但更不合适的词。例 "厉害" 用成 "凶猛" 类近义词混淆。
4. **omission (漏字)**: 句子缺少一个或几个字，使得语法不通顺。例 "一天他妈妈" 应该是 "一天他的妈妈" (漏了 "的")。
   · original: 缺字句子上下文片段 (例 "他妈妈")
   · suggestion: 补齐后形式 (例 "他的妈妈")
5. **awkward (表达生硬 / 不通顺)**: 不是字典错字，每个字也都对，但中文母语者读起来感觉别扭、不自然、生造。常见类型:
   · **动宾搭配不当** — "把自己的道歉说了出来" ✗ → "向…道歉了" / "说出自己想说的道歉" ✓
   · **词语搭配不当** — "明杰接受林老师的话" ✗ (接受不能搭配"话") → "明杰听了林老师的话" / "明杰接受了林老师的建议" ✓
   · **句式生硬** — 直译式中文、外语腔
   · 这些错误不是 "可以更好" 而是 "明显别扭" — 一个母语成人读会皱眉的程度才标。
   · 重点关注: 把字句 (是否搭配自然)、动词与抽象名词的搭配 (说话 vs 说出道歉)、动宾间是否需要补语。

【两次确认 — 重要】
在列出每个错误前，先 (不输出地) 做两次确认:
- 第一次: 你的建议 (suggestion) 本身有没有错？没有错字、漏字、标点错误。
- 第二次: original 替换成 suggestion 后，整句还通顺吗？

【信心阈值 — 注意】
- stroke / omission / awkward: **比较确定 (~80%)** 就列出。这三类是最常被漏掉的，不要太保守。
- meaning / misuse: 比较主观，**95%+ 确定** 才列出。

不要标记 "风格" / "可以更好" / "建议升级" 类的纯文学性建议。
不要标记 [+ +] 标记符号 — 那是之前 AI 留下的修订标记，不是学生写的错字。

【作文】
${ocrText}

【输出格式】严格的 JSON 数组，每个错误一项：
[
  {
    "original": "学生写的原字 (或缺字句子的上下文)",
    "suggestion": "建议的正确字 (或补齐后的形式)",
    "kind": "stroke" | "meaning" | "misuse" | "omission" | "awkward",
    "reason": "一句话解释 (中文，<25 字)"
  }
]

如果没有 100% 确定的错误，返回 \`[]\`。
不要 markdown 包围。`;

export async function detectWrongWords(ocrText: string): Promise<WrongWord[]> {
  console.log(`[compo:wrong-words] scanning ${ocrText.length} chars with ${ANALYSIS_MODEL}...`);
  const start = Date.now();
  const resp = await generateContentWithRetry({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: WRONG_WORDS_PROMPT(ocrText) }] }],
    // Wrong-words returns an array of {original, suggestion, kind,
    // reason} — a heavily-corrected essay can hit 20-30 entries
    // each with a 1-2 sentence reason. Default cap risks truncating
    // the last few entries (or the closing `]`) which would lose
    // marks on the kid's lower paragraphs.
    config: { responseMimeType: "application/json", temperature: 0.1, maxOutputTokens: 8192 },
  }, 2, 5000, "compo-wrong-words");
  console.log(`[compo:wrong-words] done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  const text = (resp.text ?? "[]").trim();
  try {
    const parsed = safeJsonParse(text, "wrong-words");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(x => x && typeof x.original === "string" && typeof x.suggestion === "string")
      .map(x => ({
        original: String(x.original),
        suggestion: String(x.suggestion),
        kind: ["stroke", "meaning", "misuse", "omission", "awkward"].includes(x.kind) ? x.kind : "meaning",
        reason: String(x.reason ?? ""),
      }));
  } catch (err) {
    // Surface enough context to actually fix the malformation next time.
    // Print the surrounding ±200 chars around the V8-reported position
    // so we can see WHICH char tripped JSON.parse.
    const msg = (err as Error).message ?? "";
    const posMatch = msg.match(/position (\d+)/);
    const pos = posMatch ? parseInt(posMatch[1], 10) : -1;
    console.error("[compo] wrong-words parse failed:", err);
    if (pos >= 0) {
      const start = Math.max(0, pos - 200);
      const end = Math.min(text.length, pos + 200);
      console.error(`[compo] wrong-words raw at pos ${pos} (±200 chars):`);
      console.error(`  pre:  ${JSON.stringify(text.slice(start, pos))}`);
      console.error(`  bad:  ${JSON.stringify(text.slice(pos, pos + 1))}`);
      console.error(`  post: ${JSON.stringify(text.slice(pos + 1, end))}`);
    } else {
      console.error(`[compo] wrong-words raw (first 400 chars):`, text.slice(0, 400));
    }
    return [];
  }
}

// ─── Critique vs. PSLE 40-mark rubric ───────────────────────────────

type ModelEssay = { year: string; option: "option1" | "option2"; topic: string; essay: string };

async function loadModelEssays(optionType: string | null): Promise<ModelEssay[]> {
  const rows = await prisma.chineseSupplementaryPaper.findMany({
    where: {
      OR: [
        { compoOption1Model: { not: null } },
        { compoOption2Model: { not: null } },
      ],
    },
    select: { year: true, compoOption1Topic: true, compoOption1Model: true, compoOption2Model: true },
    orderBy: { year: "desc" },
  });
  const out: ModelEssay[] = [];
  for (const r of rows) {
    if ((optionType !== "option2") && r.compoOption1Model && r.compoOption1Topic) {
      out.push({ year: r.year, option: "option1", topic: r.compoOption1Topic, essay: r.compoOption1Model });
    }
    if ((optionType !== "option1") && r.compoOption2Model) {
      out.push({ year: r.year, option: "option2", topic: "(看图作文)", essay: r.compoOption2Model });
    }
  }
  return out;
}

const CRITIQUE_PROMPT = (
  ocrText: string,
  modelEssays: ModelEssay[],
  studentTopic: string | null,
  detectedQuestionText: string | null,
) => {
  const sample = modelEssays.slice(0, 6).map(e =>
    `=== ${e.year} ${e.option === "option1" ? "Option 1" : "Option 2"} —  ${e.topic} ===\n${e.essay}`
  ).join("\n\n");
  // If we have an explicit question/picture prompt (either the
  // admin uploaded a separate question scan, or we auto-detected it
  // on the composition page), drop in the strict on-point rule.
  const questionBlock = detectedQuestionText ? `

【题目 / 看图作文提示 (auto-detected or admin-supplied)】
${detectedQuestionText}

【题意/图意匹配 — 严格规则 (因为我们已经知道题目了)】
判断作文是否符合题目 / 图意:
- **完全离题** (作文情节、人物、地点、主题与题目 / 图意完全无关): **内容 (Content) 直接给 0 分**。在 contentNotes 里说明哪里离题。其他两轴照常评。
- **部分离题** (扣 10 分): **以下任一情况即算部分离题** (从你按其他标准给的内容分数中再减 10，下限是 0)。在 contentNotes 里**第一句**就说明 "部分离题" 并指出偏离了什么。
   (a) **主体故事方向对，但有重要情节 / 角色 / 寓意偏离题目要求** — 例如题目是 "勇敢" 但通篇没体现勇敢的行动。
   (b) **题目对作文不合适 — "题目像是后贴上去的"**。最关键的一题。
       - **判断核心**: 假设有一位读者**没看过题目**，他读完作文后，会自然觉得 "原来这篇文章就叫做《XXX》"，还是会觉得 "这个题目和文章有点对不上 / 题目太大 / 文章和题目只擦边"？后者就是部分离题。
       - 篇幅不是绝对标准 — 题目主体即使只占一小段，只要那一段是故事的**真正核心 / 高潮 / 转折点 / 寓意所在**，题目就贴合，仍算完全符合。例如题目「一个珍贵的礼物」— 礼物即使只在结尾出现，但它若是整篇故事情感的归结、寓意的载体、转折的关键 → 完全符合。
       - 反过来，若题目主体只是**顺带提及、可有可无、不影响主线**，作文真正的核心是别的东西 (例如一天的经历、一场比赛、一段友情)，那题目就是 "挂上去的"，→ 部分离题。
       - **自检法**: 把作文中所有提到题目主体的句子整段删掉，剩下的故事是否还能独立成立、依然有重心？如果还能 → 部分离题。
   (c) **看图作文缺一幅图的情节** — 算部分离题。
- **完全符合**: 题目能自然地概括作文的核心 (即使题目主体出现的篇幅不大，只要它是故事的真正重心 / 寓意 / 转折)，→ 按下面的常规打分要点评。

判断时:
- 不要因为风格不同就算离题 — 只要题目能自然概括作文的核心即可。
- 不要因为表达不够深就算离题 — 那是词汇 / 句子两轴的事，不是内容轴。
- 不要单看篇幅就判离题 — 真正的判断是 "题目是否自然贴合作文"。
- **判断顺序**: 先做 (a)(b)(c) 三项的自检；任何一项命中就标 "部分离题"，**不要因为作文写得通顺、字数够就放过**。这是 PSLE 老师扣分最常见的地方。
` : "";

  return `你是新加坡 PSLE 华文作文 (Paper 1 写作) 阅卷老师。请按 PSLE 40 分制评分学生作文。${questionBlock}

【三个评分轴】
- 内容 (Content) — 20 分: 情节完整、紧扣题意、有起承转合、感情真切、寓意 (moral/启示) 清楚。
- 词汇与好句 (Vocabulary & Phrases) — 10 分: 词汇准确、运用成语和好词好句、描写生动。
- 句子结构与组织 (Sentence Structure & Organization) — 10 分: 语法正确、段落过渡顺畅、故事流畅、代词使用清楚。

【真实分数分布 — 重要校准】
PSLE 华文作文的实际分数分布:
- 22 分以下: 弱 (主要错别字 / 情节不完整 / 离题)
- 23-26 分: 中等 (清晰但不亮眼，常 < 500 CJK)
- 27-30 分: 良好 (情节顺畅、用词正确，~500-600 CJK)
- 31-34 分: 优秀 (情节有起伏 + 2-3 个成语 / 好句 + 一些描写，~600-700 CJK)
- 35-37 分: 接近满分 / 上 5% (多个成语 + 生动描写 + 高潮 + 清楚寓意，**≥ 700 CJK**)
- 38-40 分: 极少数顶尖学生 (~750-820 CJK)

下面的范文都是 40/40 的极少数顶尖作品 (CJK 字数平均 ~730)。**不要用它们当 "及格线"**。

【字数惩罚 — 必须严格执行】
PSLE 真实 40 分范文 CJK 字数: 664 (2019), 673 (2022), 759 (2020), 819 (2016)。低于 700 字内容几乎不可能充分展开。
- < 500 CJK: 内容分上限 12-14 (满分 20)；总分上限 ~30。在 contentNotes 里说明 "字数偏少 (xxx 字)，情节展开不足"。
- 500-599 CJK: 内容分上限 14-16；总分上限 ~32。
- 600-699 CJK: 内容分上限 16-17；总分上限 ~34。
- ≥ 700 CJK: 无字数惩罚，按其他维度评分。
计算 CJK 字数: 只数中文字符 (Unicode 4E00–9FFF)，不包括标点、空格、英文字母、数字。

【打分要点】
1. 情节通顺、用词正确的小学高年级作文 → 28-30 分。
2. 加上 2-3 个成语 / 好句 + 一些描写 → 31-34 分。
3. 加上明显的高潮 + 生动描写 + 寓意点题 → 35-37 分。
4. **边界情况要往上靠**。如果犹豫是 32 还是 34，给 34。如果犹豫是 35 还是 36，给 36。
5. **看到学生明显努力 (例如多次用成语 / 加了描写句 / 有明显的开头结尾)，要给信用** — 不要因为某句不完美就拉低。
6. **不要因为 "can be better" 就扣分** — 只在真有缺陷的地方扣 (错字 / 漏字 / 情节断裂 / 语法错误)。
7. **修订标记 [+ +]**: 如果作文中出现 [+...+] 标记，那是之前 AI 留下的编辑痕迹，不算错。按 [+...+] 内的内容评分即可 (那是新加的内容)。

【对标范文 — 仅供参考写作风格】
PSLE 10 年 (2016-2025) 共 ${modelEssays.length} 篇 40/40 范文，挑了 6 篇:
${sample}

【学生作文 — 题目: ${studentTopic ?? "(未提供)"}】
${ocrText}

【评分要求】
- 以上面的范文为 40 分基准，对比学生作文找出差距。
- 评分要符合小学高年级水平 — 不要拿成年人标准，但也要诚实指出不足。
- 每个评语 (Notes) 用 1-2 个简短句子，中文，<= 60 字。
- **如果你判断 "部分离题" 或 "完全离题"**: contentNotes 的 *第一句* 必须明确写 "部分离题:" 或 "完全离题:"，然后说明哪里偏离 (例如 "部分离题: 题目是'珍贵的礼物'，但礼物只在最后一段简短出现，故事核心其实在 XX 上。")。overallSummary 也要在最开头点出 "题目契合度偏弱" 这个关键问题。

【输出格式 — 严格 JSON】每条 Notes 都需要中文 + 英文 (家长版)。
{
  "contentScore": <0-20>,
  "contentNotes": "<内容评语 - 中文短>",
  "contentNotesEn": "<content notes — short English>",
  "vocabScore": <0-10>,
  "vocabNotes": "<词汇好句评语 - 中文短>",
  "vocabNotesEn": "<vocabulary & phrases notes — short English>",
  "sentenceScore": <0-10>,
  "sentenceNotes": "<句子结构与组织评语 - 中文短>",
  "sentenceNotesEn": "<sentence structure & organization notes — short English>",
  "overallScore": <三项总和>,
  "overallSummary": "<总评 - 中文 1-2 句>",
  "overallSummaryEn": "<short overall summary in English>",
  "cleanRewrite": {
    "contentScore": <如果只修了错别字和漏字 (没改情节)，内容分会是多少。通常 +0>,
    "contentNotes": "<中文短>",
    "contentNotesEn": "<English short>",
    "vocabScore": <通常 +0 至 +0.5>,
    "vocabNotes": "<中文短>",
    "vocabNotesEn": "<English short>",
    "sentenceScore": <通常 +0.5 至 +1.5 (修标点 / 漏字 / 语法)>,
    "sentenceNotes": "<中文短>",
    "sentenceNotesEn": "<English short>",
    "overallScore": <三项总和>,
    "whyChanged": "<中文 1-2 句解释: 为什么分数有/没有提升>",
    "whyChangedEn": "<English 1-2 sentences — why the score moved (or didn't)>"
  },
  "benchmarkYears": [<参考的 PSLE 年份>]
}

不要 markdown 包围。`;
};

export async function critiqueComposition(
  ocrText: string,
  optionType: string | null,
  studentTopic: string | null,
  detectedQuestionText: string | null,
): Promise<Critique> {
  const modelEssays = await loadModelEssays(optionType);
  if (modelEssays.length === 0) throw new Error("No model essays available in DB");
  // Priority for the off-topic check's topic source:
  //   1. studentTopic (admin typed it into the "Composition topic (optional)"
  //      field — highest signal, no OCR noise)
  //   2. detectedQuestionText (OCR'd from a separate question scan OR
  //      auto-detected from the printed prompt on the composition page)
  //   3. null → off-topic check skipped entirely
  const typedTopic = (studentTopic ?? "").trim();
  const effectiveQuestionText = typedTopic.length > 0 ? typedTopic : detectedQuestionText;
  const topicSource = typedTopic.length > 0 ? "typed" : (detectedQuestionText ? "ocr" : "none");
  console.log(`[compo:critique] loaded ${modelEssays.length} model essays (optionType=${optionType ?? "any"}, topic=${studentTopic ?? "(none)"}, onPointCheck=${effectiveQuestionText ? `yes (source=${topicSource})` : "no"}). Calling ${ANALYSIS_MODEL}...`);
  const start = Date.now();
  const resp = await generateContentWithRetry({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: CRITIQUE_PROMPT(ocrText, modelEssays, studentTopic, effectiveQuestionText) }] }],
    // Critique ships full rubric + cleanRewrite (3 axes + notes ×
    // CN/EN + summary + benchmarkYears). With long contentNotes for
    // 部分离题 cases that explain the deviation, default model cap
    // truncates the trailing `}` and the JSON parser blows up. 12K
    // is roomy without paying for capacity the stage never uses.
    config: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 12000 },
  }, 2, 5000, "compo-critique");
  console.log(`[compo:critique] done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  const text = (resp.text ?? "").trim();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = safeJsonParse(text, "critique");
  } catch (err) {
    // Critique JSON is large (rubric + cleanRewrite essay) and Gemini
    // occasionally emits unescaped inner quotes inside the rewrite body
    // that repairJson can't recover. Log ±200 chars around the V8-
    // reported position so the next failure tells us exactly what to
    // patch, then re-throw — the row goes to "failed" with a stable
    // error message and the admin can re-analyse after a model retry.
    const msg = (err as Error).message ?? "";
    const posMatch = msg.match(/position (\d+)/);
    const pos = posMatch ? parseInt(posMatch[1], 10) : -1;
    console.error(`[compo:critique] JSON parse FAILED, ${text.length} chars. Error:`, err);
    if (pos >= 0) {
      const startIdx = Math.max(0, pos - 200);
      const endIdx = Math.min(text.length, pos + 200);
      console.error(`[compo:critique] raw at pos ${pos} (±200 chars):`);
      console.error(`  pre:  ${JSON.stringify(text.slice(startIdx, pos))}`);
      console.error(`  bad:  ${JSON.stringify(text.slice(pos, pos + 1))}`);
      console.error(`  post: ${JSON.stringify(text.slice(pos + 1, endIdx))}`);
    } else {
      console.error(`[compo:critique] first 400 chars:`, text.slice(0, 400));
      console.error(`[compo:critique] last 400 chars:`, text.slice(-400));
    }
    throw err;
  }
  const contentScore = Number(parsed.contentScore ?? 0);
  const vocabScore = Number(parsed.vocabScore ?? 0);
  const sentenceScore = Number(parsed.sentenceScore ?? 0);
  const overallScore = Number(parsed.overallScore ?? contentScore + vocabScore + sentenceScore);
  // Parse the cleanRewrite sub-object if present; default to a
  // pass-through (no delta) so the UI always has something to show.
  const cr = parsed.cleanRewrite && typeof parsed.cleanRewrite === "object" ? parsed.cleanRewrite : null;
  const cleanRewrite: RubricBreakdown | undefined = cr ? {
    contentScore:   Number(cr.contentScore ?? contentScore),
    contentNotes:   String(cr.contentNotes ?? ""),
    contentNotesEn: String(cr.contentNotesEn ?? ""),
    vocabScore:     Number(cr.vocabScore ?? vocabScore),
    vocabNotes:     String(cr.vocabNotes ?? ""),
    vocabNotesEn:   String(cr.vocabNotesEn ?? ""),
    sentenceScore:  Number(cr.sentenceScore ?? sentenceScore),
    sentenceNotes:  String(cr.sentenceNotes ?? ""),
    sentenceNotesEn:String(cr.sentenceNotesEn ?? ""),
    overallScore:   Number(cr.overallScore ?? (Number(cr.contentScore ?? contentScore) + Number(cr.vocabScore ?? vocabScore) + Number(cr.sentenceScore ?? sentenceScore))),
    whyChanged:     String(cr.whyChanged ?? ""),
    whyChangedEn:   String(cr.whyChangedEn ?? ""),
  } : undefined;
  return {
    contentScore,
    contentNotes: String(parsed.contentNotes ?? ""),
    contentNotesEn: String(parsed.contentNotesEn ?? ""),
    vocabScore,
    vocabNotes: String(parsed.vocabNotes ?? ""),
    vocabNotesEn: String(parsed.vocabNotesEn ?? ""),
    sentenceScore,
    sentenceNotes: String(parsed.sentenceNotes ?? ""),
    sentenceNotesEn: String(parsed.sentenceNotesEn ?? ""),
    overallScore,
    overallSummary: String(parsed.overallSummary ?? ""),
    overallSummaryEn: String(parsed.overallSummaryEn ?? ""),
    cleanRewrite,
    cleanRewriteScore: cleanRewrite?.overallScore ?? overallScore,
    benchmarkYears: Array.isArray(parsed.benchmarkYears) ? parsed.benchmarkYears.map(String) : [],
  };
}

// ─── Recommendations ────────────────────────────────────────────────

const RECOMMEND_PROMPT = (
  ocrText: string,
  critique: Critique,
  playbookSummary: string,
) => `你是新加坡 PSLE 华文作文老师。学生作文如下，已经过初评。请给出两类改进建议：

【学生作文】
${ocrText}

【初评】
- 内容: ${critique.contentScore}/20 — ${critique.contentNotes}
- 词汇好句: ${critique.vocabScore}/10 — ${critique.vocabNotes}
- 句子结构与组织: ${critique.sentenceScore}/10 — ${critique.sentenceNotes}
- 总评: ${critique.overallSummary}

【可参考的语句库 (从 PSLE 范文提炼)】
${playbookSummary}

【任务】
1. **structural**: 找出 2-4 个结构上的缺口 — 例如缺少开头悬念、缺过渡句、高潮不够戏剧化、结尾点题不够、寓意 (moral) 不清。每个写明具体在文章哪个位置可以加。
2. **language**: 从上面的语句库 (或自创类似水平的句子) 推荐 3-5 个具体可以加进作文的句子或词组。不要太多 — 选最有助提升的几句。每句标明应该加在哪个情境/段落。
   · **重要**: 语句库每个 bucket 都有多个候选 (开头 12+ 个、结尾 12+ 个等等)。请根据本作文的具体情境挑选最贴合的句子，不要总是用列表第一句。如果情境对得上的有 3 个，选最切题的那一个，不要看顺序。
   · 不同的作文应该用不同的句子 — 即使两篇都是 "明白了一个道理" 的题目。

【输出格式 — 严格 JSON】每个 structural 都需要中英文，方便家长理解。
{
  "structural": [
    {
      "piece":    "<中文结构部分名称，例 '开头悬念' / '过渡' / '高潮' / '结尾点题' / '寓意'>",
      "pieceEn":  "<English label, e.g. 'Opening hook' / 'Transition' / 'Climax' / 'Moral'>",
      "issue":    "<中文问题描述 - 1 句话>",
      "issueEn":  "<English issue description — 1 short sentence>",
      "suggestion":   "<中文具体改法 - 1-2 句话>",
      "suggestionEn": "<English suggestion — 1-2 short sentences>",
      "exampleFromModel": { "year": "<参考的范文年份>", "snippet": "<可借鉴的范文片段>", "bucket": "<bucket 标签>" }
    }
  ],
  "language": [
    {
      "phraseCn": "<推荐的中文句子或词组>",
      "phraseEn": "<English translation>",
      "fromYear": "<出自的范文年份。如果是创作的或没特定来源，留空字串 \"\"; 不要写 'PSLE 通用' 或类似词>",
      "bucket": "<opening | closing | accident | careless | transition | emotion | scenery | action | moral>",
      "whyItHelps": "<为什么这句对这篇作文有帮助 - 1 句话 (中文)>"
    }
  ]
}

不要 markdown 包围。`;

type PhraseEntry = {
  cn: string;
  en?: string;
  fromYear?: string;
  // Sub-categorisation within the bucket, so the AI can match
  // by sub-type (e.g. a 'scenery opening' should swap to another
  // 'scenery opening', not a 'memory opening'). Free-form Chinese
  // label — taken from the source data wherever the upstream JSON
  // already categorises (phrases.json subgroups, sentences.json
  // technique strings).
  subType?: string;
};

// Canonical bucket names the recommend prompt + UI expect.
const PLAYBOOK_BUCKET_MAP: Record<string, string> = {
  universalOpenings: "opening",
  universalClosings: "closing",
  safetyAccidentDescription: "accident",
  carelessConfessionDescription: "careless",
};

// Build a phrase bank merging:
//   · The 4 hand-curated playbook buckets (universalOpenings / Closings,
//     safetyAccident / carelessConfession description) — 20 phrases.
//   · Every classified highlight in the 4 featured 40/40 essays — 29
//     more phrases tagged by bucket (opening/transition/accident/
//     careless/closing).
// = ~49 candidate phrases vs. the 16 the old summariser used.
function buildPhraseBank(): Map<string, PhraseEntry[]> {
  const bank = new Map<string, PhraseEntry[]>();
  const push = (bucket: string, entry: PhraseEntry) => {
    const list = bank.get(bucket) ?? [];
    list.push(entry);
    bank.set(bucket, list);
  };
  // Playbook
  const pb = playbookJson as unknown as Record<string, unknown>;
  for (const [rawBucket, items] of Object.entries(pb)) {
    if (!Array.isArray(items)) continue;
    const bucket = PLAYBOOK_BUCKET_MAP[rawBucket] ?? rawBucket;
    for (const it of items) {
      if (it && typeof it === "object" && typeof (it as { cn?: unknown }).cn === "string") {
        const e = it as { cn: string; en?: string };
        push(bucket, { cn: e.cn, en: e.en });
      }
    }
  }
  // Featured essay highlights (4 hand-curated essays — richer
  // 'why' annotations, used for the small intro card too).
  const featured = featuredJson as Array<{ year?: string; highlights?: Array<{ span?: string; bucket?: string; subType?: string }> }>;
  for (const essay of featured) {
    if (!Array.isArray(essay.highlights)) continue;
    for (const h of essay.highlights) {
      if (h && typeof h.span === "string" && typeof h.bucket === "string") {
        push(h.bucket, { cn: h.span, fromYear: essay.year, subType: h.subType });
      }
    }
  }
  // Extended highlights — produced by scripts/extract-compo-phrase-bank.ts
  // from the full 20-essay PSLE corpus (10 years × 2 options).
  // Same shape as featured.json so the bank stays uniform. Dedup
  // by exact cn match against what's already been pushed.
  const seen = new Set<string>();
  for (const [, list] of bank) for (const e of list) seen.add(e.cn);
  const extended = extendedJson as Array<{ year?: string; option?: number; titleCn?: string; highlights?: Array<{ span?: string; bucket?: string; subType?: string }> }>;
  for (const essay of extended) {
    if (!Array.isArray(essay.highlights)) continue;
    for (const h of essay.highlights) {
      if (h && typeof h.span === "string" && typeof h.bucket === "string") {
        if (seen.has(h.span)) continue;
        seen.add(h.span);
        push(h.bucket, { cn: h.span, fromYear: essay.year, subType: h.subType });
      }
    }
  }
  // Sentence connectors (一……就, 此时此刻, 等等). Each example
  // carries a connectorCn + a goodCn (the model sentence demonstrating
  // it). The connector itself goes into the 'connector' bucket; the
  // demo sentence goes into 'description'. techniqueCn ("用「一……就」
  // 表示动作紧接的关联词开头") is the sub-type signal.
  const sentences = sentencesJson as { examples?: Array<{ connectorCn?: string; goodCn?: string; goodEn?: string; techniqueCn?: string }> };
  for (const ex of sentences.examples ?? []) {
    if (ex?.connectorCn) {
      push("connector", { cn: ex.connectorCn, en: ex.techniqueCn ?? "", subType: connectorSubType(ex.techniqueCn ?? "") });
    }
    if (ex?.goodCn) {
      push("description", { cn: ex.goodCn, en: ex.goodEn, subType: "sentence-variation" });
    }
  }
  // Themed phrases — emotions / scenery-weather / actions / openings.
  // Each top-level key carries its own bucket name + walks down to
  // subgroups (nameCn = sub-type) before reaching the phrase leaves.
  const phrases = phrasesJson as Record<string, unknown>;
  for (const [key, group] of Object.entries(phrases)) {
    // Top-level key maps to one of our canonical buckets where it
    // makes sense; otherwise drop into 'description'.
    const bucket =
      key === "openings"       ? "opening"     :
      key === "emotions"       ? "description" :  // emotion descriptions are still 'description'
      key === "sceneryWeather" ? "description" :
      key === "actions"        ? "description" :
                                  "description";
    walkPhraseGroup(group, bucket, /*subType*/ null, push);
  }
  return bank;
}

// Map the techniqueCn string from compo-v2-sentences into a short
// sub-type label (时间紧接 / 时间地点 / 因果 / 转折 / 等等).
function connectorSubType(technique: string): string {
  if (/紧接|动作紧接/.test(technique)) return "时间紧接 (sequential)";
  if (/时间|时刻|当时/.test(technique))   return "时间 (temporal)";
  if (/原因|因为|因此|结果/.test(technique)) return "因果 (causal)";
  if (/转折|然而|可是|但是/.test(technique)) return "转折 (contrast)";
  if (/地点|场景|环境/.test(technique))     return "地点/场景 (locative)";
  return "其他 (other)";
}

// Recursive walker for phrases.json. Each level can carry a nameCn
// that we treat as the sub-type for any leaf phrases beneath it.
// Leaves are objects with `cn` set; everything else is descended into.
function walkPhraseGroup(
  node: unknown,
  bucket: string,
  inheritedSubType: string | null,
  push: (b: string, e: PhraseEntry) => void,
): void {
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  const localSubType =
    (typeof o.nameCn === "string" && o.nameCn) ? o.nameCn :
    (typeof o.emotionCn === "string" && o.emotionCn) ? o.emotionCn :
    inheritedSubType;
  if (typeof o.cn === "string") {
    push(bucket, {
      cn: o.cn,
      en: typeof o.en === "string" ? o.en : undefined,
      subType: inheritedSubType ?? undefined,  // already-deepest level uses parent's subType
    });
  }
  for (const [, v] of Object.entries(o)) {
    if (Array.isArray(v)) for (const item of v) walkPhraseGroup(item, bucket, localSubType, push);
    else if (v && typeof v === "object") walkPhraseGroup(v, bucket, localSubType, push);
  }
}

// FNV-1a-ish 32-bit hash for seeding the shuffle. Same essay → same
// order across reruns (stable for the user), but different essays
// see different orders so the AI's positional bias doesn't keep
// landing on the same opening across attempts.
function seedFromText(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  // Mulberry32 PRNG — small + fast, deterministic from seed.
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function summarizePlaybook(seedText: string): string {
  const bank = buildPhraseBank();
  const seed = seedFromText(seedText);
  const lines: string[] = [];
  for (const [bucket, items] of bank) {
    if (items.length === 0) continue;
    // Shuffle deterministically per-essay so the AI doesn't always
    // see the same #1 candidate. Show ALL — the bank isn't large
    // enough to blow the token budget.
    const shuffled = seededShuffle(items, seed + bucket.charCodeAt(0));
    // Group by sub-type within the bucket. Phrases with the same
    // sub-type sit together so the AI can pick alternatives that
    // match the original phrase's flavour (a 'scenery opening'
    // should swap to another 'scenery opening', not a 'memory
    // opening').
    const bySub = new Map<string, PhraseEntry[]>();
    for (const item of shuffled) {
      const k = item.subType ?? "其他";
      const arr = bySub.get(k) ?? [];
      arr.push(item);
      bySub.set(k, arr);
    }
    lines.push(`【${bucket}】(${items.length} 个候选, ${bySub.size} 个子类型)`);
    for (const [subType, subItems] of bySub) {
      lines.push(`  --- ${subType} ---`);
      for (const item of subItems) {
        const tag = item.fromYear ? ` (PSLE ${item.fromYear})` : "";
        lines.push(`    · ${item.cn}${tag}`);
      }
    }
  }
  return lines.join("\n");
}

export async function recommend(
  ocrText: string,
  critique: Critique,
): Promise<Recommendations> {
  const playbookSummary = summarizePlaybook(ocrText);
  console.log(`[compo:recommend] calling ${ANALYSIS_MODEL} (playbook ${playbookSummary.length} chars)...`);
  const start = Date.now();
  const resp = await generateContentWithRetry({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: RECOMMEND_PROMPT(ocrText, critique, playbookSummary) }] }],
    // Recommend returns structural[3] + language[5] each with CN/EN
    // copy + example snippets. Easily 4-5K tokens before the closing
    // `]}`. Cap matches the elevate stage so neither truncates.
    config: { responseMimeType: "application/json", temperature: 0.3, maxOutputTokens: 12000 },
  }, 2, 5000, "compo-recommend");
  console.log(`[compo:recommend] done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  const text = (resp.text ?? "").trim();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = safeJsonParse(text, "recommend");
  } catch (err) {
    // Don't sink the whole pipeline if Gemini emits malformed JSON for
    // recommendations — the critique already landed and the elevated
    // draft can still run. Log loudly and return empty arrays; the
    // side panel just won't show structure/language suggestions.
    console.error(`[compo:recommend] JSON parse FAILED, ${text.length} chars. First 200 chars:`, text.slice(0, 200));
    console.error(`[compo:recommend] parse error:`, err);
    return { structural: [], language: [] };
  }
  const structural = Array.isArray(parsed.structural) ? parsed.structural : [];
  const language = Array.isArray(parsed.language) ? parsed.language : [];
  return { structural, language };
}

// ─── Stage 5: elevated draft ────────────────────────────────────────

const ELEVATE_PROMPT = (
  ocrText: string,
  wrongWords: WrongWord[],
  critique: Critique,
  recs: Recommendations,
) => {
  const wrongWordLine = wrongWords.length === 0
    ? "(无错别字)"
    : wrongWords.map(w => `${w.original}→${w.suggestion} (${w.reason})`).join("; ");
  const structuralLines = recs.structural.map(s => `· ${s.piece}: ${s.suggestion}`).join("\n");
  const languageLines = recs.language.map(l => `· ${l.phraseCn} — ${l.whyItHelps}`).join("\n");

  return `你是新加坡 PSLE 华文作文老师。我们参考的是 PSLE 10 年 (2016-2025) 模范作文 — 全部 40/40，平均 ~730 CJK 字。学生的作文目前得分 ${critique.overallScore}/40。现在请你帮他改写到 35-40 分水平。

【真实分数分布 — 校准】
- 23-26 分: 中等。27-30 分: 良好 (~500 CJK)。31-34 分: 优秀 (2-3 个成语 + 描写, ~600 CJK)。
- 35-37 分: 接近满分 (多个成语 + 生动描写 + 高潮 + 寓意, **~700+ CJK**)。
- 38-40 分: 极少数顶尖 (~750-820 CJK, 句型多变, 修辞丰富)。
- 改写后要达到 35-40，必须满足: (a) 情节有明显起承转合和高潮 (b) 至少 3-4 个成语 / 好句 (c) 有描写 (人物心理 / 场景 / 动作) (d) 结尾点题/寓意清楚 (e) **CJK 字数 ≥ 700**。
- 如果做不到，老实在 estimatedScore 写一个比较低的分数 (例如 32 或 33)。不要为了好看而虚报分数。

【字数惩罚 — 必须严格执行】
PSLE 真实模范作文 CJK 字数: 664 (2019), 673 (2022), 759 (2020), 819 (2016)，平均 ~730 字。低于这个长度，内容很难充分展开，分数自然受限。
- < 500 CJK: 内容分 (满分 20) 上限 12-14 分，总分上限通常不超过 30。
- 500-599 CJK: 内容分上限 14-16 分，总分上限 ~32。
- 600-699 CJK: 内容分上限 16-17 分，总分上限 ~34。
- ≥ 700 CJK: 无字数惩罚。
- **严禁** 为了凑字数硬塞无关情节或重复句子 — 这会被扣词汇 / 句子结构分。要靠多写细节 (心理、场景、对话、描写)、加成语、加修辞来自然达到 700 字。

【规则 — 必须遵守】
1. **保留学生的故事主线** — 不要发明新情节，不要改变人物、地点、结局。
2. **字数目标 ≥ 700 CJK** — 如果原文不到 700 字，必须扩充 (加描写、加对话、加心理活动、加成语)，而不是仅仅补几个词。如果原文已超过 700 字，保持长度，重点提升质量。上限是 ~820 CJK；不要写成大学水准。
3. **用 [+ +] 标记所有新加的或替换的文字** — 用法如下:
   · 插入新文字: 在新文字外面包 [+...+]，例: 那天早上[+，阳光明媚，鸟语花香，+]我和爸爸去公园。
   · 替换旧文字: 删掉旧字，写新字时也用 [+...+] 包起来。
   · 学生原本写得好的文字 — 不要包 [+...+] 标记，直接保留。
   · **如果新加的是一段成型的好句/成语/开头/结尾/描写**，加上 bucket 标签让 UI 可以提供替代选项:
     格式: [+text|bucket+] (bucket 用英文小写)。bucket 取值之一:
     opening (开头) / closing (结尾) / moral (寓意) / transition (过渡) /
     accident (突发事件描写) / careless (粗心懊悔描写) /
     idiom (成语) / description (描写句 — 心理/场景/动作) /
     connector (连接词 — 此时此刻 / 一……就 / 与此同时 / 等等) /
     sentence (句型变化 — 比喻/排比/反问/感叹/对比，把平铺直叙改成有修辞的句子)
   · **每个 [+...|bucket+] 只能包一个原子级别的短语**。例如:
     ✓ [+此时此刻|connector+]，[+心跳得像要从胸口跳出来一样|description+]
     ✗ [+此时此刻，心跳得像要从胸口跳出来一样|connector+]   ← 不要混合
     连接词 / 成语 / 描写句应该各自分开标记，让用户可以独立替换。
   · **特别注意 sentence bucket**: 找出 2-3 处学生写得平淡 (直叙 "我很紧张" / "他很生气" / "天气很热") 的句子，改成有句型变化的句子并标记 [+...|sentence+]。例如:
     原文: "我很紧张" → [+我紧张得手心冒汗，双腿不停地颤抖|sentence+] (具体感官描写)
     原文: "天气很热" → [+太阳像一个大火球一样高高挂在天上|sentence+] (比喻)
     原文: "我又累又渴又饿" → [+脚像灌了铅一样沉重，喉咙像着了火一样干渴，肚子像打鼓一样空响|sentence+] (排比)
     原文: "我成功了" → [+难道这就是失败的滋味吗?不，这是成功前的考验!|sentence+] (反问)
     alternatives 必须用 **不同的句型** (比喻/排比/反问/感叹/对比), 让学生看到同一个意思有多种表达方式。
   · **数量不设上限**: 只要是新加的成型句子 (开头 / 结尾 / 寓意 / 过渡 / 成语 / 连接词 / 描写句 / 句型变化)，都应该加 bucket 标签让用户能换。一篇好作文可能有 6-10 处描写、3-4 个连接词、2-3 个成语、2-3 个句型变化 — 全都给标记。
   · 只有以下情况用普通 [+...+] (不加 bucket): 单字修订 (例如补 "的")、小标点修正、没有可替代选项的过场字句。
     · 例: [+岁月匆匆，许多往事都已经淡忘…|opening+]
     · 例: [+心跳得像要从胸口跳出来一样|description+]
     · 例: [+无地自容|idiom+]
   · 只在 4-8 句最具影响的句子上加 bucket 标签 (典型: 1 开头 + 1 结尾 + 1-2 成语 + 2-3 描写)。其他小修订只用普通 [+...+] 即可。
4. **改正所有错别字** (用 [+...+] 包正确字)。
5. **不要标记单字修订** 如果只是改一两个字 (如错别字)。要选成段或成句的提升点，让 markup 有价值。

【应该做的提升 (基于初评)】
- 内容: ${critique.contentNotes}
- 词汇好句: ${critique.vocabNotes}
- 句子结构: ${critique.sentenceNotes}

【结构上的建议】
${structuralLines || "(无)"}

【语言上的建议 — 可挑 2-3 句加入】
${languageLines || "(无)"}

【错别字】
${wrongWordLine}

【学生原作文】
${ocrText}

【任务】
按规则改写，并对改写后的版本做一份完整的 PSLE 40 分制评分。

【输出格式 — 严格 JSON】
{
  "draft": "<改写后的作文，含 [+ +] 和 [+...|bucket+] 标记。保留 \\n 段落换行>",
  "estimatedScore": <三项总分>,
  "rubric": {
    "contentScore": <0-20>,
    "contentNotes": "<中文短>",
    "contentNotesEn": "<English short>",
    "vocabScore": <0-10>,
    "vocabNotes": "<中文短>",
    "vocabNotesEn": "<English short>",
    "sentenceScore": <0-10>,
    "sentenceNotes": "<中文短>",
    "sentenceNotesEn": "<English short>",
    "overallScore": <三项总和，应等于 estimatedScore>,
    "whyChanged": "<中文 1-2 句: 改写后为什么得到这分 / 和原作差距在哪>",
    "whyChangedEn": "<English 1-2 sentences — why the rewrite earns this score vs the original>"
  },
  "phraseSwaps": [
    {
      "originalText": "<exact text that appears between [+ and |bucket+] in the draft>",
      "bucket": "opening | closing | moral | transition | accident | careless | idiom | description | connector | sentence",
      "subType": "<sub-type label, e.g. '天气/景物开头' / '时间紧接' / '心理描写'. 留空字串如果无法判定>",
      "originalEn": "<short English meaning of THIS phrase, 1 line>",
      "alternatives": [
        { "cn": "<same-sub-type alternative that fits THIS essay's situation>", "en": "<short English>", "pattern": "<optional — only for sentence bucket: 比喻句 / 排比句 / 反问句 / 感叹句 / 对比句 / 倒装句>" },
        { "cn": "<another same-sub-type fit>", "en": "<short English>", "pattern": "<optional>" },
        { "cn": "<a third same-sub-type fit>", "en": "<short English>", "pattern": "<optional>" }
      ]
    }
  ]
}

【phraseSwaps 注意事项】
· 每个用 [+...|bucket+] 标记的句子必须在 phraseSwaps 里有对应条目。
· originalText 必须和 draft 里的文字完全一致 (一字不差)。
· **alternatives 必须切合本作文的具体情境** — 不要给一个安全主题的开头去配一个考试失败的故事。每个 alternative 都要能直接代入而不破坏故事的情绪和上下文。
· **同子类型替换原则**: 上面的【语句库】每个 bucket 都按子类型分组 (例如 "天气/景物开头" / "悬念开头" / "时间紧接 (sequential)" 等)。alternatives 应该尽量从原句的子类型里挑 — 例如原句是 "景物开头"，就给其他 "景物开头" 当选项，不要混入 "悬念开头"；原句是 "时间紧接" 的 connector，alternatives 也应该是时间紧接类。
· **句型变化 bucket (sentence) 例外 — 反同子类型原则**: 这个 bucket 的目的就是让学生看到同一个意思的多种修辞方式。alternatives 必须用 **不同的句型** (例如原句是 "比喻"，alternatives 一个用 "排比"，一个用 "反问"，一个用 "感叹")。subType 写出每个 alternative 用的是什么句型 (例如 "比喻句" / "排比句" / "反问句" / "感叹句" / "对比句" / "倒装句")。
· 每条 phraseSwap 给 2-4 个 alternatives。
· 设置 subType 字段告诉前端这是什么子类型 (例如 "天气/景物开头" / "时间紧接" / "成语-表羞愧")。如果无法判定子类型，留空字串。
· 如果某个 bucket (例如 idiom) 没有合适的替代，就少给一两个 — 宁缺勿滥。

不要 markdown 包围。`;
};

export async function buildElevatedDraft(
  ocrText: string,
  wrongWords: WrongWord[],
  critique: Critique,
  recommendations: Recommendations,
): Promise<{ draft: string; estimatedScore: number; rubric?: RubricBreakdown; swaps?: PhraseSwap[] }> {
  console.log(`[compo:elevate] calling ${ANALYSIS_MODEL}...`);
  const start = Date.now();
  const resp = await generateContentWithRetry({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: ELEVATE_PROMPT(ocrText, wrongWords, critique, recommendations) }] }],
    // Elevate ships draft + rubric + phraseSwaps with nested alternatives —
    // easily 4-6k output tokens. Default model cap can cut us off mid-JSON,
    // which then leaks raw JSON into the displayed draft. Lift the cap.
    config: { responseMimeType: "application/json", temperature: 0.4, maxOutputTokens: 16384 },
  }, 2, 5000, "compo-elevate");
  const raw = (resp.text ?? "").trim();
  console.log(`[compo:elevate] done in ${((Date.now() - start) / 1000).toFixed(1)}s, ${raw.length} chars`);
  try {
    const parsed = safeJsonParse(raw, "elevate");
    const r = parsed.rubric && typeof parsed.rubric === "object" ? parsed.rubric : null;
    const rubric: RubricBreakdown | undefined = r ? {
      contentScore:   Number(r.contentScore ?? 0),
      contentNotes:   String(r.contentNotes ?? ""),
      contentNotesEn: String(r.contentNotesEn ?? ""),
      vocabScore:     Number(r.vocabScore ?? 0),
      vocabNotes:     String(r.vocabNotes ?? ""),
      vocabNotesEn:   String(r.vocabNotesEn ?? ""),
      sentenceScore:  Number(r.sentenceScore ?? 0),
      sentenceNotes:  String(r.sentenceNotes ?? ""),
      sentenceNotesEn:String(r.sentenceNotesEn ?? ""),
      overallScore:   Number(r.overallScore ?? Number(parsed.estimatedScore ?? 0)),
      whyChanged:     String(r.whyChanged ?? ""),
      whyChangedEn:   String(r.whyChangedEn ?? ""),
    } : undefined;
    // Parse phraseSwaps — defensive: each entry must have a non-empty
    // originalText and at least one alternative for the popup to be
    // useful; otherwise drop it.
    const rawSwaps = Array.isArray(parsed.phraseSwaps) ? parsed.phraseSwaps : [];
    const swaps: PhraseSwap[] = rawSwaps
      .filter((s: { originalText?: unknown }) => s && typeof s.originalText === "string" && s.originalText.length > 0)
      .map((s: { originalText: string; bucket?: string; subType?: string; originalEn?: string; alternatives?: Array<{ cn?: string; en?: string; pattern?: string }> }) => {
        const alts = Array.isArray(s.alternatives) ? s.alternatives : [];
        return {
          originalText: s.originalText,
          bucket: String(s.bucket ?? "other"),
          subType: s.subType ? String(s.subType) : undefined,
          originalEn: String(s.originalEn ?? ""),
          alternatives: alts
            .filter(a => a && typeof a.cn === "string" && a.cn.length > 0)
            .map(a => ({
              cn: a.cn!,
              en: String(a.en ?? ""),
              ...(a.pattern && typeof a.pattern === "string" && a.pattern.trim() ? { pattern: a.pattern.trim() } : {}),
            })),
        };
      })
      .filter((s: PhraseSwap) => s.alternatives.length > 0);
    return {
      draft: String(parsed.draft ?? raw),
      estimatedScore: Number(parsed.estimatedScore ?? rubric?.overallScore ?? 33),
      rubric,
      swaps,
    };
  } catch (err) {
    // AI returned plain text or truncated/malformed JSON. The previous
    // fallback dumped the raw JSON wrapper into the draft field, which
    // surfaced as '{ "draft": "...' in the UI — make that loud instead.
    console.error(`[compo:elevate] JSON parse FAILED, output ${raw.length} chars. First 200 chars:`, raw.slice(0, 200));
    console.error(`[compo:elevate] parse error:`, err);
    // Heuristic recovery: if the response starts with a JSON object,
    // try to pull just the "draft" string with a regex. Otherwise
    // surface a placeholder so the admin knows to re-analyse.
    const draftMatch = raw.match(/"draft"\s*:\s*"([\s\S]*?)(?:"\s*,\s*"|"\s*\})/);
    if (draftMatch && draftMatch[1].length > 50) {
      return { draft: draftMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'), estimatedScore: 33 };
    }
    return { draft: "(Enhanced draft generation failed — re-analyse to retry.)", estimatedScore: 0 };
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────

export async function analyseCompoAttempt(attemptId: string): Promise<void> {
  const overallStart = Date.now();
  const tag = `[compo:${attemptId.slice(-6)}]`;
  console.log(`${tag} ── analyse start ────────────────────────`);

  const attempt = await prisma.compoAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw new Error(`CompoAttempt ${attemptId} not found`);

  const compositionImagePaths = (attempt.compositionImagePaths as unknown as string[] | null) ?? [];
  // Pre-seeded mode: rows created from plain text (model essays, study-
  // pack templates etc.) come in with no image files but with ocrText
  // already populated. Skip stage 1; the rest of the pipeline reads
  // ocrText and runs as normal.
  const seededOcrText = (attempt.ocrText ?? "").trim();
  const isTextSeeded = compositionImagePaths.length === 0 && seededOcrText.length > 0;
  if (compositionImagePaths.length === 0 && !isTextSeeded) {
    throw new Error("No composition images");
  }
  console.log(`${tag} input: ${isTextSeeded ? "TEXT-SEEDED" : `${compositionImagePaths.length} composition file(s)`}, question=${attempt.questionImagePath ?? "(none)"}, optionType=${attempt.optionType ?? "(any)"}, topic=${attempt.studentTopic ?? "(none)"}`);

  await prisma.compoAttempt.update({
    where: { id: attemptId },
    data: { status: "analysing", errorMessage: null },
  });

  try {
    // 1. OCR (skipped when text-seeded)
    let ocrText: string;
    let ocrTextWithMarkings: string | null;
    let ocrQuestionText: string | null;
    if (isTextSeeded) {
      console.log(`${tag} stage 1/4: OCR (skipped — using pre-seeded ocrText, ${seededOcrText.length} chars)`);
      ocrText = seededOcrText;
      ocrTextWithMarkings = attempt.ocrTextWithMarkings;
      ocrQuestionText = attempt.ocrQuestionText;
    } else {
      console.log(`${tag} stage 1/4: OCR`);
      const r = await runOcr(
        compositionImagePaths,
        attempt.questionImagePath,
        attempt.compareToMarkings,
      );
      ocrText = r.ocrText;
      ocrTextWithMarkings = r.ocrTextWithMarkings;
      ocrQuestionText = r.ocrQuestionText;
      await prisma.compoAttempt.update({
        where: { id: attemptId },
        data: { ocrText, ocrTextWithMarkings, ocrQuestionText },
      });
    }

    // 2. Wrong words
    console.log(`${tag} stage 2/4: wrong-words`);
    const wrongWords = await detectWrongWords(ocrText);
    console.log(`${tag} found ${wrongWords.length} wrong-word issue(s)`);
    await prisma.compoAttempt.update({
      where: { id: attemptId },
      data: { wrongWords: wrongWords as never },
    });

    // 3. Critique
    console.log(`${tag} stage 3/4: critique`);
    const critique = await critiqueComposition(ocrText, attempt.optionType, attempt.studentTopic, ocrQuestionText);
    console.log(`${tag} score: ${critique.overallScore}/40 (内容 ${critique.contentScore}/20, 词汇 ${critique.vocabScore}/10, 句子 ${critique.sentenceScore}/10)`);
    await prisma.compoAttempt.update({
      where: { id: attemptId },
      data: { critique: critique as never },
    });

    // 4. Recommendations
    console.log(`${tag} stage 4/5: recommendations`);
    const recommendations = await recommend(ocrText, critique);
    console.log(`${tag} ${recommendations.structural.length} structural + ${recommendations.language.length} language recommendation(s)`);
    await prisma.compoAttempt.update({
      where: { id: attemptId },
      data: { recommendations: recommendations as never },
    });

    // 5. Elevated draft — write the version that would score 35-40,
    //    anchored to the kid's original plot. New text is wrapped in
    //    [+ ... +] markers so the UI can render kid words in black
    //    and additions in green.
    console.log(`${tag} stage 5/5: elevated draft`);
    const elev = await buildElevatedDraft(ocrText, wrongWords, critique, recommendations);
    console.log(`${tag} elevated draft estimated score: ${elev.estimatedScore}/40`);
    const recsWithDraft: Recommendations = {
      ...recommendations,
      elevatedDraft: elev.draft,
      elevatedDraftScore: elev.estimatedScore,
      elevatedDraftRubric: elev.rubric,
      elevatedDraftSwaps: elev.swaps,
    };
    console.log(`${tag} ${elev.swaps?.length ?? 0} substitutable phrase(s) with alternatives`);
    await prisma.compoAttempt.update({
      where: { id: attemptId },
      data: {
        recommendations: recsWithDraft as never,
        status: "ready",
        analysedAt: new Date(),
      },
    });
    console.log(`${tag} ── analyse done in ${((Date.now() - overallStart) / 1000).toFixed(1)}s ────────────`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} analyse FAILED after ${((Date.now() - overallStart) / 1000).toFixed(1)}s:`, msg);
    if (err instanceof Error && err.stack) console.error(err.stack);
    await prisma.compoAttempt.update({
      where: { id: attemptId },
      data: { status: "failed", errorMessage: msg },
    });
    throw err;
  }
}
