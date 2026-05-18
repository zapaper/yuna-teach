import { interactionsEnvironment, type MasterClassContent } from "./interactions-environment";

// Master Class registry. Add new topics here as they're authored.
// The slug is what the admin route uses (/admin/master-class/[slug]).
export const MASTER_CLASSES: Record<string, MasterClassContent> = {
  "interactions-environment": interactionsEnvironment,
};

export function getMasterClass(slug: string): MasterClassContent | null {
  return MASTER_CLASSES[slug] ?? null;
}

export function listMasterClasses(): MasterClassContent[] {
  return Object.values(MASTER_CLASSES);
}

export type { MasterClassContent, MasterClassSlide } from "./interactions-environment";
