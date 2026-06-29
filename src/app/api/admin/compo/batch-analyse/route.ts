// POST /api/admin/compo/batch-analyse
//
// Takes 2-10 already-analysed CompoAttempt IDs, pulls each attempt's
// OCR + critique + recommendations, and asks Gemini 3.1-pro to spot
// patterns that repeat across the kid's essays. Returns 3-5 advice
// buckets (Content / Language / Flow / Sentence Structure / etc.)
// each with 2-3 actionable tips and short before/after examples
// pulled from the kid's actual essays.
//
// Unlike the per-essay analyser this doesn't create a new
// CompoAttempt row — it's a one-shot read-and-summarise. The
// caller renders the result inline.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { generateContentWithRetry } from "@/lib/gemini";
import { safeJsonParse } from "@/lib/compo-analysis";

// Gemini 3.1 Pro on 5-10 capped essay blobs at 12k output tokens runs
// 30-60s in the wild — sometimes 90s when the preview backend is slow.
// Default Next.js route budget (~15s on Railway / 10s on Vercel) cuts
// the request off mid-call; the browser then sees "Failed to fetch"
// and the user has nothing to look at. Lift the cap to 5 min.
export const maxDuration = 300;

const MODEL = "gemini-3.1-pro-preview";

type BatchAdvice = {
  tip: string;
  tipEn?: string;
  why: string;
  whyEn?: string;
  examples: Array<{ from: string; before: string; after: string }>;
};
type BatchBucket = {
  title: string;
  titleEn?: string;
  color: "blue" | "emerald" | "amber" | "rose" | "violet" | "sky";
  advice: BatchAdvice[];
};
type BatchResult = {
  buckets: BatchBucket[];
  overview: string;
  overviewEn?: string;
  essaysAnalysed: number;
  language: "chinese" | "english" | "mixed";
};

export async function POST(req: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({})) as { attemptIds?: unknown };
  const ids = Array.isArray(body.attemptIds) ? body.attemptIds.filter((x): x is string => typeof x === "string") : [];
  if (ids.length < 2) return NextResponse.json({ error: "Pick at least 2 essays" }, { status: 400 });
  if (ids.length > 10) return NextResponse.json({ error: "Maximum 10 essays per batch" }, { status: 400 });

  const attempts = await prisma.compoAttempt.findMany({
    where: { id: { in: ids }, status: "ready" },
    select: {
      id: true, label: true, studentTopic: true, language: true, englishComponent: true,
      ocrText: true, critique: true, recommendations: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  if (attempts.length < 2) {
    return NextResponse.json({ error: "At least 2 of the picked essays must be in 'ready' status" }, { status: 400 });
  }

  // Detect dominant language for picking the prompt voice — Chinese
  // and English get different language-of-instruction (the AI itself
  // writes in the same language so the advice can be pasted in front
  // of the student / parent directly).
  const langs = attempts.map(a => (a.language ?? "chinese").toLowerCase());
  const englishCount = langs.filter(l => l === "english").length;
  const chineseCount = langs.length - englishCount;
  const dominantLang: "chinese" | "english" | "mixed" =
    englishCount === 0 ? "chinese" :
    chineseCount === 0 ? "english" :
    "mixed";

  // Build the per-essay summary block. For each: short label, topic
  // (if any), word/char count, OCR text (capped), and the marker's
  // primary verdict so the AI sees what already-caught issues look
  // like and can build on them (not duplicate them).
  const essayBlocks = attempts.map((a, i) => {
    const ocr = (a.ocrText ?? "").trim();
    const ocrCapped = ocr.length > 2400 ? ocr.slice(0, 2400) + "\n[…truncated…]" : ocr;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = a.critique as any;
    let verdict = "";
    if (c) {
      if (typeof c.component === "string") {
        // English shape
        const max = (c.primary?.max ?? 18) + (c.language?.max ?? 18);
        verdict = `Score: ${c.overallScore}/${max}. ${c.primary?.notes ?? ""} ${c.language?.notes ?? ""}`.trim();
      } else {
        // Chinese shape
        verdict = `Score: ${c.overallScore}/40. 内容: ${c.contentNotes ?? ""} 词汇: ${c.vocabNotes ?? ""} 句子: ${c.sentenceNotes ?? ""}`.trim();
      }
    }
    return `── Essay ${i + 1}: "${a.label ?? "(no label)"}"${a.studentTopic ? ` — topic: ${a.studentTopic}` : ""} (lang=${a.language ?? "chinese"})
Marker's verdict: ${verdict || "(no verdict)"}
Text:
${ocrCapped}`;
  }).join("\n\n");

  const promptHeader = dominantLang === "english"
    ? `You are a Singapore PSLE English writing coach. Below are ${attempts.length} compositions written by the SAME student across different prompts.

Look for PATTERNS that repeat across the essays — not one-off mistakes. Spot the 3-5 highest-impact areas where this student keeps falling short, and give concrete, actionable advice the student can apply immediately on their NEXT composition.`
    : dominantLang === "chinese"
    ? `你是新加坡 PSLE 华文作文老师。下面是同一位学生写的 ${attempts.length} 篇作文（不同题目）。

请找出**重复出现的模式** — 不是单次错误，而是这位学生反复犯的问题或可改进的地方。挑出 3-5 个最值得着力的方向，给出具体、可立即执行的建议，让学生下次写作时就能用上。`
    : `You are a Singapore PSLE writing coach. Below are ${attempts.length} compositions written by the same student (mixed Chinese + English). Look for patterns that repeat across both languages.`;

  const outputFmt = `【Output — strict JSON】

⚠️ HARD STRUCTURAL REQUIREMENT — the FIRST bucket in your output MUST be a CONTENT / PLOT / DESCRIPTION bucket. This is non-negotiable. Language / Vocabulary / Sentence Structure buckets are valuable but they go AFTER the content bucket, not instead of it. If the first bucket in your output isn't about plot / climax / description / character emotion / resolution, you have failed this task.

Why this rule: language-only coaching pushes the student toward polished sentences of a thin story. The bigger PSLE marks come from a story that builds, peaks, and lands — most students need content coaching more than they need another grammar reminder.

The content bucket title must be ONE of: "Content", "Plot Development", "Description", "Climax & Build-up", "Resolution", "Emotion & Character".

Inside the content bucket, the advice must focus on STORY-CRAFT problems you see across the essays. Use these angles (pick the ones that match this student):
  · Climax is rushed / under-described — the kid jumps from rising action to "and then the X happened" in one line. Coach them to slow it down with senses (sight, sound, body reaction) for 3-4 sentences.
  · No build-up before the climax — the disaster / discovery / decision arrives flat. Coach a quiet moment of foreboding, hope, or normalcy that contrasts with what's coming.
  · Inner thoughts / emotion are missing at the turning point — the kid narrates action but the character is opaque. Coach them to drop in what the character is thinking / fearing / hoping.
  · Resolution wraps up in one line — "And we lived happily ever after." Coach the character to REFLECT (what changed in them? what did they learn? what's different now?).
  · Conflict is shallow — no real choice or dilemma. Coach surfacing a moment where the character has to decide between two things they care about.

You may include OTHER content-shaped tips beyond this list if they fit, but the bucket MUST exist as bucket #1.

When the student's gap is VOCAB (limited adjectives / repeated verbs / generic nouns), the highest-impact coaching is "show, don't tell" — replace abstract emotion words with concrete sensory action. Examples for the "before/after" pair:
  · Before: "She was scared." → After: "Her palms turned cold and her breath caught in her throat."
  · Before: "The room was messy." → After: "Half-eaten apples sat on the windowsill; clothes spilled from open drawers."
  · Before: "He was angry." → After: "His jaw tightened, and the pen snapped between his fingers."
Surface this advice INSIDE the content bucket (or a Description sub-bucket) rather than as a vocab item — it lands as a craft move, not a thesaurus exercise.

{
  "overview": "<1-2 sentence summary of the student's overall pattern>",
${dominantLang === "chinese" ? `  "overviewEn": "<the same 1-2 sentence summary, translated to English so a parent reading this in English can grasp the pattern at a glance — KEEP IT TIGHT, no padding, no Chinese terms left untranslated>",\n` : ""}  "buckets": [
    {
      "title": "<bucket #1 MUST be one of: Content / Plot Development / Description / Climax & Build-up / Resolution / Emotion & Character>",
${dominantLang === "chinese" ? `      "titleEn": "<English translation of the title field — e.g. 内容 → 'Content', 高潮与铺垫 → 'Climax & Build-up'. ALWAYS provide this when language is Chinese.>",\n` : ""}      "color": "<one of: blue / emerald / amber / rose / violet / sky>",
      "advice": [
        {
          "tip": "<short imperative headline, 5-10 words, e.g. 'Slow down the climax with sensory detail'>",
${dominantLang === "chinese" ? `          "tipEn": "<English translation of the tip headline — same imperative tone, 5-12 words. ALWAYS provide this when language is Chinese.>",\n` : ""}          "why": "<1 sentence — quote/cite the pattern you noticed across the essays>",
${dominantLang === "chinese" ? `          "whyEn": "<English translation of the why field — same 1 sentence, plain English. ALWAYS provide this when language is Chinese. Do NOT translate the example before / after fields — those stay Chinese-only.>",\n` : ""}          "examples": [
            {
              "from": "Essay <N>",
              "before": "<verbatim short snippet from the student's actual text — for content advice this is the rushed climax line, the flat resolution, etc.>",
              "after": "<a concrete improved version showing the expansion — for content advice this is the same moment expanded into 2-4 sentences with senses / thought / pacing>"
            }
          ]
        }
      ]
    }
    // Buckets 2+ can be Language / Vocabulary / Sentence Structure / Flow / Opening Hook etc.
  ]
}${dominantLang === "chinese" ? `

⚠️ Chinese-mode translation requirement: EVERY bucket MUST have a "titleEn" field. EVERY advice MUST have "tipEn" and "whyEn" fields. The "before" / "after" example text stays Chinese only — don't translate it. The English translations let an English-reading parent skim the structure without losing the Chinese content underneath.` : ""}

Rules:
- 3-5 buckets total. Don't pad. Quality over quantity.
- Bucket #1 MUST be content/plot/description per the hard rule above.
- 2-3 advice items per bucket maximum.
- Each advice MUST cite 1-2 examples from the student's actual essays (verbatim "before" + your "after").
- Pick a different colour per bucket so the rendered output is visually scannable.
- ${dominantLang === "english"
    ? "Write the tip / why / after fields in English."
    : dominantLang === "chinese"
    ? "建议、原因、改写都用中文。引用学生原文也保留中文。"
    : "Match the language of each example to the source essay."}

No markdown.`;

  const prompt = `${promptHeader}

${essayBlocks}

${outputFmt}`;

  console.log(`[compo:batch-analyse] calling ${MODEL} for ${attempts.length} essays (lang=${dominantLang})...`);
  const start = Date.now();
  try {
    const resp = await generateContentWithRetry({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", temperature: 0.4, maxOutputTokens: 12000 },
    }, 2, 5000, "compo-batch-analyse");
    console.log(`[compo:batch-analyse] done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = safeJsonParse((resp.text ?? "").trim(), "batch-analyse") as any;
    const validColors = new Set(["blue", "emerald", "amber", "rose", "violet", "sky"]);
    // Helper: only carry an English translation field forward when the
    // pipeline is Chinese AND the model actually produced a non-empty
    // string. Keeps the response shape minimal for English-only runs.
    const pickEn = (raw: unknown): string | undefined => {
      if (dominantLang !== "chinese") return undefined;
      if (typeof raw !== "string") return undefined;
      const t = raw.trim();
      return t.length > 0 ? t : undefined;
    };
    const buckets: BatchBucket[] = Array.isArray(parsed.buckets) ? parsed.buckets
      .filter((b: { title?: unknown; advice?: unknown }) => b && typeof b.title === "string" && Array.isArray(b.advice))
      .map((b: { title: string; titleEn?: unknown; color?: string; advice: Array<{ tip?: unknown; tipEn?: unknown; why?: unknown; whyEn?: unknown; examples?: unknown }> }, i: number) => {
        const titleEn = pickEn(b.titleEn);
        return {
          title: String(b.title).trim(),
          ...(titleEn ? { titleEn } : {}),
          color: validColors.has(String(b.color)) ? (b.color as BatchBucket["color"]) : (["blue", "emerald", "amber", "rose", "violet", "sky"] as const)[i % 6],
          advice: b.advice
            .filter(a => a && typeof a.tip === "string")
            .map(a => {
              const tipEn = pickEn((a as { tipEn?: unknown }).tipEn);
              const whyEn = pickEn((a as { whyEn?: unknown }).whyEn);
              return {
                tip: String(a.tip).trim(),
                ...(tipEn ? { tipEn } : {}),
                why: String((a as { why?: unknown }).why ?? "").trim(),
                ...(whyEn ? { whyEn } : {}),
                examples: Array.isArray((a as { examples?: unknown }).examples) ? ((a as { examples: Array<{ from?: unknown; before?: unknown; after?: unknown }> }).examples)
                  .filter(e => e && typeof e.before === "string" && typeof e.after === "string")
                  .map(e => ({
                    from: String((e as { from?: unknown }).from ?? "").trim(),
                    before: String(e.before).trim(),
                    after: String(e.after).trim(),
                  })) : [],
              };
            }),
        };
      }) : [];
    const overviewEnRaw = parsed.overviewEn;
    const result: BatchResult = {
      buckets,
      overview: String(parsed.overview ?? "").trim(),
      // Only surface overviewEn when (a) Chinese pipeline produced it
      // AND (b) it's non-empty after trim. The detail card hides it
      // when missing or identical to the Chinese version.
      ...(dominantLang === "chinese" && typeof overviewEnRaw === "string" && overviewEnRaw.trim().length > 0
        ? { overviewEn: overviewEnRaw.trim() }
        : {}),
      essaysAnalysed: attempts.length,
      language: dominantLang,
    };
    return NextResponse.json(result);
  } catch (err) {
    console.error(`[compo:batch-analyse] failed:`, err);
    return NextResponse.json({ error: (err as Error).message ?? "Batch analyse failed" }, { status: 500 });
  }
}
