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
import { AUTO_LUMI_COMBOS_SCIENCE, AUTO_LUMI_COMBOS_ENGLISH } from "./lumi-combos.auto.generated";

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

// Emily lim (P4) — strong overall (80%+ across the board) but two
// clear stable gaps: Cycles in matter (83%, n=31 — biggest sample +
// her two top patterns both anchor here: "confuses water volume with
// water level" + "forgets air is present in empty containers") and
// Human digestive system (80%, n=15 — pattern [2] is direct: "mixes
// up small/large intestine jobs"). P4 has no skill tags yet so
// combos pass precise-vocabulary as a no-op (picker uses topic-only
// matching when the skill pool is empty).
const EMILY_COMBOS: LumiQuizCombo[] = [
  {
    label: "Cycles in matter — volume + air",
    rationale: "Your biggest gap with the most data (n=31, 83%). Lumi keeps seeing two patterns here — water level vs volume, and forgetting that air takes up space.",
    topic: "Cycles in matter",
    subTopicWeights: {
      "measuring-volume-displacement": 3,
      "properties-of-matter": 4,
      "interpreting-heating-curves-data": 2,
      "water-cycle-applications": 1,
    },
    skillTag: "precise-vocabulary",
    topicRecap: {
      heading: "Cycles in matter — volume + air",
      watchOut: [
        "Water LEVEL rising and water VOLUME increasing are two different things — only the displaced water tells you the object's volume.",
        "Air is matter. An 'empty' bottle still holds air; it takes up space and has mass.",
      ],
    },
  },
  {
    label: "Human digestive system — intestines",
    rationale: "Your lowest stable topic (80%, n=15). Lumi sees a specific small-vs-large intestine confusion that keeps showing up.",
    topic: "Human digestive system",
    subTopicWeights: {
      "organ-identification-and-function": 5,
      "factors-and-system-interactions": 3,
      "process-of-digestion-and-absorption": 2,
    },
    skillTag: "precise-vocabulary",
    topicRecap: {
      heading: "Digestive system — intestines",
      watchOut: [
        "Small intestine absorbs DIGESTED nutrients. Large intestine absorbs WATER from undigested food.",
        "Get the order right: mouth → oesophagus → stomach → small intestine → large intestine.",
      ],
    },
  },
];

// ─── English Lumi quiz combos ────────────────────────────────────────
//
// English plays by different rules to Science. The big architectural
// difference is that ONLY three English syllabus topics have
// individually-pickable questions:
//
//   · Grammar MCQ
//   · Vocabulary MCQ
//   · Synthesis & Transformation
//
// Everything else (Grammar Cloze, Vocab Cloze MCQ, Comprehension
// Cloze, Editing, Visual Text Comprehension, Comp Open-Ended) is
// SECTION-BOUND — the bank / passage / instructions are shared across
// the 5–10 questions in the section, so the picker cannot just take
// 2-3 questions out of context. For those weaknesses, Lumi surfaces a
// recommended SECTION practice (the 3rd amber CTA slot) instead of a
// quiz combo.
//
// English combos therefore have no skillTag (English has no cross-
// cutting skill taxonomy yet) and the picker reads `subTopicWeights`
// directly against ExamQuestion.subTopic for the three pickable
// topics. The 2-button design rule:
//
//   ─── If the kid has a Grammar MCQ pattern (any sub-topic ≥10% miss):
//       Quiz 1 = Grammar MCQ pack tuned to the weak sub-topics
//       Quiz 2 = Synthesis pack tuned to the weak synthesis sub-topics
//
//   ─── If the kid has no Grammar MCQ pattern (everything ≤7% miss)
//       but a Synthesis weakness exists:
//       Quiz 1 + Quiz 2 = Synthesis, split by theme so each quiz has
//       topic coherence (e.g. "Reporting & Combining" vs "Noun-Phrase
//       Transformations"). Six questions per quiz.
//
// The 3rd CTA is the section-bound weakness — the parent dashboard
// surfaces it as "today's section spotlight" with a click-through to
// the recommended section in a real PSLE / prelim paper.
//
// Parent-facing summary copy guidelines (see [[feedback-lumi-progress-
// language]]):
//   · Lead with child + topic, never workshop / pattern jargon.
//   · Name sub-topics directly — "reported speech", not "reporting
//     what someone said (reported speech)".
//   · Drop parenthetical worked examples in the summary; they belong
//     in the preamble, not the parent's at-a-glance copy.
//   · Convert grammar-school names parents don't recognise ("subord-
//     inator clauses") into the actual joining words ("joining
//     sentences with because / although / if").

export type LumiEnglishQuizCombo = {
  // Friendly label for the parent dashboard button.
  label: string;
  // Two-line "why this quiz" copy shown next to the button.
  rationale: string;
  // Must be one of: "Grammar MCQ", "Vocabulary MCQ",
  // "Synthesis / Transformation". Picker reads from ExamQuestion.
  // syllabusTopic.
  topic: "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation";
  // Per-sub-topic weights. Picker should overweight Qs in these
  // sub-topics so the quiz drills the kid's actual gap shape.
  subTopicWeights: Record<string, number>;
  // Total question count for the quiz. Synthesis quizzes are 6;
  // Grammar/Vocab MCQ quizzes are 10 (English quizzes are quick).
  count: number;
  // Preamble copy. "watchOut" bullets are what the kid should look
  // out for in each sub-topic — written to land for a 10-12 year
  // old (no linguistic jargon, concrete examples).
  topicRecap: {
    heading: string;
    watchOut: string[];
  };
};

// Mark Lim — grammar mechanics are locked in (all Grammar MCQ
// sub-topics ≤7% miss). The personalised loss is concentrated in
// Synthesis. Split the synthesis weakness into two themed quizzes:
//   Quiz 1: Reporting & Combining — reported speech (75% miss, n=4) +
//           correlative pairs (40%, n=5). Two losses that fit a "what
//           did they say / which combination" lens.
//   Quiz 2: Noun-Phrase Transformations — relative clauses (whom /
//           whose), possessive forms ("the student's diligence"),
//           verb→noun ("made an announcement"). 43% miss across n=7.
//           Deserves its own session because the trick is structural.
// 3rd CTA: Editing section (20% miss — section-bound, surfaced as
//          spotlight, not a Lumi combo).
const MARK_ENGLISH_COMBOS: LumiEnglishQuizCombo[] = [
  {
    label: "Synthesis — reported speech + both/either/neither",
    rationale: "Reported speech is your highest-miss synthesis trick. Paired with correlative pairs (both / either / neither) — same 'two people / two facts' frame.",
    topic: "Synthesis / Transformation",
    subTopicWeights: {
      "reported-speech": 3,
      "correlative-preference": 3,
    },
    count: 6,
    topicRecap: {
      heading: "Reporting & Combining — what to look out for",
      watchOut: [
        "Reported speech (tenses + pronouns + time words): three shifts at once when converting direct speech.\nTense shifts BACK one step — is → was, has → had, will → would, did → had done. Modal verbs too (can → could, may → might, must → had to).\nKeep the subject pronoun in the new clause ('she was', not 'was').\nPronouns shift to the new viewpoint — 'I' usually becomes 'she' or 'he'.\nTime and place words shift — today → that day, yesterday → the previous day, tomorrow → the next day, here → there.",
        "Reported questions (yes/no vs wh-): two different shapes.\nYes/No questions take IF or WHETHER ('Are you going?' → 'asked IF she was going').\nWh- questions keep the wh-word but use STATEMENT order — drop the do/does/did helper and put subject before verb: 'Why did she sing?' → 'wanted to know WHY SHE HAD SUNG' (NOT 'why had she sung').\nClassic slip — students leave the question word order intact, which is wrong.",
        "Correlative pairs (both / either / neither / not only):\n'BOTH X and Y' → always plural verb ('Both Tom and Jerry ARE here').\n'NEITHER X NOR Y' / 'EITHER X OR Y' → verb matches the noun CLOSER to it. 'Neither the cake nor the BISCUITS were tasty' (biscuits closer → plural verb); 'Neither the biscuits nor the CAKE was tasty' (cake closer → singular verb).\n'Not only X but also Y' → both halves of the pair share the SAME grammatical structure (both nouns, or both verbs).",
      ],
    },
  },
  {
    label: "Synthesis — relative clauses, possessives, verb→noun",
    rationale: "Relative clauses, possessives, and verb→noun. Three structural transformations you keep slipping on — drilled together in one focused session.",
    topic: "Synthesis / Transformation",
    subTopicWeights: {
      "noun-phrase": 6,
    },
    count: 6,
    topicRecap: {
      heading: "Noun-Phrase Transformations — what to look out for",
      watchOut: [
        "Relative clauses: relative pronouns let you combine two sentences about the same noun.\nWHO replaces the subject pronoun (he / she) — 'The girl WHO won the prize is my sister'.\nWHOM replaces the object pronoun (him / her) — 'The girl WHOM I called won the prize'.\nWHOSE shows possession (his / her / its) — 'The girl WHOSE bag was lost'.\nWHICH is for things, not people.\nQuick test: try substituting back into a simple sentence — if 'he/she' fits, use WHO; 'him/her' → WHOM; 'his/her' → WHOSE.\nNon-essential clauses (you could remove them and the sentence still makes sense) need commas — 'Mrs Lee, WHOM the students praise, is a dedicated teacher'.",
        "Possessive transformation: turn 'X was/is ADJECTIVE' into 'X's NOUN'. The verb or adjective becomes a noun, and you add 's to the owner.\nSpelling matters — PSLE deducts for misspellings: diligent → diligence, complain → complaint, ill → illness, careless → carelessness, kind → kindness, generous → generosity, jealous → jealousy.\nAlways use apostrophe-s ('s) — 'the student's diligence' is correct, 'the students diligence' is wrong.",
        "Verb → noun: many strong verbs have a partner noun.\n'They DECIDED to go' → 'They made the DECISION to go'.\n'I REPORTED him to the teacher' → 'I made a REPORT against him to the teacher'.\nWatch for sentences that start with trigger verbs MADE, GAVE, TOOK, CAME, HAD, REACHED — they often signal this transformation, where the original verb is hiding inside as a noun.\nCommon pairs: made an ANNOUNCEMENT (announce), gave a SUGGESTION (suggest), took a DECISION (decide), came to a CONCLUSION (conclude), had a DISCUSSION (discuss).",
      ],
    },
  },
];

// David Lim — has two real Grammar MCQ patterns (pronouns 18%,
// tag-questions 18%) plus a synthesis weakness across reported-
// speech (42%), correlative (42%), subordinator (27%). Standard
// English Lumi split: Quiz 1 = Grammar pack, Quiz 2 = Synthesis pack.
// 3rd CTA: Comp Open-Ended section (58% miss — his #1 weakness but
// section-bound, surfaced as spotlight).
const DAVID_ENGLISH_COMBOS: LumiEnglishQuizCombo[] = [
  {
    label: "Grammar Rules — pronouns, tag questions, countable/uncountable",
    rationale: "Two rules to lock in: pronouns (whom / whose / herself) and tag questions (the 'isn't he?' check). Plus a top-up on countable / uncountable quantifiers.",
    topic: "Grammar MCQ",
    subTopicWeights: {
      "pronouns": 4,
      "tag-questions": 4,
      "countable/uncountable": 2,
    },
    count: 10,
    topicRecap: {
      heading: "Grammar Rules — what to look out for",
      watchOut: [
        "Pronouns: pick the form by the ROLE the pronoun plays in the sentence.\nWHO is for the doer — 'the boy WHO is running'.\nWHOM is for the receiver of an action — 'the boy WHOM I called' (quick check: if you can swap in 'him' or 'her', the word should be WHOM).\nWHOSE shows possession — 'the boy WHOSE bag is missing'.\nReflexive (himself / herself / themselves) ONLY when the subject and object are the SAME person — 'Mr Loh smiled at HIMSELF'. If a different person receives the action, use the regular pronoun (him / her).",
        "Tag questions: the short check at the end of a statement ('isn't he?', 'shall we?'). Two moves every time — mirror the main verb / auxiliary, then flip the polarity.\n'She IS happy' → 'isn't she?' (mirror IS, flip positive to negative).\n'He DIDN'T finish' → 'did he?' (mirror DID, flip negative to positive).\nWatch negative-meaning words — NEVER, HARDLY, SELDOM, RARELY, BARELY make the statement negative even without 'not', so the tag goes POSITIVE: 'She NEVER visits, DOES she?' (not 'doesn't she').\nTwo irregulars to memorise: 'Let's…' always pairs with 'shall we?', and 'I am' pairs with 'aren't I?'.",
        "Countable / uncountable: pick the quantifier by asking 'can I count this noun?'.\nCountable (books, ideas, students) → FEW, MANY, SEVERAL, A NUMBER OF, FEWER.\nUncountable (water, advice, luck, news, information, equipment, furniture, luggage) → LITTLE, MUCH, A GREAT DEAL OF, LESS.\nTrap: mass nouns that LOOK plural but aren't — NEWS, LUGGAGE, INFORMATION, EQUIPMENT all take 'little' / 'much', never 'few' / 'many'.\n'A number of pupils ARE absent' (plural verb) vs 'THE number of pupils IS rising' (singular verb) — same words, different verbs, watch the article.",
      ],
    },
  },
  {
    label: "Synthesis — reported speech, both/either/neither, because/although/if",
    rationale: "Reported speech + correlative pairs + joining sentences with because / although / if. The three synthesis tricks you've lost the most marks on.",
    topic: "Synthesis / Transformation",
    subTopicWeights: {
      "reported-speech": 2,
      "correlative-preference": 2,
      "subordinator": 2,
    },
    count: 6,
    topicRecap: {
      heading: "Synthesis Tricks — what to look out for",
      watchOut: [
        "Reported speech: converting direct speech to reported speech needs three shifts at once.\nTense shifts BACK — is/are → was/were, has/have → had, will → would, did → had done.\nPronouns shift to match the new viewpoint — 'I' usually becomes 'she' or 'he'.\nTime and place words shift too — today → that day, yesterday → the previous day, tomorrow → the next day, here → there.\nYes/No questions take IF or WHETHER ('Are you going?' → 'asked if she was going').\nWh- questions keep the wh-word but use STATEMENT order ('Why did she sing?' → 'why she had sung', NOT 'why had she sung').",
        "Correlative pairs (both / either / neither / not only): two rules.\n'BOTH X and Y' → always plural verb ('Both Tom and Jerry ARE here').\n'NEITHER X NOR Y' / 'EITHER X OR Y' → verb matches the noun CLOSER to it. 'Neither the cake nor the BISCUITS were tasty' (biscuits closer → plural); 'Neither the biscuits nor the CAKE was tasty' (cake closer → singular).\n'Not only X but also Y' → keep both halves together with the SAME grammatical structure (both nouns, or both verbs).",
        "Joining sentences with because / although / if: the joining word tells you the relationship between the two sentences. Pick by MEANING.\nCAUSE → because, since, due to, on account of, owing to ('She was late BECAUSE of the traffic').\nCONCESSION (happened DESPITE something) → although, even though, despite, in spite of ('She arrived on time ALTHOUGH the traffic was bad').\nCONDITION → if, unless, only with, only if, provided that ('You can go IF you finish your homework').\nPURPOSE → in order to, so that, so as to ('She studied hard SO THAT she could pass').\nGrammar trap: 'despite' and 'in spite of' are followed by a NOUN ('despite the rain', not 'despite it rained'); 'because of' takes a noun, 'because' takes a full clause.",
      ],
    },
  },
];

// Index of English combos by studentId. Kept separate from the
// science-keyed LUMI_QUIZ_COMBOS so existing callers don't have to
// know about subject yet — the Lumi quiz route will gain English
// support in a follow-up that reads from BOTH maps.
// Caleb (Felicia's kid) — 482 attempts, 85% accuracy. Grammar +
// Vocab MCQ are at 10% miss each — marginal, not a real pattern.
// Synthesis is his only individually-pickable weakness, concentrated
// in reported-speech (38%) and noun-phrase (50%). Same shape as Mark:
// no Grammar MCQ delta, split synthesis into two themed quizzes.
// 3rd CTA: Comp Open-Ended section (33% miss, section-bound).
const CALEB_ENGLISH_COMBOS: LumiEnglishQuizCombo[] = [
  {
    label: "Synthesis — reported speech",
    rationale: "Reported speech is your highest-miss synthesis trick. Same set of moves every time — backshift tense, swap subject pronoun, today → that day.",
    topic: "Synthesis / Transformation",
    subTopicWeights: {
      "reported-speech": 6,
    },
    count: 6,
    topicRecap: {
      heading: "Reported Speech — what to look out for",
      watchOut: [
        "Tense shift: when you change direct speech to reported speech, the verb tense ALWAYS shifts BACK by one step.\nPresent → past: is → was, have → had, can → could, will → would, may → might.\nPast simple → past perfect: did → had done, went → had gone, saw → had seen.\nModal verbs follow the same pattern: must → had to, shall → should.\n'She MISSED her appointment' (direct) → 'she HAD MISSED her appointment' (reported).\nSkip the tense shift only when the reported fact is a permanent truth ('The teacher said the Earth IS round').",
        "Subject + pronoun: the reported clause needs a clear subject, and the pronouns must match the new viewpoint.\n'Are you going?' (Ben to his sister) → 'Ben asked his sister IF SHE WAS going'.\nNotice SHE — not the original 'you'.\nThe SHE can't be dropped — 'if was going' is grammatically wrong.\nAlways start the reported clause with the right pronoun for the person being reported on.",
        "Time and place words: words that depend on the moment of speaking also shift.\ntoday → that day\nyesterday → the previous day / the day before\ntomorrow → the next day\nlast week → the previous week\nhere → there\nthis → that\nnow → then\n'I saw him YESTERDAY' (said today) → 'said he had seen him THE PREVIOUS DAY' (reported later).",
        "Reported questions (yes/no vs wh-): change the word order from question to statement.\nYes/No questions take IF or WHETHER: 'Are you coming?' → 'asked if I was coming'.\nWh- questions keep the wh-word but drop the do/does/did helper and use STATEMENT order: 'Why did she sing?' → 'wanted to know WHY SHE HAD SUNG' (NOT 'why HAD SHE SUNG').\nCommon slip: students leave the question word order intact, which is wrong.",
      ],
    },
  },
  {
    label: "Synthesis — relative clauses, possessives, verb→noun",
    rationale: "Relative clauses (who/whom/whose/which), possessives, and verb→noun. The three structural transformations you've been losing marks on.",
    topic: "Synthesis / Transformation",
    subTopicWeights: {
      "noun-phrase": 6,
    },
    count: 6,
    topicRecap: {
      heading: "Noun-Phrase Transformations — what to look out for",
      watchOut: [
        "Relative clauses (who / whom / whose / which): relative pronouns let you combine two sentences about the same noun.\nWHO replaces a subject pronoun (he / she) — 'The blender CAN make juices' → 'a blender WHICH can make juices'.\nWHOM replaces an object pronoun (him / her) — 'I called the girl' + 'The girl won the prize' → 'The girl WHOM I called won the prize'.\nWHOSE shows possession (his / her / its).\nWHICH is for things, not people.\nQuick test: try substituting back into a simple sentence — if 'he/she' fits, use WHO; 'him/her' → WHOM; 'his/her' → WHOSE.",
        "Commas around relative clauses: when the clause adds EXTRA (non-essential) info, wrap it in commas — 'Mrs Lee, WHOM the students praise, is a dedicated teacher'. The praise info is extra; the main sentence still makes sense without it.\nWhen the clause is ESSENTIAL (identifies which person/thing), don't use commas — 'The girl who won the prize is my sister'.",
        "Possessive transformation: turn 'X was/is ADJECTIVE' into 'X's NOUN'. The verb or adjective becomes a noun, and you add 's to the owner.\n'The student WAS diligent' → 'The student's DILIGENCE impressed the principal'.\nSpelling matters — PSLE deducts for misspellings: diligent → diligence, complain → complaint, decide → decision, ill → illness, careless → carelessness, kind → kindness, generous → generosity.",
        "Verb → noun: many strong verbs have a partner noun.\n'They DECIDED to go' → 'They made the DECISION to go'.\n'I REPORTED him to the teacher' → 'I made a REPORT against him'.\nLook for trigger verbs MADE, GAVE, TOOK, CAME, HAD, REACHED at the start of the new sentence — they often signal this transformation, where the original verb is hiding inside as a noun.\nCommon pairs: made an ANNOUNCEMENT (announce), gave a SUGGESTION (suggest), took a DECISION (decide), came to a CONCLUSION (conclude), had a DISCUSSION (discuss).",
      ],
    },
  },
];

// Kaiyangnggg — Synthesis (42%) is his ONLY real English weakness.
// Grammar MCQ is at 87% (the earlier 65% figure was an artifact of
// counting revision clones, which the dashboard chart filters out).
// So Quiz 2 is also synthesis, split by theme for topic coherence:
// reporting tricks vs noun-phrase transformations.
const KAIYANG_ENGLISH_COMBOS: LumiEnglishQuizCombo[] = [
  {
    label: "Synthesis — reported speech + both/either/neither",
    rationale: "Synthesis is your biggest English weakness (42% accuracy). Quiz 1 drills the two reporting/combining tricks — reported speech + correlative pairs.",
    topic: "Synthesis / Transformation",
    subTopicWeights: {
      "reported-speech": 3,
      "correlative-preference": 3,
    },
    count: 6,
    topicRecap: {
      heading: "Reporting & Combining — what to look out for",
      watchOut: [
        "Reported speech: converting direct speech to reported speech needs three shifts at once.\nTense shifts BACK — is/are → was/were, has/have → had, will → would, did → had done.\nPronouns shift to the new viewpoint — 'I' usually becomes 'she' or 'he'.\nTime and place words shift too — today → that day, yesterday → the previous day, here → there.\nYes/No questions take IF or WHETHER ('Are you going?' → 'asked if she was going').\nWh- questions keep the wh-word but use STATEMENT order ('Why did she sing?' → 'why she had sung', NOT 'why had she sung').",
        "Correlative pairs (both / either / neither): two rules.\n'BOTH X and Y' → always plural verb ('Both Tom and Jerry ARE here').\n'NEITHER X NOR Y' / 'EITHER X OR Y' → verb matches the noun CLOSER to it. 'Neither the cake nor the BISCUITS were tasty' (biscuits closer → plural); 'Neither the biscuits nor the CAKE was tasty' (cake closer → singular).\n'Not only X but also Y' → keep both halves together with the SAME grammatical structure.",
      ],
    },
  },
  {
    label: "Synthesis — relative clauses, possessives, verb→noun",
    rationale: "Second synthesis pack — noun-phrase transformations. Three structural moves that keep showing up in PSLE: relative clauses (who/whom/whose), possessive forms, and verb→noun.",
    topic: "Synthesis / Transformation",
    subTopicWeights: {
      "noun-phrase": 6,
    },
    count: 6,
    topicRecap: {
      heading: "Noun-Phrase Transformations — what to look out for",
      watchOut: [
        "Relative clauses: relative pronouns combine two sentences about the same noun.\nWHO replaces a subject pronoun (he / she) — 'The girl WHO won the prize'.\nWHOM replaces an object pronoun (him / her) — 'The girl WHOM I called'.\nWHOSE shows possession (his / her / its) — 'The girl WHOSE bag was lost'.\nWHICH is for things, not people.\nQuick test: if 'he/she' fits → WHO; 'him/her' → WHOM; 'his/her' → WHOSE.\nNon-essential clauses need commas — 'Mrs Lee, WHOM the students praise, is a dedicated teacher'.",
        "Possessive transformation: turn 'X was/is ADJECTIVE' into 'X's NOUN'.\n'The student WAS diligent' → 'The student's DILIGENCE impressed the principal'.\nSpelling matters — PSLE deducts: diligent → diligence, complain → complaint, decide → decision, ill → illness, careless → carelessness.\nAlways use apostrophe-s ('s) — 'the student's diligence' is correct, 'the students diligence' is wrong.",
        "Verb → noun: many strong verbs have a partner noun.\n'They DECIDED to go' → 'They made the DECISION to go'.\nLook for trigger verbs MADE, GAVE, TOOK, CAME, HAD, REACHED at the start of the new sentence — they often signal this transformation.\nCommon pairs: made an ANNOUNCEMENT (announce), gave a SUGGESTION (suggest), took a DECISION (decide), came to a CONCLUSION (conclude), had a DISCUSSION (discuss).",
      ],
    },
  },
];

export const LUMI_QUIZ_COMBOS_ENGLISH: Record<string, LumiEnglishQuizCombo[]> = {
  "cmm5wf91d000ryrxwaddlo6xh": DAVID_ENGLISH_COMBOS,    // David Lim
  "cmmbbyvs30004qa9yinn3drl6": MARK_ENGLISH_COMBOS,     // Mark Lim
  "cmq4xj0vm0029apq234jrmrh6": CALEB_ENGLISH_COMBOS,    // Caleb (Felicia's kid)
  "cmojzr4fu004gd4vnx8wmz6zk": KAIYANG_ENGLISH_COMBOS,  // Kaiyangnggg
  // student67 cloned from David's English combos — matches the Science
  // clone above; David's 199 English papers were cloned to student67 so
  // the same recommendations stay coherent across both subjects.
  "cmqg8upha0000l3ijfr3co6t8": DAVID_ENGLISH_COMBOS,    // student67
};

// ─── Derived (no-hand-written) combos ────────────────────────────────
//
// For students without a hand-written combo entry, derive 2 personali-
// sed quiz buttons from their top-2 weakest syllabus topics. The
// button generates a focused-practice paper via /api/focused-test
// (same path as the 3rd amber CTA), so no new server work is needed —
// the picker stays standardised. The point is *visual*: a kid with
// real Lumi data (Caleb at 482 English attempts, Faith at 641) should
// see 2 purple "personalised" buttons instead of one stretched-wide
// amber CTA.
//
// Hand-written combos are still richer (skill-tag pairing, weighted
// sub-topics, hand-tuned topic recap) — derived combos are the
// minimum-viable surface for kids who don't have a curated entry yet.

export type DerivedCombo = {
  label: string;
  rationale: string;
  topic: string;
  pct: number;       // miss-% for display in the rationale
  attempts: number;  // sample size, for the "light on data" guard
};

export function deriveCombosFromWeakTopics(
  weakTopics: Array<{ topic: string; pct: number; attempts?: number }>,
): DerivedCombo[] {
  // Take top 2 weakest topics with at least a minimum attempt count.
  // Below 5 attempts the % is too noisy to claim a real weakness.
  const usable = weakTopics.filter(t => (t.attempts ?? Infinity) >= 5);
  return usable.slice(0, 2).map(t => ({
    label: `${t.topic} — focused practice`,
    rationale: `Your top miss area${t.attempts ? ` over ${t.attempts} attempts` : ""} (avg. ${Math.round(t.pct)}%). 10-min targeted drill.`,
    topic: t.topic,
    pct: Math.round(t.pct),
    attempts: t.attempts ?? 0,
  }));
}

// Front-door helper. Returns hand-written combos when available
// (richer), otherwise auto-generated combos from the workshop cache
// (medium tier), otherwise derives from raw weakTopics (coarsest).
// Subject-aware so the English path uses LUMI_QUIZ_COMBOS_ENGLISH and
// Science uses LUMI_QUIZ_COMBOS.
export function getDisplayCombosForKid(
  studentId: string,
  subject: string,
  weakTopics: Array<{ topic: string; pct: number; attempts?: number }>,
): { handwritten: LumiQuizCombo[] | LumiEnglishQuizCombo[]; derived: DerivedCombo[] } {
  if (subject === "Science") {
    const hand = LUMI_QUIZ_COMBOS[studentId];
    if (hand?.length) return { handwritten: hand, derived: [] };
    const auto = AUTO_LUMI_COMBOS_SCIENCE[studentId];
    if (auto?.length) return { handwritten: auto, derived: [] };
    return { handwritten: [], derived: deriveCombosFromWeakTopics(weakTopics) };
  }
  if (subject === "English") {
    const hand = LUMI_QUIZ_COMBOS_ENGLISH[studentId];
    if (hand?.length) return { handwritten: hand, derived: [] };
    const auto = AUTO_LUMI_COMBOS_ENGLISH[studentId];
    if (auto?.length) return { handwritten: auto, derived: [] };
    return { handwritten: [], derived: deriveCombosFromWeakTopics(weakTopics) };
  }
  // Math / Chinese — no curated combos, derive from data.
  return { handwritten: [], derived: deriveCombosFromWeakTopics(weakTopics) };
}

export const LUMI_QUIZ_COMBOS: Record<string, LumiQuizCombo[]> = {
  "cmm5wf91d000ryrxwaddlo6xh": DAVID_COMBOS,   // David Lim
  "cmmbbyvs30004qa9yinn3drl6": MARK_COMBOS,    // Mark Lim (kid; admin@yunateach.com's student)
  "cmojzr4fu004gd4vnx8wmz6zk": KAIYANG_COMBOS, // Kaiyangnggg
  "cmnk7dkkj006z14p6yf06ohzm": JEREMIAH_COMBOS, // JeremiahSy
  "cmmfmmnwy00fdbbbfgm7k3wpn": EMILY_COMBOS,    // Emily lim (P4)
  // student67 cloned from David's combos — same level, same target gaps
  // for the test cohort. Swap to bespoke combos when we have a real
  // diagnosis for this kid.
  "cmqg8upha0000l3ijfr3co6t8": DAVID_COMBOS,   // student67
};
