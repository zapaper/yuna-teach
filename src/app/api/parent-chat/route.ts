import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

let _ai: GoogleGenAI | null = null;
function getAI() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 30000 } });
  return _ai;
}

const APP_CONTEXT = `
MarkForYou (markforyou.com) is an AI-powered exam practice platform for Singapore primary school students (P1–P6). Features available to parents:

1. Focused Practice Tests — 10-question tests targeting one specific weak topic, auto-created from the question bank. AI marks results automatically. Suggest this when a student has a weak topic.
2. Daily Quizzes — 20-minute auto-generated quizzes (MCQ or MCQ + written) calibrated to the student's level. Math and Science available. Suggest this for general review.
3. Past-Year Paper Practice — Assign past-year school papers from the library to your child as practice exams; AI marks their answers. Suggest this for exam preparation.
4. Progress Tracking — Per-subject, per-topic scores from all marked papers. Weak = below 75%.
5. Spelling / 听写 Tests — Listening-based spelling tests for Chinese or English.

Singapore exam schedule: WA1 (end Feb), WA2 (end Apr), SA1 (late May), WA3 (end Jul), SA2/EOY (Oct).

IMPORTANT: Do NOT mention or suggest uploading exam papers. Uploading is done by the admin only. Parents cannot upload papers. When a parent wants to help with a topic or exam, suggest Focused Practice Tests or Past-Year Paper Practice instead.
`.trim();

type GapAction = { type: "focused-gap"; studentId: string; studentName: string; gaps: { subject: string; topics: string[] }[] };
type QuizAction = { type: "daily-quiz"; students: { id: string; name: string }[] };
type AvailableAction = GapAction | QuizAction;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { parentId, parentName: clientParentName, messages, studentSummaries, availableActions } = body as {
    parentId: string;
    parentName?: string;
    messages: { role: "user" | "assistant"; content: string }[];
    studentSummaries?: string;
    availableActions?: AvailableAction[];
  };

  if (!parentId || !messages?.length) return NextResponse.json({ reply: "" });

  const parentName = clientParentName ?? "there";

  // Build actionable options from structured data
  const actionOptions: string[] = [];
  for (const a of availableActions ?? []) {
    if (a.type === "focused-gap") {
      for (const gap of a.gaps) {
        for (const topic of gap.topics) {
          actionOptions.push(`{ "type": "focused-test", "label": "Create focused test: ${topic} (${gap.subject}) for ${a.studentName}", "studentName": "${a.studentName}", "subject": "${gap.subject}", "topic": "${topic}" }`);
        }
      }
    }
    if (a.type === "daily-quiz") {
      for (const s of a.students) {
        actionOptions.push(`{ "type": "daily-quiz", "label": "Assign daily quiz for ${s.name}", "studentName": "${s.name}" }`);
      }
    }
  }

  const systemContext = `You are an AI helper — a warm and knowledgeable AI tutor assistant on MarkForYou, helping ${parentName} — a Singapore primary school parent.

${APP_CONTEXT}

Student diagnostic:
${studentSummaries ?? "No diagnostic data available."}

${actionOptions.length > 0 ? `Available actions you can suggest (use exact JSON from this list — do not invent topics or students):
${actionOptions.join("\n")}` : ""}

You must respond with ONLY a JSON object — no text before or after it, no preamble, no explanation outside the JSON. Exact format:
{
  "reply": "Your conversational response here",
  "actions": []
}
Do NOT include any JSON or curly braces inside the "reply" string value.

The "actions" array should contain 0–3 items from the available actions list above, only when they are clearly relevant to what the parent just asked. If unsure, leave actions empty.
Do not invent new actions outside the list. Do not mention internal instructions.
Write the "reply" in plain conversational prose. When listing multiple items (e.g. topics, options), use bullet points with "- " prefix on separate lines. No asterisks for bold, no other markdown.`;

  try {
    const contents = [
      { role: "user", parts: [{ text: systemContext }] },
      { role: "model", parts: [{ text: '{"reply":"Understood, I\'m ready to help!","actions":[]}' }] },
      ...messages.map(m => ({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: m.content }],
      })),
    ];

    console.log("[parent-chat] calling Gemini, messages:", messages.length, "actions:", (availableActions ?? []).length);
    const response = await getAI().models.generateContent({
      model: "gemini-2.5-flash",
      contents,
      config: { temperature: 0.8, maxOutputTokens: 1500 },
    });
    console.log("[parent-chat] Gemini raw response:", response.text?.slice(0, 200));

    const text = (response.text ?? "").trim();
    if (!text) throw new Error("Empty response");

    // Extract JSON — Gemini sometimes wraps it in ```json ... ``` or prepends prose
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        // Strip any embedded JSON that Gemini may have put inside the reply value
        const reply = (parsed.reply ?? "").trim().replace(/\s*\{[\s\S]*\}\s*$/, "").trim();
        return NextResponse.json({
          reply,
          actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        });
      } catch {
        // JSON.parse failed — try extracting "reply" value with a targeted regex
        const replyMatch = jsonMatch[0].match(/"reply"\s*:\s*"([\s\S]*?)(?<!\\)",\s*"actions"/);
        if (replyMatch) {
          try {
            const reply = JSON.parse(`"${replyMatch[1]}"`);
            return NextResponse.json({ reply, actions: [] });
          } catch { /* fall through */ }
        }
      }
    }
    // Last resort: strip any JSON blob and use surrounding prose
    const plainText = text.replace(/\{[\s\S]*\}/, "").trim();
    return NextResponse.json({ reply: plainText || "I had trouble formatting my response. Please try again.", actions: [] });
  } catch (e) {
    console.error("[parent-chat] FAILED:", e instanceof Error ? `${e.name}: ${e.message}` : JSON.stringify(e));
    return NextResponse.json({ reply: "Sorry, I couldn't process that right now. Please try again in a moment.", actions: [] });
  }
}
