import { interactionsEnvironment, type MasterClassContent } from "./interactions-environment";
import { patterns } from "./patterns";
import { electricalCircuits } from "./electrical-circuits";
import { grammarMcq1 } from "./grammar-mcq-1";
import { grammarMcq2 } from "./grammar-mcq-2";
import { chineseMcq1 } from "./chinese-mcq-1";
import { chineseMcq2 } from "./chinese-mcq-2";
import { chineseOeqSetpieces } from "./chinese-oeq-setpieces";

// Master Class registry. Add new topics here as they're authored.
// The slug is what the admin route uses (/admin/master-class/[slug]).
export const MASTER_CLASSES: Record<string, MasterClassContent> = {
  "interactions-environment": interactionsEnvironment,
  "patterns": patterns,
  "electrical-circuits": electricalCircuits,
  "grammar-mcq-1": grammarMcq1,
  "grammar-mcq-2": grammarMcq2,
  "chinese-mcq-1": chineseMcq1,
  "chinese-mcq-2": chineseMcq2,
  "chinese-oeq-setpieces": chineseOeqSetpieces,
};

export function getMasterClass(slug: string): MasterClassContent | null {
  return MASTER_CLASSES[slug] ?? null;
}

export function listMasterClasses(): MasterClassContent[] {
  return Object.values(MASTER_CLASSES);
}

// Resolve a sub-topic by (syllabusTopic, subTopicId) to its full
// definition. Multiple master classes can share a topicLabel (English
// Grammar MCQ is split into Part 1 / Part 2), so we scan every
// registered class looking for a matching topicLabel + subTopic id.
// Returns null when nothing matches.
export function resolveSubTopic(
  syllabusTopic: string | null | undefined,
  subTopicId: string | null | undefined,
): { id: string; label: string; description: string } | null {
  if (!syllabusTopic || !subTopicId) return null;
  const topicLower = syllabusTopic.toLowerCase();
  for (const mc of Object.values(MASTER_CLASSES)) {
    if (mc.topicLabel.toLowerCase() !== topicLower) continue;
    const hit = mc.subTopics?.find(s => s.id === subTopicId);
    if (hit) return { id: hit.id, label: hit.label, description: hit.description };
  }
  return null;
}

export type { MasterClassContent, MasterClassSlide } from "./interactions-environment";
