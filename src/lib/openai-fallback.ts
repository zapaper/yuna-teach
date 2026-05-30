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

// Tier mapping. Cheap / flash → gpt-4o-mini; pro → gpt-4o. Both
// support vision + JSON mode. If a caller specifies a model not in
// this map, default to gpt-4o for safety.
const MODEL_MAP: Record<string, string> = {
  "gemini-2.5-flash": "gpt-4o-mini",
  "gemini-2.5-flash-lite": "gpt-4o-mini",
  "gemini-2.5-pro": "gpt-4o",
  "gemini-3.1-pro-preview": "gpt-4o",
  "gemini-3-flash-preview": "gpt-4o-mini",
  "gemini-3-pro-preview": "gpt-4o",
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
  const openaiModel = MODEL_MAP[geminiModel] ?? "gpt-4o";

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

  return {
    model: openaiModel,
    messages: messagesForJson,
    ...(wantsJson ? { response_format: { type: "json_object" as const } } : {}),
    ...(typeof cfg.temperature === "number" ? { temperature: cfg.temperature } : {}),
  };
}

// Wrap an OpenAI completion in a Gemini-shaped response so existing
// callers' `response.text` / `response.text?.trim()` access patterns
// keep working unchanged.
function adaptResponse(text: string): { text: string } {
  return { text };
}

export async function runOpenAIFallback(
  params: GeminiParams,
  label?: string,
): Promise<{ text: string }> {
  const tag = label ? `[OpenAI-fallback:${label}]` : "[OpenAI-fallback]";
  const req = translateRequest(params);
  console.log(`${tag} calling ${req.model} (translated from ${params?.model ?? "?"})`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const completion = await getOpenAI().chat.completions.create(req as any);
  const text = completion.choices[0]?.message?.content ?? "";
  console.log(`${tag} got ${text.length} chars`);
  return adaptResponse(text);
}
