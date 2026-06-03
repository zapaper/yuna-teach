import { interactionsEnvironment, type MasterClassContent } from "./interactions-environment";
import { patterns } from "./patterns";
import { electricalCircuits } from "./electrical-circuits";
import { grammarMcq1 } from "./grammar-mcq-1";
import { grammarMcq2 } from "./grammar-mcq-2";
import { chineseMcq1 } from "./chinese-mcq-1";
import { chineseOeqSetpieces } from "./chinese-oeq-setpieces";
import { chineseIdioms } from "./chinese-idioms";
import { chineseSentenceCompletion } from "./chinese-sentence-completion";
import { chineseCloze } from "./chinese-cloze";
import { chineseComprehension } from "./chinese-comprehension";
import { scienceDiversity } from "./science-diversity";
import { englishSynthesisTricks } from "./english-synthesis-tricks";
import { englishCompCloze } from "./english-comp-cloze";
import { englishVisualTextMcq } from "./english-visual-text-mcq";
import { mathHiddenConstantTotal } from "./math-hidden-constant-total";
import { mathSpeedMultiStage } from "./math-speed-multi-stage";
import { mathNestedFractions } from "./math-nested-fractions";
import { mathCombinedFigureArea } from "./math-combined-figure-area";
import { mathPaintedCube } from "./math-painted-cube";
import { mathPercentageTraps } from "./math-percentage-traps";
import { forces } from "./forces";
import { mathGeometryAngles } from "./math-geometry-angles";
import { mathGeometryMastery } from "./math-geometry-mastery";

// Master Class registry. Add new topics here as they're authored.
// The slug is what the admin route uses (/admin/master-class/[slug]).
export const MASTER_CLASSES: Record<string, MasterClassContent> = {
  "interactions-environment": interactionsEnvironment,
  "patterns": patterns,
  "electrical-circuits": electricalCircuits,
  "grammar-mcq-1": grammarMcq1,
  "grammar-mcq-2": grammarMcq2,
  "chinese-mcq-1": chineseMcq1,
  "chinese-oeq-setpieces": chineseOeqSetpieces,
  "chinese-idioms": chineseIdioms,
  "chinese-sentence-completion": chineseSentenceCompletion,
  "chinese-cloze": chineseCloze,
  "chinese-comprehension": chineseComprehension,
  "science-diversity": scienceDiversity,
  "english-synthesis-tricks": englishSynthesisTricks,
  "english-comp-cloze": englishCompCloze,
  "english-visual-text-mcq": englishVisualTextMcq,
  "math-hidden-constant-total": mathHiddenConstantTotal,
  "math-speed-multi-stage": mathSpeedMultiStage,
  "math-nested-fractions": mathNestedFractions,
  "math-combined-figure-area": mathCombinedFigureArea,
  "math-painted-cube": mathPaintedCube,
  "math-percentage-traps": mathPercentageTraps,
  "forces": forces,
  "math-geometry-angles": mathGeometryAngles,
  "math-geometry-mastery": mathGeometryMastery,
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
