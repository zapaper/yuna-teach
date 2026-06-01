// OpenAI fallback for Gemini calls.
//
// When generateContentWithRetry exhausts every Gemini attempt with
// rate-limit / quota errors (notably 429 RESOURCE_EXHAUSTED — the
// monthly spending-cap signal from AI Studio), this module translates
// the Gemini call into an OpenAI chat-completion call and returns a
// Gemini-shaped response so existing callers don't need to change.
//
// Scope:
//   · text + image prompts (both supported by OpenAI's vision-capable
//     models)
//   · plain text and JSON response modes
//   · model mapping from Gemini → OpenAI tier-equivalent
//
// Out of scope:
//   · Gemini-specific features that don't translate cleanly (function
//     calling, thinking, fileData refs, candidate streaming). Calls
//     that depend on those should keep their own per-call try/catch.
//
// The fallback only activates when:
//   · OPENAI_API_KEY env var is set
//   · Gemini failed with a 429 (rate limit / cap exhaustion)
//
// Disable by leaving OPENAI_API_KEY unset.

import OpenAI from "openai";

let _openai: OpenAI | null = null;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
      timeout: 180_000, // 3 minutes, matches the Gemini client
    });
  }
  return _openai;
}

// Tier mapping (2026-06-01 final). Flash tier = gpt-5; pro tier =
// gpt-5.4. The earlier "vision regression" on gpt-5 / gpt-5-mini was a
// misdiagnosis — the actual cause was OpenAI's chat completions API
// rejecting our temperature=0.1 with a 400. The error got swallowed
// in the marking catch block, Phase 1 returned empty, Phase 2 awarded
// 0 for every OEQ. With temperature normalised below, gpt-5 scored
// ~95.4% on the eval (vs gpt-4.1-mini at 90.0%, Gemini at ~97.7%).
// Pro tier stays on gpt-5.4 — accepts custom temperature fine.
const MODEL_MAP: Record<string, string> = {
  "gemini-2.5-flash": "gpt-5",
  "gemini-2.5-flash-lite": "gpt-5",
  "gemini-3.1-flash-lite-preview": "gpt-5",
  "gemini-3-flash-preview": "gpt-5",
  "gemini-2.5-pro": "gpt-5.4",
  "gemini-3.1-pro-preview": "gpt-5.4",
  "gemini-3-pro-preview": "gpt-5.4",
};

export function isOpenAIFallbackEnabled(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

export function isQuotaExhaustedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e.status === 429) return true;
  // Some Gemini errors come as plain text with the status embedded.
  const msg = typeof e.message === "string" ? e.message : "";
  if (/RESOURCE_EXHAUSTED|exceeded its monthly spending cap|429/i.test(msg)) return true;
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GeminiParams = any;

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OpenAIMessage = { role: "user" | "assistant" | "system"; content: string | OpenAIContentPart[] };

// Translate a Gemini params object into an OpenAI chat completions
// request. Best-effort — drops Gemini-only fields the equivalent
// OpenAI shape doesn't have.
function translateRequest(params: GeminiParams): {
  model: string;
  messages: OpenAIMessage[];
  response_format?: { type: "json_object" };
  temperature?: number;
} {
  const geminiModel: string = params?.model ?? "gemini-2.5-flash";
  const openaiModel = MODEL_MAP[geminiModel] ?? "gpt-5.4";

  const contents = (params?.contents ?? []) as Array<{
    role?: string;
    parts?: Array<{
      text?: string;
      inlineData?: { mimeType: string; data: string };
    }>;
  }>;

  const messages: OpenAIMessage[] = [];
  for (const c of contents) {
    const role = c.role === "model" ? "assistant" : c.role === "user" ? "user" : "user";
    const parts = c.parts ?? [];
    // Plain text-only fast path — many callers just send one text part.
    if (parts.length === 1 && typeof parts[0].text === "string" && !parts[0].inlineData) {
      messages.push({ role, content: parts[0].text });
      continue;
    }
    const blocks: OpenAIContentPart[] = [];
    for (const p of parts) {
      if (typeof p.text === "string" && p.text.length > 0) {
        blocks.push({ type: "text", text: p.text });
      } else if (p.inlineData) {
        const mime = p.inlineData.mimeType || "image/jpeg";
        blocks.push({
          type: "image_url",
          image_url: { url: `data:${mime};base64,${p.inlineData.data}` },
        });
      }
    }
    messages.push({ role, content: blocks });
  }

  const cfg = (params?.config ?? {}) as { responseMimeType?: string; temperature?: number };
  const wantsJson = cfg.responseMimeType === "application/json";
  // OpenAI requires the word "json" in the prompt when response_format
  // is json_object — append a tiny nudge to the last user message if
  // the caller's prompt didn't include it.
  let messagesForJson = messages;
  if (wantsJson) {
    const last = messages[messages.length - 1];
    const lastText = typeof last.content === "string"
      ? last.content
      : last.content.map(b => b.type === "text" ? b.text : "").join(" ");
    if (!/json/i.test(lastText)) {
      messagesForJson = messages.map((m, i) => {
        if (i !== messages.length - 1) return m;
        const suffix = "\n\nRespond with ONLY valid JSON.";
        if (typeof m.content === "string") {
          return { ...m, content: m.content + suffix };
        }
        return {
          ...m,
          content: [...m.content, { type: "text" as const, text: suffix }],
        };
      });
    }
  }

  // gpt-5 / gpt-5-mini reject non-default temperature with a 400
  // ("'temperature' does not support 0.1 with this model. Only the
  // default (1) value is supported."). gpt-4.x and gpt-5.4 accept
  // 0.1 fine. Pass the temperature through ONLY when the target model
  // supports it — drop it for gpt-5 family so the call succeeds at
  // default 1 instead of erroring out and forcing the marker to see
  // an empty student answer (silent 0/N marks per OEQ, which was the
  // "vision regression" I previously misdiagnosed).
  const modelAcceptsCustomTemp = !/^gpt-5(?:-mini)?$/.test(openaiModel);

  return {
    model: openaiModel,
    messages: messagesForJson,
    ...(wantsJson ? { response_format: { type: "json_object" as const } } : {}),
    ...(typeof cfg.temperature === "number" && modelAcceptsCustomTemp ? { temperature: cfg.temperature } : {}),
  };
}

// Wrap an OpenAI completion in a Gemini-shaped response so existing
// callers' `response.text` / `response.text?.trim()` access patterns
// keep working unchanged.
function adaptResponse(text: string): { text: string } {
  return { text };
}

// OpenAI-only marking reminder. The Gemini prompt in marking.ts
// already carries equivalence + "no-working-needed-for-correct-answer"
// rules buried inside its math-answer-first block, but the OpenAI eval
// showed gpt-4.1-mini ignores them in ~3 questions per run — awards 0
// on "6/7 m vs 6/7", "32° with no working", "35S vs 35" etc. Front-
// loading the rules into a system message lifts compliance without
// changing the Gemini path (Gemini doesn't see this prepend).
//
// Rules deliberately overlap with what's already in markPrompt — we
// pay token cost for redundancy, not for new rules, so behaviour is
// strictly more permissive on equivalence + strictly preserved on
// the FINAL-ANSWER-GOVERNS / no-rescue anti-hallucination guards.
const OPENAI_MARKING_REMINDER = `You are about to receive a marking task. Before applying the detailed prompt, internalise these THREE NON-NEGOTIABLE rules — gpt-4.1-mini has been observed to under-apply them in past runs:

1. EQUIVALENCE — these are the SAME answer and earn FULL marks for that part:
   - 6/7 = 6/7 m = $\\frac{6}{7}$ = 0.857… (units are optional unless the question explicitly says "give your answer in cm" / "leave units in"; any fraction format = the same number)
   - 1/2 = 0.5 = 50% ; 3 1/2 = 7/2 = 3.5 ; 18 2/3 = $18\\frac{2}{3}$
   - 35 = "35 notes" = "35S" = "35 dollars" (trailing labels / unit hints that don't contradict the expected answer are not penalised)
   - 22° = 22 degrees = 22 (degree symbol optional unless the question literally requires the symbol)
   - 3:7 ≠ 7:3 (ratios DO have direction — wrong-direction is still wrong, this exemption does NOT extend to ratio reversal)

2. CORRECT FINAL ANSWER → FULL MARKS, EVEN IF NO WORKING IS SHOWN.
   If the student's final-answer line matches the expected answer (after applying rule 1), award the full marks for that part. Do NOT deduct for "no working shown" / "no intermediate steps" / "did not show calculation". The "no working = 0" guard exists ONLY for WRONG final answers (to prevent the marker from rescuing a wrong answer by hallucinating method credit). Correct final answer + no working = full marks.

3. METHOD JUDGEMENT — when the student's working uses the correct method but expresses it differently from the expected steps, accept it. The expected-answer key is one valid path, not the only valid path. "1 set = 6 + 5 = 11; 385 ÷ 11 = 35" is a correct 3u + 1u = $11 → 1u = $35 chain, even if the key wrote "6U + 5U = 385; U = 35".

These three rules apply at EVERY part of the marking. The detailed prompt below still binds — but where it appears to contradict equivalence / correct-final-answer / valid-alternative-method, these three rules win.`;

export async function runOpenAIFallback(
  params: GeminiParams,
  label?: string,
): Promise<{ text: string }> {
  const tag = label ? `[OpenAI-fallback:${label}]` : "[OpenAI-fallback]";
  const req = translateRequest(params);
  // For marking calls only: prepend a system message that re-asserts
  // the rules gpt-4.1-mini tends to under-apply. Gemini never sees
  // this — it's exclusively an OpenAI-side patch.
  if (label === "marking") {
    req.messages = [
      { role: "system", content: OPENAI_MARKING_REMINDER },
      ...req.messages,
    ];
  }
  console.log(`${tag} calling ${req.model} (translated from ${params?.model ?? "?"})`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const completion = await getOpenAI().chat.completions.create(req as any);
  const text = completion.choices[0]?.message?.content ?? "";
  console.log(`${tag} got ${text.length} chars`);
  return adaptResponse(text);
}
