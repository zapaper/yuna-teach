// Server-side loader that returns a Master Class with any admin
// edits applied. Falls back to the YAML/JSON-bundled content when
// the DB has no row for this slug yet.
//
// Admin-saved scripts live in MasterClass.{keyConceptScripts,
// commonMistakeScripts} as string[] (mega-textarea per slide).
// We parse each script through parseSlideScript() and OVERLAY it
// onto the matching YAML slide, preserving structured blocks the
// textarea doesn't cover (pieChart, scoringExample, cta, diagramPrompt).

import { prisma } from "@/lib/db";
import { getMasterClass, type MasterClassContent, type MasterClassSlide } from "@/data/master-class";
import { parseSlideScript } from "./parse-script";

// Loose title match — lowercase, strip punctuation/whitespace/markdown.
// Used to confirm a DB-saved script still refers to the SAME slide the
// YAML now shows. Renaming/reordering/inserting slides in the YAML used
// to be invisible because the stale DB scripts kept overlaying at the
// same array index (the "I edited the master class but nothing changed"
// bug). When the loose title match fails we drop the overlay for that
// slide and let the fresh YAML show through.
function titleKey(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/\*\*|__/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function overlay(yaml: MasterClassSlide, script: string | undefined, slug: string, idx: number): MasterClassSlide {
  if (!script || !script.trim()) return yaml;
  const parsed = parseSlideScript(script);
  const yamlKey = titleKey(yaml.title);
  const scriptKey = titleKey(parsed.title);
  if (yamlKey && scriptKey && yamlKey !== scriptKey) {
    console.warn(`[master-class:${slug}] stale script at slide ${idx} — DB script title "${parsed.title}" no longer matches YAML title "${yaml.title}". Falling back to YAML.`);
    return yaml;
  }
  // Script is the source of truth — deletions in the textarea must
  // apply (so removing a callout in the editor clears the callout).
  // Only structured blocks the textarea can't represent fall back to
  // the YAML. Title falls back too (it's required and an empty-title
  // edit is almost certainly a slip).
  return {
    ...yaml,
    title: parsed.title || yaml.title,
    body: parsed.body,
    bullets: parsed.bullets,
    callout: parsed.callout,
    narration: parsed.narration,
    pieChart: yaml.pieChart,
    scoringExample: yaml.scoringExample,
    cta: yaml.cta,
    diagramPrompt: yaml.diagramPrompt,
    diagramImage: yaml.diagramImage,
    interactiveQuiz: yaml.interactiveQuiz,
  };
}

export async function getMasterClassHydrated(slug: string): Promise<MasterClassContent | null> {
  const base = getMasterClass(slug);
  if (!base) return null;
  const row = await prisma.masterClass.findUnique({ where: { slug } });
  if (!row) return base;
  const keyScripts = Array.isArray(row.keyConceptScripts) ? row.keyConceptScripts as string[] : [];
  const mistakeScripts = Array.isArray(row.commonMistakeScripts) ? row.commonMistakeScripts as string[] : [];
  return {
    ...base,
    keyConcepts: base.keyConcepts.map((s, i) => overlay(s, keyScripts[i], slug, i)),
    commonMistakes: base.commonMistakes.map((s, i) => overlay(s, mistakeScripts[i], slug, i)),
  };
}
