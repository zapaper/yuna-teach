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
  // Optional inline diagram image — path relative to /public, e.g.
  // "/master-class/patterns/pattern-c-squares.png". Rendered above
  // the bullets, scaled to fit the card width.
  diagramImage?: string;
  // Optional mascot illustration — path relative to /public, e.g.
  // "/master-class/grammar-mcq-1/panda-welcome.png". Rendered at
  // the top-right of the slide as a small (~180px) friendly
  // character. Used to soften text-heavy slides for primary-school
  // students. Doesn't interfere with diagramImage; both can co-exist.
  mascotImage?: string;
  // Interactive quiz cards rendered INSIDE the slide. Each card shows
  // the stem + 4 radio options + a Submit button; on submit the slide
  // reveals correct/wrong + explanation. Used for worked-example
  // slides where students should attempt the question before seeing
  // the answer (rather than reading a pre-solved walkthrough).
  //
  // mascotThinking / mascotCorrect / mascotWrong let each quiz card
  // show a friendly reaction mascot. Falls back to the slide-level
  // mascotImage in the pre-submit state if mascotThinking is omitted.
  interactiveQuiz?: Array<{
    label?: string;        // e.g. "PSLE 2024 Q8 — negative-stem trap"
    stem: string;
    options: string[];     // exactly 4
    correctAnswer: number; // 1-4
    explanation: string;
    mascotThinking?: string;
    mascotCorrect?: string;
    mascotWrong?: string;
  }>;
  cta?: {
    label: string;
    quizSpec?: {
      title: string;
      mcq: number;
      oeq: number;
      // Per-sub-topic minimum OEQ count — forces the quiz builder
      // to allocate at least N OEQs from a given sub-topic before
      // the round-robin top-up. E.g. `{ electromagnets: 2 }` on
      // Electrical Circuits guarantees 2 electromagnet OEQs in
      // every quiz (which dominate the PSLE OEQ marks for that
      // topic). Keys are sub-topic IDs from subTopics[].
      subTopicOeqMin?: Record<string, number>;
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
    // Optional numeric stats — only used by classes that show a
    // frequency cover slide. English Grammar MCQ skips this slide
    // entirely (the master class opens with the 6-rule overview),
    // so all numeric fields are optional and only headline is
    // required.
    psleQuestions?: number;
    psleSubjectPercent?: number;
    totalPracticePool?: number;
    psleQuestionsInPool?: number;
    schoolQuestionsInPool?: number;
    pctOeq?: number;
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
