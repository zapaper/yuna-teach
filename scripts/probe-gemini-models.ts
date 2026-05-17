// Ping each model in our fallback chains with a trivial prompt
// and report success / failure. Costs ~$0.001 in tokens.
import { GoogleGenAI } from "@google/genai";

const MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash-image",
  "gemini-3-flash-preview",
  "gemini-3-pro-preview",
  "gemini-3.1-pro-preview",
];

async function main() {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) { console.error("Set GEMINI_API_KEY or GOOGLE_API_KEY"); process.exit(1); }
  const ai = new GoogleGenAI({ apiKey });
  for (const model of MODELS) {
    const t0 = Date.now();
    try {
      const r = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: "Reply with the single word: OK" }] }],
        config: { temperature: 0, maxOutputTokens: 10 },
      });
      const text = (r.text ?? "").trim().slice(0, 30);
      console.log(`✅  ${model.padEnd(28)} ${(Date.now() - t0)}ms  reply="${text}"`);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log(`❌  ${model.padEnd(28)} ${(Date.now() - t0)}ms  status=${e.status ?? "?"} msg=${(e.message ?? String(err)).slice(0, 120)}`);
    }
  }
}
main();
