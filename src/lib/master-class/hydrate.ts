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

function overlay(yaml: MasterClassSlide, script: string | undefined): MasterClassSlide {
  if (!script || !script.trim()) return yaml;
  const parsed = parseSlideScript(script);
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
    keyConcepts: base.keyConcepts.map((s, i) => overlay(s, keyScripts[i])),
    commonMistakes: base.commonMistakes.map((s, i) => overlay(s, mistakeScripts[i])),
  };
}
