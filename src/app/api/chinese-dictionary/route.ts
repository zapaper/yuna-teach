import { NextRequest, NextResponse } from "next/server";
import { generateContentWithRetry } from "@/lib/gemini";

// Chinese-only mini dictionary. Student highlights a phrase in a
// quiz MCQ and taps the dictionary button — the front end calls
// here. Returns pinyin + short Chinese definition + short English
// gloss. Keep the prompt tight: response is shown inline in the
// quiz sidebar, not a full dictionary entry.
export async function POST(request: NextRequest) {
  const { phrase } = await request.json() as { phrase?: string };
  const cleaned = (phrase ?? "").trim();
  if (!cleaned) return NextResponse.json({ error: "phrase required" }, { status: 400 });
  if (cleaned.length > 30) return NextResponse.json({ error: "phrase too long" }, { status: 400 });
  // Reject pure-ASCII / non-Chinese phrases — saves a model call.
  if (!/[一-鿿]/.test(cleaned)) {
    return NextResponse.json({ error: "not Chinese text" }, { status: 400 });
  }

  const prompt = `你是一个为新加坡小学生设计的简明中文词典。请用 JSON 回答。

要查的词或短语：${cleaned}

请按以下 JSON 结构回答（不要加任何额外文字）:
{
  "word": "<原词原样>",
  "pinyin": "<汉语拼音，包含声调符号，多字之间用空格>",
  "meaning_cn": "<用简单的简体中文解释，一句话，不超过 25 字>",
  "meaning_en": "<short English meaning, one sentence, under 15 words>"
}`;

  try {
    const response = await generateContentWithRetry({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", temperature: 0 },
    }, 1, 3000, `cn-dictionary:${cleaned}`);
    const text = response.text?.trim() ?? "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return NextResponse.json({ error: "no JSON in response" }, { status: 502 });
    const parsed = JSON.parse(m[0]) as { word?: string; pinyin?: string; meaning_cn?: string; meaning_en?: string };
    return NextResponse.json({
      word: parsed.word ?? cleaned,
      pinyin: parsed.pinyin ?? "",
      meaningCn: parsed.meaning_cn ?? "",
      meaningEn: parsed.meaning_en ?? "",
    });
  } catch (err) {
    console.error("[chinese-dictionary] failed:", err);
    return NextResponse.json({ error: "lookup failed" }, { status: 500 });
  }
}
