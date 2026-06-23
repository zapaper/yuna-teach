// Lumi-recommended quiz combos. Each combo pairs a CONTENT target
// (a syllabus topic + optional sub-topic weights mirroring the kid's
// concentration of past mistakes) with a SKILL target (one cross-
// cutting skill tag). The quiz picker overweights questions in the
// kid's weakest sub-topics and prefers Qs tagged with the chosen
// skill — so each quiz "kills two birds": content gap + skill gap.
//
// For v1 the combos are hardcoded per studentId, since we want the
// pairings to make narrative sense ("Electrical is your weakest;
// you also lose marks on evidence-then-conclusion — let's do both
// at once"). Once we're happy with the loop, replace this with a
// dynamic recommender that reads topline.weakTopics + commonMistakes
// from the Lumi diagnosis cache.

import type { ScienceSkillTag } from "./science-skills";

export type LumiQuizCombo = {
  // Friendly label for the parent dashboard button ("Electrical + Evidence").
  label: string;
  // Two-line "why this quiz" copy shown next to the button.
  rationale: string;
  // The syllabus topic targeted. Must match ExamQuestion.syllabusTopic.
  topic: string;
  // Optional per-sub-topic weights. Sums should be ≤ count. Each entry
  // says "pick at least N Qs in this sub-topic". Drives the overweight
  // on the kid's weakest sub-topics.
  subTopicWeights?: Record<string, number>;
  // The skill tag to pair with. Qs matching BOTH this skill AND the
  // topic/sub-topic are preferred over single-criterion matches.
  skillTag: ScienceSkillTag;
  // Pre-written content recap for the chosen topic. Pairs with the
  // generic skill recap from science-skills.ts at quiz-render time.
  topicRecap: {
    heading: string;
    watchOut: string[];
  };
};

// David Lim — top weakness Electrical (71% per dedupe-by-source); his
// 4 problem sub-topics distribute 4/3/2/1 by problem-Q count. Second
// weakness Heat (75%), graph-trend skill pairs naturally with the
// Mirabel-style OEQs he's losing marks on.
const DAVID_COMBOS: LumiQuizCombo[] = [
  {
    label: "Electrical + Evidence + reason",
    rationale: "Your weakest topic, drilled where your sub-topic gaps are biggest, with the answer-structure pattern you most often miss.",
    topic: "Electrical system and circuits",
    subTopicWeights: {
      "electromagnets":      4,
      "general-circuits":    3,
      "series-vs-parallel":  2,
      "bulb-brightness":     1,
    },
    skillTag: "evidence-then-conclusion",
    topicRecap: {
      heading: "Electrical — circuits and electromagnets",
      watchOut: [
        "Electromagnets: it's the current that makes the magnetism. No current → no magnet.",
        "Series: one switch off → all bulbs off. Parallel: each branch is independent.",
        "Brightness: more bulbs in a series circuit → each bulb gets less voltage → dimmer.",
      ],
    },
  },
  {
    label: "Heat + Graph reading",
    rationale: "Your second weakest topic, paired with the graph-trend questions you keep losing marks on.",
    topic: "Heat energy and uses",
    skillTag: "graph-trend-describe",
    topicRecap: {
      heading: "Heat — how it flows, and what changes",
      watchOut: [
        "Heat always travels from the hotter object to the cooler one. Never the other way.",
        "Temperature is how hot something is. Heat is the energy that moves between objects.",
        "Ice melts because heat flows INTO the ice — not because the ice gives off cold.",
      ],
    },
  },
];

// Mark Lim — top deduped wrong topic Human Resp/Circ (a lot of EVAL
// inflation; real gap concentrated on exercise-response OEQs like
// Mirabel/Linda). Pair with evidence-then-conclusion. Second pick:
// Photosynthesis with graph-trend-describe (his graph Qs are weak
// across topics, photosynthesis is where it bites hardest at PSLE).
const MARK_COMBOS: LumiQuizCombo[] = [
  {
    label: "Respiratory & Circulatory + Evidence + reason",
    rationale: "Your most-attempted topic with the most missed marks, paired with the answer pattern that scores PSLE OEQs.",
    topic: "Human respiratory and circulatory systems",
    skillTag: "evidence-then-conclusion",
    topicRecap: {
      heading: "Respiratory & Circulatory — exercise, breath, and blood",
      watchOut: [
        "When you exercise: heart rate goes UP because muscles need more oxygen.",
        "Breathing rate also goes up — more oxygen IN, more carbon dioxide OUT.",
        "Heart + lungs work TOGETHER: lungs add O₂ to blood, heart pumps it everywhere.",
      ],
    },
  },
  {
    label: "Photosynthesis + Graph reading",
    rationale: "A high-leverage topic for PSLE, paired with the graph-trend pattern that comes up every year.",
    topic: "Photosynthesis",
    skillTag: "graph-trend-describe",
    topicRecap: {
      heading: "Photosynthesis — when light hits a green leaf",
      watchOut: [
        "Plants make food using sunlight + carbon dioxide + water.",
        "It happens INSIDE chloroplasts, not just anywhere in the cell.",
        "Rate increases with light and CO₂, but only up to a limit — common graph trap.",
      ],
    },
  },
];

export const LUMI_QUIZ_COMBOS: Record<string, LumiQuizCombo[]> = {
  "cmm5wf91d000ryrxwaddlo6xh": DAVID_COMBOS,   // David Lim
  "cmmbbyvs30004qa9yinn3drl6": MARK_COMBOS,    // Mark Lim (kid; admin@yunateach.com's student)
};
