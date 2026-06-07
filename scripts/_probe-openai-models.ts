// Quick probe — try each candidate OpenAI model with a trivial prompt
// to see which ones the org can call right now (without verification).

import { prisma } from "../src/lib/db"; // side-effect: loads .env
import OpenAI from "openai";
void prisma;

const MODELS = ["gpt-5-mini", "gpt-5.4", "gpt-5", "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"];

async function main() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY!, timeout: 30_000 });
  for (const model of MODELS) {
    try {
      const r = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: 'Return only the JSON {"ok":true}.' }],
        response_format: { type: "json_object" },
      });
      const text = r.choices[0]?.message?.content ?? "";
      console.log(`✓ ${model.padEnd(20)} → ${text.replace(/\s+/g, " ").slice(0, 80)}`);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log(`✗ ${model.padEnd(20)} → ${e.status ?? "?"}: ${(e.message ?? "").split("\n")[0].slice(0, 120)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
