// Master Class content is authored in YAML — see
// ./interactions-environment.yaml. A pre-build step (scripts/
// build-master-class.mjs, wired into the `prebuild` + `postinstall`
// npm scripts) converts it to ./interactions-environment.generated.json
// which this module imports directly.
//
// Why JSON-via-generated-file instead of fs.readFileSync at runtime:
//   The data module is imported by client components too (admin
//   workshop, student player), so it must be bundleable. fs isn't
//   available in client bundles. Importing a checked-in JSON file
//   works in both server and client builds.
//
// Edit the .yaml file to change slide content / narration. Running
// `npm install` or `npm run build` regenerates the JSON. In dev
// you can re-run `node scripts/build-master-class.mjs` to refresh.
//
// The TYPE definitions stay here so authors get IDE auto-complete
// when editing this file, plus a single source of truth for what
// shape the YAML is expected to produce.

import data from "./interactions-environment.generated.json";

export type MasterClassSlide = {
  title: string;
  // Optional because the admin script editor can clear them.
  body?: string;
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
  level: "P5-P6" | "P3-P4" | "P3-P6";
  topicLabel: string;
  // Optional: when set, the admin practice-pool route filters by
  // this regex against `transcribedStem` INSTEAD of filtering by
  // `syllabusTopic = topicLabel`. Used for cross-topic master
  // classes like Patterns (which spans Algebra / Basic operations /
  // Geometry / Statistics).
  practiceStemRegex?: string;
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

export const interactionsEnvironment: MasterClassContent = data as MasterClassContent;
