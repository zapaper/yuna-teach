// scripts/regen-oral-stimuli-2026.ts
//
// For each 2016-2024 year/day: (1) craft a Singapore-based photo
// scene aligned with the paper's original theme, (2) generate a
// realistic photo via Imagen, (3) generate three fresh questions
// following the 2026 format (Q1 picture-based, Q2 personal
// experience linked to the picture, Q3 broader critical thinking),
// (4) overwrite the stimulus JPG on the volume and update the DB
// row's oralDays[day-1] entry with the new scene description +
// questions.
//
// 2025 is left alone — it's already a real photo with proper 2026
// questions. Add --year <YYYY> or --day <1|2> to scope a test run.
//
// Usage:
//   npx tsx scripts/regen-oral-stimuli-2026.ts                     # all 2016-2024
//   npx tsx scripts/regen-oral-stimuli-2026.ts --year 2024         # one year
//   npx tsx scripts/regen-oral-stimuli-2026.ts --year 2024 --day 1 # one day
//   npx tsx scripts/regen-oral-stimuli-2026.ts --dry-run           # print, don't write

import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import { prisma } from "../src/lib/db";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const STORAGE_DIR = path.join(VOLUME_PATH, "english-supplementary");
const IMAGEN_MODEL = "imagen-4.0-generate-001";
const TEXT_MODEL = "gemini-3.1-pro-preview";

const yearIdx = process.argv.indexOf("--year");
const dayIdx = process.argv.indexOf("--day");
const YEAR_FILTER = yearIdx >= 0 ? process.argv[yearIdx + 1] : null;
const DAY_FILTER = dayIdx >= 0 ? Number(process.argv[dayIdx + 1]) : null;
const DRY_RUN = process.argv.includes("--dry-run");

type OralDay = {
  day: number;
  readingPassage?: string;
  stimulusDescription?: string;
  conversationPrompts?: unknown;
  stimulusPicturePageNum?: number | null;
};

type ReimaginedSBC = {
  scenePrompt: string;      // Imagen prompt — the actual photo we want
  stimulusDescription: string; // Short human-readable label for the DB
  q1: string;               // Picture-based
  q2: string;               // Personal experience linked to the picture
  q3: string;               // Broader critical thinking
};

const REIMAGINE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    scenePrompt: {
      type: Type.STRING,
      description: "Imagen prompt: 2-3 sentences describing a photorealistic Singapore-based scene (HDB estate, hawker centre, primary school, MRT, park, void deck, etc.) that fits the theme. Include lighting, framing, and 'photograph, natural light, everyday Singapore'. NO text, NO logos, NO watermarks. Keep it wholesome and age-appropriate for a 12-year-old.",
    },
    stimulusDescription: {
      type: Type.STRING,
      description: "One sentence describing what a viewer sees in the photo — used by the AI examiner as context. E.g. 'A family sharing a meal at a hawker centre in the evening.'",
    },
    q1: {
      type: Type.STRING,
      description: "Picture-based question. Must reference what's IN the picture. Style like 2025: 'Is this a good place to sell ice-cream? Why / Why not?' or 'Why do you think the people choose to eat at this hawker centre?'",
    },
    q2: {
      type: Type.STRING,
      description: "Personal-experience question linked to the picture's theme. Style like 2025: 'Would you be willing to join a long queue for something? Why / Why not?' or 'Do you prefer to eat home-cooked food or buy food from outside? Why?'",
    },
    q3: {
      type: Type.STRING,
      description: "Broader critical-thinking question on the theme. Style like 2025: 'Do you think people in Singapore are orderly? Why / Why not?' or 'Do you think children should learn how to cook? Why / Why not?'",
    },
  },
  required: ["scenePrompt", "stimulusDescription", "q1", "q2", "q3"],
} as const;

async function reimagineStimulus(
  ai: GoogleGenAI,
  year: string,
  day: number,
  oldStimulus: string,
  oldPrompts: string[],
): Promise<ReimaginedSBC> {
  const prompt = `You are converting a legacy 2016-2024 PSLE English Paper 4 Stimulus-Based Conversation (SBC) stimulus into the NEW 2026 format.

2026 SBC format:
  - Stimulus is a REAL PHOTOGRAPH of everyday Singapore life (not an illustrated poster).
  - Exactly three questions in order:
     Q1: picture-based (comment on what's in the photo)
     Q2: personal experience related to the picture's theme
     Q3: broader critical thinking on the theme
  - Reference for tone/style is the 2025 paper:
     Day 1 stimulus: "A long queue of people waiting in front of an ice-cream cart under an umbrella."
       Q1: Is this a good place to sell ice-cream? Why / Why not?
       Q2: Would you be willing to join a long queue for something? Why / Why not?
       Q3: Do you think people in Singapore are orderly? Why / Why not?
     Day 2 stimulus: "People eating and buying food at a hawker centre stall."
       Q1: Why do you think the people choose to eat at this hawker centre?
       Q2: Do you prefer to eat home-cooked food or buy food from outside? Why?
       Q3: Do you think children should learn how to cook? Why / Why not?

Original ${year} Day ${day} paper's theme (illustrated poster/map, not a photo):
  Stimulus: ${oldStimulus}
  Original Q1: ${oldPrompts[0] ?? "(missing)"}
  Original Q2: ${oldPrompts[1] ?? "(missing)"}
  Original Q3: ${oldPrompts[2] ?? "(missing)"}

Your job: KEEP THE THEME the same but produce a REAL-PHOTO Singapore scene. Then generate the three new-format questions for that photo.

Constraints on the photo (scenePrompt):
- Singapore-specific and immediately recognisable (HDB, void deck, hawker centre, MRT, primary school, wet market, park, sports hall, community centre, ITE/JC/uni backdrop, etc.).
- Photorealistic, everyday, wholesome, age-appropriate for a 12-year-old.
- No text, no signs with legible words, no logos, no watermarks (Imagen struggles with text and it clutters the stimulus).
- One clear focal action so the student can describe it.

Constraints on the questions:
- Q1 must reference something the child can see in the photo.
- Q2 must connect personally — "have you ever...", "do you prefer...", "tell us about a time...".
- Q3 must broaden to society / values / community.
- Every question ends with "Why / Why not?" or "Why?" where natural, matching the 2025 style.
- Keep them PSLE-appropriate — no adult topics.`;

  const response = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: REIMAGINE_SCHEMA,
      temperature: 0.4,
    },
  });
  const text = response.text;
  if (!text) throw new Error("empty response from text model");
  return JSON.parse(text) as ReimaginedSBC;
}

async function generatePhoto(ai: GoogleGenAI, scenePrompt: string): Promise<Buffer> {
  const finalPrompt = `${scenePrompt} Photograph, natural lighting, everyday Singapore, cinematic depth of field, high detail. No text or captions.`;
  const response = await ai.models.generateImages({
    model: IMAGEN_MODEL,
    prompt: finalPrompt,
    config: {
      numberOfImages: 1,
      aspectRatio: "4:3",
    },
  });
  const b64 = response.generatedImages?.[0]?.image?.imageBytes;
  if (!b64) throw new Error("no imageBytes returned");
  return Buffer.from(b64, "base64");
}

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const ai = new GoogleGenAI({ apiKey });

  await fs.mkdir(STORAGE_DIR, { recursive: true });

  // Collect target years: everything with a pdfPath EXCEPT 2025.
  const rows = await prisma.englishSupplementaryPaper.findMany({
    where: { pdfPath: { not: null } },
    orderBy: { year: "asc" },
    select: { year: true, oralDays: true },
  });
  const targetYears = rows
    .filter((r) => r.year !== "2025")
    .filter((r) => !YEAR_FILTER || r.year === YEAR_FILTER);

  console.log(`${targetYears.length} year(s) to process${YEAR_FILTER ? ` (--year ${YEAR_FILTER})` : ""}${DAY_FILTER ? ` (--day ${DAY_FILTER})` : ""}${DRY_RUN ? " [DRY-RUN]" : ""}`);
  console.log();

  let done = 0, failed = 0;
  for (const row of targetYears) {
    const days = (row.oralDays as OralDay[] | null) ?? [];
    const updated: OralDay[] = [];

    for (const day of days) {
      if (DAY_FILTER && day.day !== DAY_FILTER) {
        updated.push(day);
        continue;
      }
      const oldStimulus = day.stimulusDescription ?? "";
      const oldPrompts = Array.isArray(day.conversationPrompts)
        ? (day.conversationPrompts as string[]).map((p) => typeof p === "string" ? p : String(p))
        : [];

      try {
        console.log(`  ${row.year} Day ${day.day} — reimagining...`);
        const reimagined = await reimagineStimulus(ai, row.year, day.day, oldStimulus, oldPrompts);
        console.log(`    scene: ${reimagined.stimulusDescription}`);
        console.log(`    Q1: ${reimagined.q1}`);
        console.log(`    Q2: ${reimagined.q2}`);
        console.log(`    Q3: ${reimagined.q3}`);

        console.log(`  ${row.year} Day ${day.day} — generating photo...`);
        const photoBuf = await generatePhoto(ai, reimagined.scenePrompt);

        if (!DRY_RUN) {
          const outPath = path.join(STORAGE_DIR, `${row.year}_oral_day${day.day}_stimulus.jpg`);
          await fs.writeFile(outPath, photoBuf);
          console.log(`    wrote ${outPath} (${photoBuf.length} bytes)`);
          updated.push({
            ...day,
            stimulusDescription: reimagined.stimulusDescription,
            conversationPrompts: [reimagined.q1, reimagined.q2, reimagined.q3],
          });
        } else {
          console.log(`    [dry-run] would write photo (${photoBuf.length} bytes) + update DB`);
          updated.push(day);
        }
        done++;
      } catch (e) {
        console.log(`  ${row.year} Day ${day.day} — FAIL: ${(e as Error).message.slice(0, 200)}`);
        failed++;
        updated.push(day);
      }
    }

    if (!DRY_RUN) {
      await prisma.englishSupplementaryPaper.update({
        where: { year: row.year },
        // Prisma Json field — safe to cast.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { oralDays: updated as any },
      });
      console.log(`  ${row.year} — DB row updated with new oralDays`);
    }
    console.log();
  }
  console.log(`Summary: ${done} ok, ${failed} failed${DRY_RUN ? " [DRY-RUN — no writes]" : ""}`);
  console.log(`Output dir: ${STORAGE_DIR}`);
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
