// POST /api/admin/compo/[id]/phrase-alternatives
//
// Given a selected phrase + its surrounding paragraph, ask Gemini for
// 3-5 context-fit alternatives the kid can swap in. Used by the
// right-click menu on the compo detail page's editable essay.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { generateContentWithRetry } from "@/lib/gemini";

// Flash tier — alternatives for a single ~10-char phrase are easy work
// and we want the popup to feel snappy. Pro was 5-15s; flash is 1-3s.
const MODEL = "gemini-2.5-flash";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => ({})) as {
    selectedText?: string;
    paragraph?: string;
  };
  const selected = (body.selectedText ?? "").trim();
  const paragraph = (body.paragraph ?? "").trim();
  if (!selected) return NextResponse.json({ error: "selectedText required" }, { status: 400 });
  if (selected.length > 80) return NextResponse.json({ error: "selectedText too long (>80 chars)" }, { status: 400 });

  // Get the attempt for narrative context (topic, optionType).
  const row = await prisma.compoAttempt.findUnique({
    where: { id },
    select: { studentTopic: true, optionType: true },
  });
  const topic = row?.studentTopic ?? "(未提供)";

  const prompt = `你是新加坡 PSLE 华文作文老师。学生在改写时选中了下面这个短语，希望你给出 4-5 个更生动、更有文采的替代说法。

【作文题目】
${topic}

【所在段落 (上下文)】
${paragraph}

【学生选中的短语】
「${selected}」

【任务】
给出 4-5 个替代短语，每个都要：
1. 字数和原句相近 (不要太长)
2. 符合上下文情绪 / 情境 / 时态
3. 直接套入原句能读通，不打断句意
4. 至少有 2-3 个用了不同的修辞 (比喻 / 排比 / 反问 / 拟人 / 感叹 / 对比 / 倒装等)
5. 都是 P5-P6 水平的常见好词好句，不要古文，不要太生僻

【输出 — 严格 JSON 数组】
{
  "alternatives": [
    { "cn": "<替代短语 1>", "en": "<short English meaning>", "pattern": "<比喻句 / 排比句 / 反问句 / 直叙 / 等等>" },
    { "cn": "<替代短语 2>", "en": "<...>", "pattern": "<...>" },
    ...
  ]
}

只输出 JSON，不要 markdown，不要解释。`;

  try {
    const resp = await generateContentWithRetry({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", temperature: 0.7, maxOutputTokens: 2048 },
    }, 2, 3000, "compo-phrase-alternatives");
    const raw = (resp.text ?? "").trim();
    // Robust JSON extract — drop ``` fences if present, then take the
    // first balanced { … }.
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const start = cleaned.indexOf("{");
    if (start < 0) throw new Error("no JSON object in response");
    // Walk to matching close-brace, respecting strings.
    let depth = 0, escaped = false, inStr = false, end = -1;
    for (let i = start; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) throw new Error("unbalanced JSON object");
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
      alternatives?: Array<{ cn?: string; en?: string; pattern?: string }>;
    };
    const alts = (parsed.alternatives ?? [])
      .filter(a => a && typeof a.cn === "string" && a.cn.trim().length > 0)
      .map(a => ({
        cn: a.cn!.trim(),
        en: (a.en ?? "").trim(),
        pattern: (a.pattern ?? "").trim() || undefined,
      }));
    return NextResponse.json({ alternatives: alts });
  } catch (err) {
    console.error(`[compo:${id}] phrase-alternatives failed:`, err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
