// Master Class content is now authored in YAML — see
// ./interactions-environment.yaml. This module reads + parses it
// at server start and exports the typed object.
//
// Edit the .yaml file to change slide content / narration.
// Restart `next dev` (or redeploy) to pick up the changes.
//
// The TYPE definitions stay here so authors get IDE auto-complete
// when editing this file, plus a single source of truth for what
// shape the YAML is expected to produce.

import path from "path";
import { promises as fs } from "fs";
import fsSync from "fs";
import { parse as parseYaml } from "yaml";

export type MasterClassSlide = {
  title: string;
  body: string;
  bullets?: string[];
  callout?: string;
  scoringExample?: {
    scenario: string;
    oneMark: { label: string; text: string };
    fullMarks: { label: string; text: string };
  };
  pieChart?: {
    percentage: number;
    label: string;
    caption?: string;
  };
  diagramPrompt?: string;
  cta?: {
    label: string;
    quizSpec?: {
      title: string;
      mcq: number;
      oeq: number;
    };
  };
  narration?: {
    intro?: string;
    bullets?: Array<string | null>;
    scoringExample?: string;
    callout?: string;
  };
};

export type MasterClassContent = {
  slug: string;
  subject: "science" | "math" | "english" | "chinese";
  level: "P5-P6" | "P3-P4";
  topicLabel: string;
  title: string;
  stats: {
    psleQuestions: number;
    psleSubjectPercent: number;
    totalPracticePool: number;
    psleQuestionsInPool: number;
    schoolQuestionsInPool: number;
    pctOeq: number;
    headline: string;
  };
  keyConcepts: MasterClassSlide[];
  commonMistakes: MasterClassSlide[];
  keyWords: Array<{ word: string; definition: string }>;
  subTopics: Array<{
    id: string;
    label: string;
    description: string;
    slideIdx: number;
  }>;
};

// Load synchronously at module-init time. The YAML file lives next
// to this TS file in the source tree; in production builds Next.js
// includes it via the outputFileTracingIncludes config (see
// next.config.ts).
const yamlPath = path.join(process.cwd(), "src/data/master-class/interactions-environment.yaml");
const yamlText = fsSync.readFileSync(yamlPath, "utf8");

export const interactionsEnvironment: MasterClassContent =
  parseYaml(yamlText) as MasterClassContent;

// Async variant exposed for future use (e.g. an admin route that
// hot-reloads YAML edits without a process restart).
export async function reloadInteractionsEnvironment(): Promise<MasterClassContent> {
  const text = await fs.readFile(yamlPath, "utf8");
  return parseYaml(text) as MasterClassContent;
}
