// Wavespeed LLM client — used as a SECOND-SHOT fallback when Gemini
// returns an empty transcription. Wavespeed exposes an
// OpenAI-compatible chat-completions endpoint, so we use the openai
// SDK with a custom baseURL.
//
//   Endpoint: https://llm.wavespeed.ai/v1
//   Model:    openai/gpt-5.5
//   Auth:     Bearer ${WAVESPEED_API_KEY}
//
// All callers should log clearly when they invoke this — fallback
// rate matters for billing + reliability tracking.

import OpenAI from "openai";

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.WAVESPEED_API_KEY;
    if (!apiKey) throw new Error("WAVESPEED_API_KEY not set in environment");
    _client = new OpenAI({
      apiKey,
      baseURL: "https://llm.wavespeed.ai/v1",
    });
  }
  return _client;
}

export const WAVESPEED_MODEL = "openai/gpt-5.5";

// Run a vision-style transcription on a base64 JPEG image with a
// JSON-out prompt. Returns the parsed JSON, throwing on
// malformed / empty responses (so the caller's retry chain catches).
export async function wavespeedTranscribe<T = unknown>(
  imageBase64: string,
  prompt: string,
  label: string,
): Promise<T> {
  console.log(`[wavespeed:${label}] calling ${WAVESPEED_MODEL}`);
  const t0 = Date.now();
  const res = await getClient().chat.completions.create({
    model: WAVESPEED_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
          },
        ],
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
  });
  const text = res.choices?.[0]?.message?.content ?? "";
  if (!text || !text.trim()) {
    throw new Error("Wavespeed returned empty content");
  }
  // Strip any leading ```json fences just in case the model added them.
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  if (!cleaned) {
    throw new Error("Wavespeed returned content but it was only markdown fences with no JSON inside");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.warn(`[wavespeed:${label}] JSON parse failed (${Date.now() - t0}ms). Raw start: ${cleaned.slice(0, 200)}`);
    // Wrap the raw SyntaxError so the route handler sees an actionable
    // message instead of a bare "Unexpected end of JSON input".
    throw new Error(`Wavespeed returned unparseable JSON: ${(e as Error).message}`);
  }
  console.log(`[wavespeed:${label}] returned ${cleaned.length} chars JSON in ${Date.now() - t0}ms`);
  return parsed as T;
}
