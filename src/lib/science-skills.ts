// Cross-cutting Science skill tags. Independent of syllabusTopic /
// subTopic. A single question can carry zero, one, or several. Used
// by Lumi to build "skill across topics" quizzes — when a kid keeps
// fading on the same skill regardless of topic, Lumi surfaces a quiz
// of fresh masters tagged with that skill, drawn from any topic.
//
// Each tag is derived from an existing Lumi mistake bucket in
// src/lib/tutor.ts so the diagnosis side ↔ question side line up
// cleanly. The pipeline:
//
//   1. Lumi clusters the kid's recent mistakes into a bucket
//      (e.g. "trend_description" — see tutor.ts:249, TREND_RE).
//   2. Lumi-quiz endpoint reads that bucket → maps to the Q-side
//      skill tag below → queries fresh master Qs carrying the tag.
//   3. Kid gets a cross-topic quiz drilling the same skill on new
//      content.
//
// Adding a 6th tag is a real cost — it dilutes the classifier signal
// and the matched Q pool. Only add when a new Lumi bucket appears in
// tutor.ts AND it cleanly translates to a Q-side demand (not a kid
// behaviour like "incomplete_answer" or "missing_context").

export const SCIENCE_SKILL_TAGS = [
  "graph-trend-describe",
  "evidence-then-conclusion",
  "precise-vocabulary",
  "diagram-interpretation",
  "direction-of-relationship",
] as const;

export type ScienceSkillTag = typeof SCIENCE_SKILL_TAGS[number];

// Lumi bucket → skill tag map. Used by the Lumi-quiz endpoint when
// translating a diagnosed pattern into a Q-side query filter.
export const LUMI_BUCKET_TO_SKILL_TAG: Record<string, ScienceSkillTag | null> = {
  trend_description:    "graph-trend-describe",
  final_consequence:    "evidence-then-conclusion",
  vague_terminology:    "precise-vocabulary",
  diagram_analysis:     "diagram-interpretation",
  inverse_data:         "direction-of-relationship",
  // Kid-behaviour or concept-pair-specific buckets — no clean Q-side
  // mapping. Lumi surfaces these without a quiz fan-out.
  missing_context:      null,
  concept_confusion:    null,
  incomplete_answer:    null,
  topical:              null,
};

// Plain-language description per tag, fed to the classifier prompt.
// Each ≤ 3 sentences. Phrased Q-side ("this question demands X") not
// kid-side ("kids fail at X").
export const SCIENCE_SKILL_DESCRIPTIONS: Record<ScienceSkillTag, string> = {
  "graph-trend-describe":
    "The question shows a graph, table, or chart and asks the student to describe the trend or pattern in their own words. " +
    "Mark scheme expects phrasing like 'as X increases, Y decreases' or 'rate increased for 15 min, then decreased'. " +
    "NOT this tag: an MCQ that asks the student to pick the correct graph among 4 option graphs.",
  "evidence-then-conclusion":
    "The mark scheme expects a two-part written answer: (1) cite specific evidence (a value, a phrase from the data, the change shown), " +
    "AND (2) state the underlying concept or reason WHY. Common in 2-3 mark OEQs starting 'Why...', 'Explain...', '(a) State... (b) Explain why...'. " +
    "If a partial-credit answer would give the evidence but miss the WHY (or vice versa), this tag applies.",
  "precise-vocabulary":
    "The answer key contains specific scientific terms where the everyday equivalent would lose marks " +
    "(e.g. 'luminous' not 'lights up'; 'expanded' not 'got bigger'; 'absorbed' not 'took in'). " +
    "Tag when the mark scheme explicitly names the technical term as the scoring criterion.",
  "diagram-interpretation":
    "ONLY tag when a diagram is in the QUESTION STEM and the student must read specific information off it — name a labelled part, trace a flow, identify a direction shown by arrows, count something visible. " +
    "DO NOT tag when the diagrams are in the MCQ options (the kid is picking among visual options, not interpreting a stem diagram). " +
    "DO NOT tag when a diagram merely provides context for an experiment but the answer doesn't require reading anything off it. " +
    "Examples that DO qualify: 'Label parts A and B of the plant.', 'Which direction does blood flow in vessel X?'. " +
    "Examples that DON'T qualify: 'Which graph shows the correct relationship?' (options are graphs), 'Order the stages of the life cycle.' (options are visual sequences).",
  "direction-of-relationship":
    "ONLY tag when the mark scheme demands the student WRITE OUT a proportional or inverse relationship in WORDS — " +
    "'as the surface area increases, the rate of evaporation increases'; 'the longer the wire, the dimmer the bulb'; 'when the volume of water decreases, the temperature rises faster'. " +
    "DO NOT tag when the answer is a numerical ranking, an ordering of items, an MCQ pick, or a single-value comparison. " +
    "DO NOT tag if the answer is just identifying which is bigger/smaller — only when the answer is a sentence describing how two variables co-vary.",
};

// Helper for the classifier prompt — formats the vocabulary block
// the LLM sees on every call.
export function skillTagsPromptBlock(): string {
  return SCIENCE_SKILL_TAGS
    .map((tag) => `- "${tag}": ${SCIENCE_SKILL_DESCRIPTIONS[tag]}`)
    .join("\n");
}

// Kid-facing preamble for each skill. Rendered at the top of every
// Lumi quiz so the student knows what's being tested AND what to
// watch out for BEFORE they start.
//
// Phrasing rules (informed by feedback_master_class_audience.md):
//   · plain English, no linguistic / pedagogical jargon
//   · concrete pitfalls with the actual phrase the kid would write
//   · two halves — "what's being tested" frames the skill;
//                  "what to look out for" calls out the failure mode
// Quiz-player-side preamble. Two parts: optional CONTENT recap
// (filled in for combo quizzes that target a topic) and a required
// SKILL recap (always present). The quiz player renders the topic
// block first if present, then the skill block.
export type LumiPreamble = {
  topic?: {
    heading: string;
    watchOut: string[];
  };
  skill: {
    heading: string;        // The skill name, in plain English
    tested: string;         // "Today we're practising X" — one sentence
    watchOut: string[];     // 2–4 bullet pitfalls to keep in mind
  };
};

// Internal per-skill preamble shape — kept as the source for the
// `skill` block. `SCIENCE_SKILL_PREAMBLE` below is keyed by skill tag.
type SkillPreambleBlock = LumiPreamble["skill"];

export const SCIENCE_SKILL_PREAMBLE: Record<ScienceSkillTag, SkillPreambleBlock> = {
  "graph-trend-describe": {
    heading: "Describing a trend from a graph",
    tested:
      "Reading a graph or table, then writing what the trend looks like in your own words.",
    watchOut: [
      "Don't just say \"it changed\" — name the direction (\"the rate increased, then decreased\").",
      "If the graph has a turning point, give the value at that point (e.g. \"at 15 minutes\").",
      "Use the scientific word for the variable (\"heart rate\", not \"the line\").",
    ],
  },
  "evidence-then-conclusion": {
    heading: "Evidence + reason",
    tested:
      "PSLE OEQs where the answer needs TWO parts: (1) what you see / what happened, AND (2) the scientific reason WHY.",
    watchOut: [
      "Half-answers lose half the marks. After you write what happened, add \"...because [scientific reason].\"",
      "If the question starts with \"Why\" or \"Explain\", a one-liner is almost never enough.",
      "Quote the evidence from the data/text — don't just paraphrase it.",
    ],
  },
  "precise-vocabulary": {
    heading: "Use the scientific word, not the everyday word",
    tested:
      "Picking the right scientific term instead of the casual one you'd use when talking.",
    watchOut: [
      "\"Got bigger\" → \"expanded\". \"Lights up\" → \"luminous\". \"Took in\" → \"absorbed\".",
      "The answer key picks ONE specific term. Synonyms often don't count.",
      "If you can think of a more technical word, use it.",
    ],
  },
  "diagram-interpretation": {
    heading: "Reading information from a diagram",
    tested:
      "Questions where the answer lives IN the diagram — labelled parts, arrows showing direction, connections.",
    watchOut: [
      "Don't guess from the stem text. Look at the diagram first, then answer.",
      "Trace every arrow before you decide the flow direction.",
      "Count parts carefully — \"three\" is not \"a few\".",
    ],
  },
  "direction-of-relationship": {
    heading: "How two things change together",
    tested:
      "Questions whose answer demands you write out HOW two variables relate (\"as X increases, Y decreases\").",
    watchOut: [
      "Don't say \"it changes\" — say WHICH WAY.",
      "Write the full phrase: \"as the wire gets longer, the bulb gets dimmer\".",
      "Half the marks come from getting the direction right. Read the data twice.",
    ],
  },
};
