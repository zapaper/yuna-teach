// Stem-based classifier for the English Grammar MCQ master class.
// Maps a Grammar MCQ question to one of 6 sub-topics defined in
// the master class YAML.
//
// Sub-topic IDs (must match grammar-mcq.yaml):
//   tag-questions          — "…, isn't he?" / "…, shall we?"
//   noun-number-rules      — SVA + countable/uncountable quantifiers
//   pronouns               — reflexive / possessive / relative
//   verb-forms             — gerund vs infinitive, causative bare-inf
//   connectors-tenses      — cause/concession connectors + tense markers
//   idiomatic-prepositions — congratulate on, robbed of, under the
//                            impression
//
// Returns a sub-topic id, or null when the question doesn't have
// transcribed text or doesn't match any bucket.

const PREPS = new Set([
  "in","on","at","of","to","for","with","by","into","onto","upon","over","under",
  "through","between","among","amid","around","about","across","along","against",
  "beyond","beside","besides","behind","below","above","after","before","during",
  "via","off","out","towards","toward","up","down","near",
]);

const PRONOUNS = new Set([
  "he","she","it","we","they","you","i","him","her","his","hers","its","ours","theirs","mine","yours",
  "himself","herself","itself","themselves","ourselves","yourself","myself",
  "who","whom","whose","which","that","this","these","those",
  "everybody","anybody","nobody","somebody","everyone","anyone","no one","someone",
  "me","us",
]);

const CONNECTOR_RE = /^(if|as|unless|while|when|since|because|although|though|even though|in spite of|despite|owing to|because of|as soon as|other than|in addition to|in case of|in response to|in connection with|due to|resulting from|giving rise to|regardless of|with regard to|amid|contrary to|but|and|or|nor|yet|after|before|until|whereas|provided|so that|in order to)$/i;
const MODAL_RE = /^(had|did|should|would|might|may|will|shall|were|was|have|has|do|does|can|could|must)$/i;
const QUANT_RE = /^((a\s+)?(few|little|many|much|several|each|some|any|enough|none|all|most|fewer|less|number)|(a\s+(great\s+deal\s+of|large\s+number\s+of|large\s+amount\s+of|number\s+of))|(a\s+lot\s+of)|(plenty\s+of))$/i;
const SVA_VERB_RE = /^(is|are|was|were|has|have|has\s+been|have\s+been|am|been|do|does|did|have\s+had|has\s+had|will\s+be|will\s+have)$/i;

function looksLikeTag(stem: string, opts: string[]): boolean {
  const s = stem.trim();
  const endsWithQ = s.endsWith("?") || /\?["']/.test(s);
  if (!endsWithQ) return false;
  const allShort = opts.every(o => o.trim().split(/\s+/).length <= 3);
  if (!allShort) return false;
  const everyHasPronoun = opts.every(o => /\b(he|she|it|we|they|you|i)\b/i.test(o));
  if (everyHasPronoun) return true;
  const AUX_RE = /^(do|does|did|is|are|was|were|has|have|had|will|would|should|can|could|shall|may|might|must)(n't)?$/i;
  return opts.every(o => AUX_RE.test(o.trim()));
}

function looksLikeVerbForms(opts: string[]): boolean {
  const stripped = opts.map(o =>
    o.toLowerCase()
      .replace(/^to\s+(have\s+|be\s+)?/, "")
      .replace(/^having\s+/, "")
      .replace(/^been\s+/, "")
      .replace(/^to\s+/, "")
      .trim()
  );
  if (stripped.some(s => s.length < 2)) return false;
  const root = stripped[0].replace(/(ing|ied|ed|en|s|n)$/, "");
  if (root.length < 2) return false;
  const matches = stripped.filter(s => s.startsWith(root.slice(0, Math.max(3, root.length - 1)))).length;
  return matches >= 3;
}

export type GrammarSubTopic =
  | "tag-questions"
  | "noun-number-rules"
  | "pronouns"
  | "verb-forms"
  | "connectors-tenses"
  | "idiomatic-prepositions";

export function classifyGrammarMcq(stem: string | null, options: string[] | null): GrammarSubTopic | null {
  if (!stem) return null;
  const opts = (options ?? []).map(o => (o ?? "").trim()).filter(Boolean);
  if (opts.length !== 4) return null;
  const s = stem.trim();

  if (looksLikeTag(s, opts)) return "tag-questions";
  if (opts.every(o => SVA_VERB_RE.test(o))) return "noun-number-rules";
  if (opts.every(o => QUANT_RE.test(o))) return "noun-number-rules";
  if (opts.every(o => PRONOUNS.has(o.toLowerCase()))) return "pronouns";
  if (opts.every(o => PREPS.has(o.toLowerCase()))) return "idiomatic-prepositions";
  if (opts.every(o => CONNECTOR_RE.test(o))) return "connectors-tenses";
  if (opts.every(o => MODAL_RE.test(o))) return "connectors-tenses";
  if (looksLikeVerbForms(opts)) return "verb-forms";

  // Fallbacks via stem keywords.
  if (/\?/.test(s) && opts.some(o => /^(hasn't|isn't|wasn't|didn't|doesn't|won't|wouldn't|hadn't|shouldn't|aren't|weren't|haven't|will|shall)$/i.test(o.split(/\s+/)[0])) && opts.every(o => o.trim().split(/\s+/).length <= 3)) {
    return "tag-questions";
  }
  if (/\b(had it not been|no sooner|if only|if not for|but for)\b/i.test(s)) return "connectors-tenses";
  if (/\b(if|when|since|by the time|before|after|until|while|as soon as|no sooner)\b/i.test(s) && opts.some(o => /\b(had|have|will|would|should|might)\b/i.test(o))) {
    return "connectors-tenses";
  }
  if (/\b(saw|see|watch(ed)?|heard|hear|notice[ds]?|felt|feel|made|make|let|help(ed)?|witness(ed)?|caught)\b\s+\w+\s+___/i.test(s)) return "verb-forms";
  if (/\b(saw|see|watch(ed)?|heard|hear|made|witnessed|caught)\b/i.test(s) && opts.every(o => o.trim().split(/\s+/).length <= 3) && opts.every(o => /^[a-z]+(\s+[a-z]+)*$/i.test(o.trim()))) return "verb-forms";
  if (opts.every(o => /^(had|has|have|having|having\s+had)$/i.test(o.trim()))) return "verb-forms";
  if (opts.length === 4) {
    const lowers = opts.map(o => o.toLowerCase());
    const sharedWords = lowers[0].split(/\s+/).filter(w => lowers.every(s2 => s2.includes(w)));
    if (sharedWords.some(w => w.length >= 4)) return "verb-forms";
  }
  if (opts.every(o => o.trim().split(/\s+/).length === 1) && opts.filter(o => PREPS.has(o.toLowerCase())).length >= 3) {
    return "idiomatic-prepositions";
  }
  if (/\b(wish|wished|wishes|if only)\b/i.test(s)) return "connectors-tenses";
  if (/(as well as|in addition to|together with|along with|neither.*nor|either.*or|one of the|each of the|every|everyone|nobody)/i.test(s) && opts.some(o => /(is|are|was|were|has|have)/i.test(o))) {
    return "noun-number-rules";
  }
  if (/^\s*(having|being)\b/i.test(s) || /\b(suggest(s|ed)?\s+that)\b/i.test(s)) return "verb-forms";

  return null;
}
