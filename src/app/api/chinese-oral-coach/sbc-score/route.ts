// POST /api/chinese-oral-coach/sbc-score
//
// After the Chinese SBC (会话) session ends, score the student's
// three answers against the 2026 PSLE 华文 rubric. Total /30.
//
// Same shape as /api/oral-coach/sbc-score (English) — three
// segments (Q1 描述 / Q2 意见 / Q3 经历) scored on a 0-100% scale
// in 5% increments; overall /30 computed as the equal-weighted
// average snapped to 5%. Per-segment model upgrade whenever a
// segment scores below 100%.

import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI, Type } from "@google/genai";
import { getSessionUserId } from "@/lib/session";

const MODEL = "gemini-3.1-pro-preview";

type TranscriptTurn = { speaker: "examiner" | "student"; text: string; ts?: number };

const DIM_TIP_ITEM = {
  type: Type.OBJECT,
  properties: {
    label: { type: Type.STRING, description: "简短的中文标签,例如「立场不清」" },
    hint: { type: Type.STRING, description: "1-2 句中文的具体建议,学生可以在下次尝试" },
    examples: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "0-4 段直接引用学生回答中的原句,佐证这个问题",
    },
  },
  required: ["label", "hint", "examples"],
} as const;
const DIM_BLOCK = {
  type: Type.OBJECT,
  properties: {
    scorePercent: { type: Type.INTEGER, description: "本段的百分制分数(0-100),精确到 5 的倍数(0, 5, 10, ..., 95, 100)。100% = 一线考官水平。0% = 完全没有回答或跑题。" },
    verdict: { type: Type.STRING, description: "一句中文总评" },
    seabLooksFor: { type: Type.STRING, description: "一句话:考官在这一段主要看什么" },
    details: { type: Type.ARRAY, items: { type: Type.STRING }, description: "3-5 条具体观察,直接引用学生的中文原话" },
    tips: { type: Type.ARRAY, items: DIM_TIP_ITEM, description: "1-3 条针对下次的具体建议" },
    modelUpgrade: { type: Type.STRING, description: "如果 scorePercent < 100,请写一段模范回答(简体中文,12岁新加坡学生的语气,一段话,补上学生缺失的要点)。若 scorePercent 是 100,请返回空字符串。" },
  },
  required: ["scorePercent", "verdict", "seabLooksFor", "details", "tips", "modelUpgrade"],
} as const;

const SCORING_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    overallVerdict: { type: Type.STRING, description: "两句中文的整体总评" },
    describe: DIM_BLOCK,    // Q1 描述
    opinion: DIM_BLOCK,     // Q2 意见
    experience: DIM_BLOCK,  // Q3 经历
  },
  required: ["overallVerdict", "describe", "opinion", "experience"],
} as const;

const SCORING_PROMPT = `你是一位资深的 PSLE 华文口试评分员。请为学生的会话表现打分。

【2026 会话 RUBRIC】
会话共有三道题目,按以下顺序:
  Q1 描述 —— 学生描述图片里的情境
  Q2 表达意见 —— 学生对图片主题表明立场并说明理由
  Q3 分享经历 —— 学生分享一次相关的亲身经历

请分别对学生的 Q1 / Q2 / Q3 三段回答打分,采用 0-100% 的百分制(精确到 5 的倍数)。100% 表示考官水准的回答;80% 表示 PSLE 高分段学生的表现,有一处明显不足;60% 及格但缺少多个要点;40% 及以下算薄弱。

【各段考察重点】
1. 描述 (Q1)
   考察:能否说出具体的画面元素(人、物、动作);内容与图片是否相关;有没有对情境做出合理的解读。
   扣分:笼统的「很好看」「很热闹」;完全没提图片;没有个人观点。

2. 表达意见 (Q2)
   考察:立场清晰(「我觉得…」);理由充分(「因为…」);词汇是否恰当且有深度;是否用连接词组织想法(例如「首先」「其次」「因此」)。
   扣分:一句「同意」就没了;理由空洞;词汇过于口语化。

3. 分享经历 (Q3)
   考察:有具体的时间、地点、人物;情感真实;能把经历与主题联系起来;结束时能升华一下感想。
   扣分:讲了一堆但和主题无关;泛泛而谈,没有具体细节;语法错误较多。

请用中文填写每段的 details(引用学生原话)、tips(下次改进方向,可附 0-4 段原句作为参考)、和 modelUpgrade(不足 100% 时,用一段话示范一个满分回答;100% 时留空)。overallVerdict 用两句中文总结整体表现。`;

export async function POST(request: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });

  const body = await request.json().catch(() => ({}));
  const transcript = body.transcript as TranscriptTurn[] | undefined;
  const theme = String(body.theme ?? "");
  const blurb = String(body.blurb ?? "");
  const prompts = (body.prompts as string[] | undefined) ?? [];
  if (!Array.isArray(transcript) || transcript.length < 2) {
    return NextResponse.json({ error: "transcript array with at least 2 turns required" }, { status: 400 });
  }

  const transcriptText = transcript
    .map((t) => `${t.speaker === "examiner" ? "考官" : "学生"}:${t.text}`)
    .join("\n\n");

  const ai = new GoogleGenAI({ apiKey });
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${SCORING_PROMPT}\n\n主题:${theme}\n情境:${blurb}\n\n题目:\n${prompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n\n对话记录:\n${transcriptText}`,
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: SCORING_SCHEMA,
        temperature: 0.2,
      },
    });
    const text = response.text;
    if (!text) throw new Error("empty response");
    const parsed = JSON.parse(text) as {
      overallVerdict: string;
      describe: { scorePercent: number };
      opinion: { scorePercent: number };
      experience: { scorePercent: number };
    };
    const snap5 = (n: number) => Math.round(n / 5) * 5;
    const clamp = (n: number) => Math.max(0, Math.min(100, snap5(n)));
    const q1 = clamp(parsed.describe.scorePercent);
    const q2 = clamp(parsed.opinion.scorePercent);
    const q3 = clamp(parsed.experience.scorePercent);
    const avgPercent = snap5((q1 + q2 + q3) / 3);
    // /30 = avg% × 30 / 100 = avg% × 0.3
    const overallSeabScore = Math.round((avgPercent * 0.3) * 100) / 100;
    return NextResponse.json({
      ...parsed,
      describe:   { ...parsed.describe,   scorePercent: q1 },
      opinion:    { ...parsed.opinion,    scorePercent: q2 },
      experience: { ...parsed.experience, scorePercent: q3 },
      overallPercent: avgPercent,
      overallSeabScore,
    });
  } catch (e) {
    const err = e as Error;
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
}
