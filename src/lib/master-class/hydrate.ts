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
  return {
    ...yaml,
    title: parsed.title || yaml.title,
    body: parsed.body ?? yaml.body,
    bullets: parsed.bullets ?? yaml.bullets,
    callout: parsed.callout ?? yaml.callout,
    narration: parsed.narration ?? yaml.narration,
    // structured blocks preserved from YAML:
    pieChart: yaml.pieChart,
    scoringExample: yaml.scoringExample,
    cta: yaml.cta,
    diagramPrompt: yaml.diagramPrompt,
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
