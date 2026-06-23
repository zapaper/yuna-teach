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
  // Fallback content recap for the chosen topic. The lumi-quiz
  // endpoint prefers a pattern-derived recap pulled from the kid's
  // Lumi diagnosis cache (src/lib/lumi-deepdive.ts) — this stays as
  // the static fallback when the kid has no cached pattern for the
  // topic. Hand-written combos (David/Mark) keep their own copy
  // until we audit them against the workshop patterns too.
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

// Kaiyangnggg (P6) — top weakness Forces (Fric/Grav/Elastic) at 31%
// stable (n=13). Second weakness Heat at 25% with a regressing recent-
// third — focused practice hasn't shifted it, the misconception is
// what's persisting. Third weakness Energy conversion at 50% (n=22) —
// same root pattern as Forces per the workshop. All three combos let
// the deep-dive resolver pull pattern text from his cached diagnosis
// (kaiyangnggg:science) for the preamble. Sub-topic weights come from
// his marks-lost distribution per sub-topic (see scripts/_check-mark).
const KAIYANG_COMBOS: LumiQuizCombo[] = [
  {
    label: "Forces + Diagrams",
    rationale: "Your weakest topic by a wide margin (31%), and the same naming-the-force confusion keeps showing up. Drilling the sub-topics you've lost the most marks on.",
    topic: "Interaction of forces (Frictional force, gravitational force, elastic spring force)",
    subTopicWeights: {
      "identifying-and-representing-forces": 6,
      "applying-force-concepts": 3,
      "investigating-elastic-force": 1,
    },
    skillTag: "diagram-interpretation",
    topicRecap: {
      heading: "Forces — naming + applying",
      watchOut: [
        "Name the right force: ball rolling down = gravity, stretched spring = elastic, not 'a push'.",
        "Friction acts AGAINST motion. Identify the direction of motion first, then friction opposes it.",
      ],
    },
  },
  {
    label: "Heat — fix the misconceptions",
    rationale: "Stuck at 25% even after focused practice — the misconception is persisting. Today's preamble walks the three traps Lumi keeps seeing.",
    topic: "Heat energy and uses",
    subTopicWeights: {
      "heat-transfer-and-materials": 3,
      "changes-of-state": 3,
      "expansion-and-contraction": 2,
      "heat-temperature-and-measurement": 2,
    },
    skillTag: "diagram-interpretation",
    topicRecap: {
      heading: "Heat — the three traps",
      watchOut: [
        "'Feels cold' ≠ 'is cold'. Metal feels colder than wood because it conducts heat AWAY faster.",
        "Evaporation speeds up with wind, temperature, surface area. Humidity slows it.",
        "During melting / boiling, temperature stays flat because heat is absorbed to break bonds, not raise temp.",
      ],
    },
  },
  {
    label: "Energy conversion — name both forms",
    rationale: "Same pattern Lumi sees in Forces — energy 'getting lost' instead of converting. Practising the language across new scenarios.",
    topic: "Energy conversion",
    subTopicWeights: {
      "gravitational-potential-to-kinetic": 4,
      "electricity-generation-and-application": 3,
      "elastic-potential-to-kinetic": 2,
      "energy-loss-and-inefficiency": 1,
    },
    skillTag: "diagram-interpretation",
    topicRecap: {
      heading: "Energy conversion — name two forms",
      watchOut: [
        "Energy doesn't disappear. KE → heat (friction). PE → KE (rolling down). Always name TWO forms.",
        "On the way down: gravitational PE shrinks, KE grows. On the way up: opposite.",
      ],
    },
  },
];

// JeremiahSy (P5) — only one stable, high-confidence weakness:
// Reproduction at 33% (n=9). The workshop's Pattern [2] for him is
// "mixes up biological terms, misidentifies reproductive process
// locations" — exactly the gap a Reproduction combo addresses. Second
// combo is Life cycles (80%, n=5, regressing) — borderline N but the
// recent third dropping to 50% means a problem is brewing. P5 has no
// skill tags yet so combos pass evidence-then-conclusion as a no-op
// (picker uses topic-only matching since the skill pool is empty).
const JEREMIAH_COMBOS: LumiQuizCombo[] = [
  {
    label: "Reproduction — names + processes",
    rationale: "Your weakest topic at 33% — and the same biological-term confusion keeps coming up. Today we drill the parts and where each process happens.",
    topic: "Reproduction in plants and animals",
    subTopicWeights: {
      "reproductive-parts-and-functions": 7,
      "experimental-design-and-data-interpretation": 2,
      "pollination-and-fertilisation": 2,
    },
    skillTag: "evidence-then-conclusion",
    topicRecap: {
      heading: "Reproduction — name parts, locate process",
      watchOut: [
        "Pollination is on the stigma. Fertilisation is in the ovule. Don't swap them.",
        "Plant: stamen = male (anther + filament), pistil = female (stigma + style + ovary).",
        "Human: sperm from testes meets egg from ovary in the fallopian tube, not the womb.",
      ],
    },
  },
  {
    label: "Life cycles — animal stages",
    rationale: "Recent quizzes show you slipping back here from 80% to 50%. Same scenarios, more practice.",
    topic: "Life cycles in plants and animals",
    subTopicWeights: {
      "animal-life-cycle-stages": 8,
      "plant-reproduction-and-life-cycle": 2,
    },
    skillTag: "evidence-then-conclusion",
    topicRecap: {
      heading: "Life cycles — animal stages",
      watchOut: [
        "Butterfly: egg → caterpillar → pupa → butterfly. Mosquito: egg → larva → pupa → adult.",
        "Frog: tadpole has gills (water), adult has lungs (land). The change is metamorphosis.",
        "Larva and pupa LOOK different but they're the SAME organism, just different stages.",
      ],
    },
  },
];

export const LUMI_QUIZ_COMBOS: Record<string, LumiQuizCombo[]> = {
  "cmm5wf91d000ryrxwaddlo6xh": DAVID_COMBOS,   // David Lim
  "cmmbbyvs30004qa9yinn3drl6": MARK_COMBOS,    // Mark Lim (kid; admin@yunateach.com's student)
  "cmojzr4fu004gd4vnx8wmz6zk": KAIYANG_COMBOS, // Kaiyangnggg
  "cmnk7dkkj006z14p6yf06ohzm": JEREMIAH_COMBOS, // JeremiahSy
  // student67 cloned from David's combos — same level, same target gaps
  // for the test cohort. Swap to bespoke combos when we have a real
  // diagnosis for this kid.
  "cmqg8upha0000l3ijfr3co6t8": DAVID_COMBOS,   // student67
};
