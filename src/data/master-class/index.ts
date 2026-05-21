import { interactionsEnvironment, type MasterClassContent } from "./interactions-environment";
import { patterns } from "./patterns";
import { electricalCircuits } from "./electrical-circuits";
import { grammarMcq1 } from "./grammar-mcq-1";
import { grammarMcq2 } from "./grammar-mcq-2";

// Master Class registry. Add new topics here as they're authored.
// The slug is what the admin route uses (/admin/master-class/[slug]).
export const MASTER_CLASSES: Record<string, MasterClassContent> = {
  "interactions-environment": interactionsEnvironment,
  "patterns": patterns,
  "electrical-circuits": electricalCircuits,
  "grammar-mcq-1": grammarMcq1,
  "grammar-mcq-2": grammarMcq2,
};

export function getMasterClass(slug: string): MasterClassContent | null {
  return MASTER_CLASSES[slug] ?? null;
}

export function listMasterClasses(): MasterClassContent[] {
  return Object.values(MASTER_CLASSES);
}

export type { MasterClassContent, MasterClassSlide } from "./interactions-environment";
