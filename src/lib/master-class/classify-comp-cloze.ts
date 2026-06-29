// Answer-driven sub-topic classifier for English Comprehension Cloze.
// Maps a Comp Cloze question to one of 5 sub-topics defined from the
// Lumi-pattern mining work (eval/english-classifiers/comp-cloze-
// patterns.json). Returns null when the answer doesn't fit cleanly
// — caller falls back to AI tagging for those.
//
// Sub-topic IDs:
//   connector              — clause / sentence linking words
//                            (when, because, although, however, so, or)
//   preposition            — verb/noun + prep collocations
//                            (in, on, at, of, to, for, with, by, …)
//   pronoun-reference      — pronouns referring back to antecedents
//                            (he, she, it, our, their, his, hers, whom)
//   subject-verb-agreement — singular/plural verb forms in context
//                            (is, are, has, have, was, were)
//   content-word           — the meaningful word (verb / noun / adj /
//                            adv) where meaning has to fit the
//                            passage. Fallback bucket when none of
//                            the function-word categories match.

export type CompClozeSubTopic =
  | "connector"
  | "preposition"
  | "pronoun-reference"
  | "subject-verb-agreement"
  | "content-word";

// Function-word vocabularies. Kept tight + lowercased for fast set
// lookups. Multi-word answers (e.g. "in spite of") are matched via
// the CONNECTOR_RE / PREP_RE patterns separately.

const PREPS = new Set([
  "in","on","at","of","to","for","with","by","into","onto","upon","over","under",
  "through","between","among","amid","around","about","across","along","against",
  "beyond","beside","besides","behind","below","above","after","before","during",
  "via","off","out","towards","toward","up","down","near","from","as","like",
]);

const PRONOUNS = new Set([
  "he","she","it","we","they","you","i","him","her","his","hers","its","ours","theirs","mine","yours",
  "himself","herself","itself","themselves","ourselves","yourself","myself",
  "who","whom","whose","which","that","these","those",
  "everybody","anybody","nobody","somebody","everyone","anyone","someone",
  "me","us","my","your","our","their","one","another",
]);

const CONNECTORS = new Set([
  "and","or","but","nor","yet","so",
  "if","when","while","whenever","whereas","since","because","although","though",
  "unless","until","whether","whereby","once","as","than","that",
  "however","therefore","moreover","furthermore","nevertheless","besides","instead",
  "meanwhile","otherwise","also","still","then","also","too",
  "before","after",
]);

// Multi-word connector phrases — checked AFTER the bare-word set
// since single-word "as"/"that"/"so" are common but ambiguous and
// the multi-word forms are unambiguous.
const MULTIWORD_CONNECTORS = [
  /^even though$/i,
  /^as soon as$/i,
  /^in spite of$/i,
  /^so that$/i,
  /^as long as$/i,
  /^as well as$/i,
  /^as if$/i,
  /^in addition$/i,
  /^on the other hand$/i,
  /^in contrast$/i,
  /^by the time$/i,
];

const SVA_VERBS = new Set([
  "is","are","was","were","has","have","am","do","does","did","be","been","being",
  "isn't","aren't","wasn't","weren't","hasn't","haven't","doesn't","didn't","don't",
]);

// Hints in the stem that we're in SVA territory rather than content-
// verb territory (e.g. a quantifier like "each of the students" / "one
// of the boys" / "neither X nor Y").
const SVA_STEM_HINTS = [
  /\b(?:each|every|one|neither|either|none|nobody|nothing|everybody|everyone|everything)\b\s+(?:of\s+)?(?:the\s+)?\w+/i,
  /\b(?:both|several|many|few|some|most|all)\s+(?:of\s+)?(?:the\s+)?\w+/i,
  /\b(?:there|here)\b/i, // existential "there is/are"
];

function normaliseAnswer(answer: string): string {
  return answer
    .replace(/^[\s"'(]+|[\s"'.,;:?!)]+$/g, "")
    .toLowerCase()
    .trim();
}

/** Classify a Comprehension Cloze question by its answer + stem. */
export function classifyCompCloze(stem: string | null, answer: string | null): CompClozeSubTopic | null {
  if (!answer) return null;
  const a = normaliseAnswer(answer);
  if (a.length === 0) return null;
  const s = (stem ?? "").trim();

  // Multi-word answer → check connector phrases first (single-word
  // function words don't include spaces).
  if (a.includes(" ")) {
    if (MULTIWORD_CONNECTORS.some(re => re.test(a))) return "connector";
    // Multi-word + not a connector phrase = content word (e.g. "fell
    // down", "set out", "took advantage of").
    return "content-word";
  }

  // Single-word answer fast paths.
  if (PREPS.has(a)) return "preposition";
  if (PRONOUNS.has(a)) return "pronoun-reference";
  if (CONNECTORS.has(a)) return "connector";

  // SVA — only when both the answer is an SVA verb AND the stem looks
  // like an SVA test. Bare "is/are/has/have" can also fill content-
  // verb slots ("She IS a doctor" — that's just be-as-copula, not an
  // SVA test); the stem hint is what disambiguates.
  if (SVA_VERBS.has(a) && SVA_STEM_HINTS.some(re => re.test(s))) {
    return "subject-verb-agreement";
  }

  // Fallback — meaningful word the kid had to pull from passage
  // context. The biggest bucket by design; classifier shape mirrors
  // the Lumi pattern data ("vocabulary words that seem related but
  // don't fit" sits here).
  return "content-word";
}
