// Classify every P6 / PSLE Grammar MCQ in the DB into one of 6
// sub-topic buckets matching the planned Grammar MCQ master class.
import { prisma } from "../src/lib/db";

type SubTopic =
  | "tag-questions"
  | "noun-number-rules"
  | "pronouns"
  | "verb-forms"
  | "connectors-tenses"
  | "idiomatic-prepositions"
  | "other";

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

// Connector phrases (cause / concession / contrast / time).
const CONNECTOR_RE = /^(if|as|unless|while|when|since|because|although|though|even though|in spite of|despite|owing to|because of|as soon as|other than|in addition to|in case of|in response to|in connection with|due to|resulting from|giving rise to|regardless of|with regard to|amid|contrary to|but|and|or|nor|yet|after|before|until|whereas|provided|so that|in order to)$/i;
// Lone modal/aux options — inversion or tense-shift questions.
const MODAL_RE = /^(had|did|should|would|might|may|will|shall|were|was|have|has|do|does|can|could|must)$/i;
// Quantifier options.
const QUANT_RE = /^((a\s+)?(few|little|many|much|several|each|some|any|enough|none|all|most|fewer|less|number)|(a\s+(great\s+deal\s+of|large\s+number\s+of|large\s+amount\s+of|number\s+of))|(a\s+lot\s+of)|(plenty\s+of))$/i;
// Verb conjugations for SVA — be / have / do families.
const SVA_VERB_RE = /^(is|are|was|were|has|have|has\s+been|have\s+been|am|been|do|does|did|have\s+had|has\s+had|will\s+be|will\s+have)$/i;

function looksLikeTag(stem: string, opts: string[]): boolean {
  const s = stem.trim();
  // The "?" may sit inside a quote (e.g. '"…, ___?" asked X.'). Detect
  // either form: stem ends with "?" OR contains '?"' / "?'" before
  // the reporting clause.
  const endsWithQ = s.endsWith("?") || /\?["']/.test(s);
  if (!endsWithQ) return false;
  const allShort = opts.every(o => o.trim().split(/\s+/).length <= 3);
  if (!allShort) return false;
  const everyHasPronoun = opts.every(o => /\b(he|she|it|we|they|you|i)\b/i.test(o));
  if (everyHasPronoun) return true;
  // Auxiliary-only tags: each option starts with do/does/did / is/are/was/were /
  // has/have/had / will/would/should / can/could / shall/might / hasn't etc.
  const AUX_RE = /^(do|does|did|is|are|was|were|has|have|had|will|would|should|can|could|shall|may|might|must)(n't)?$/i;
  const auxOnly = opts.every(o => AUX_RE.test(o.trim()));
  return auxOnly;
}

function looksLikeVerbForms(opts: string[]): boolean {
  // 3 or 4 options are forms of the same verb. Strip leading
  // "to / to have / to be / having / been" then compare prefixes.
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

function classify(stem: string, options: string[]): SubTopic {
  const s = (stem ?? "").trim();
  const opts = options.map(o => (o ?? "").trim()).filter(Boolean);
  const optsLower = opts.map(o => o.toLowerCase());
  if (opts.length !== 4) return "other";

  // ── 1. TAG QUESTIONS (strongest signal first; "?" + pronoun) ──
  if (looksLikeTag(s, opts)) return "tag-questions";

  // ── 2. NOUN NUMBER (SVA + quantifiers) ──
  if (opts.every(o => SVA_VERB_RE.test(o))) return "noun-number-rules";
  if (opts.every(o => QUANT_RE.test(o))) return "noun-number-rules";

  // ── 3. PRONOUNS ──
  if (opts.every(o => PRONOUNS.has(o.toLowerCase()))) return "pronouns";

  // ── 4. IDIOMATIC PREPOSITIONS ──
  if (opts.every(o => PREPS.has(o.toLowerCase()))) return "idiomatic-prepositions";

  // ── 5. CONNECTORS / TENSE MARKERS ──
  if (opts.every(o => CONNECTOR_RE.test(o))) return "connectors-tenses";
  if (opts.every(o => MODAL_RE.test(o))) return "connectors-tenses";

  // ── 6. VERB FORMS ──
  if (looksLikeVerbForms(opts)) return "verb-forms";

  // ── FALLBACKS via stem keywords ──
  // Stem has "?" anywhere + contraction-style options → still a tag question.
  if (/\?/.test(s) && opts.some(o => /^(hasn't|isn't|wasn't|didn't|doesn't|won't|wouldn't|hadn't|shouldn't|aren't|weren't|haven't|will|shall)$/i.test(o.split(/\s+/)[0])) && opts.every(o => o.trim().split(/\s+/).length <= 3)) {
    return "tag-questions";
  }
  // "Had it not been for", "No sooner had X", "If only X had" — connectors-tenses (inversion / consequence).
  if (/\b(had it not been|no sooner|if only|if not for|but for)\b/i.test(s)) return "connectors-tenses";
  // Subordinate "if / when / since" + options including modals → connectors-tenses.
  if (/\b(if|when|since|by the time|before|after|until|while|as soon as|no sooner)\b/i.test(s)
      && opts.some(o => /\b(had|have|will|would|should|might)\b/i.test(o))) {
    return "connectors-tenses";
  }
  // Causative / sensory verb (saw/heard/made/let/help/witnessed/caught X ___)
  // — almost always tests the verb form following the blank.
  if (/\b(saw|see|watch(ed)?|heard|hear|notice[ds]?|felt|feel|made|make|let|help(ed)?|witness(ed)?|caught|let)\b\s+\w+\s+___/i.test(s)) {
    return "verb-forms";
  }
  if (/\b(saw|see|watch(ed)?|heard|hear|made|made|witnessed|caught)\b/i.test(s)
      && opts.every(o => o.trim().split(/\s+/).length <= 3)
      && opts.every(o => /^[a-z]+(\s+[a-z]+)*$/i.test(o.trim()))) {
    // Tense/aspect-only short options (take/took/taken/has taken) → verb-forms
    return "verb-forms";
  }
  // Options share a clear verb root after stripping inflections (looser test).
  if (looksLikeVerbForms(opts)) return "verb-forms";
  // Have-family options ({had, has, have, having}) — verb-forms.
  if (opts.every(o => /^(had|has|have|having|having\s+had)$/i.test(o.trim()))) return "verb-forms";
  // All-tense options sharing a verb core (e.g. damaged / had damaged /
  // had been damaging) — verb-forms.
  if (opts.length === 4) {
    const lowers = opts.map(o => o.toLowerCase());
    const sharedWords = lowers[0].split(/\s+/).filter(w => lowers.every(s => s.includes(w)));
    if (sharedWords.some(w => w.length >= 4)) return "verb-forms";
  }
  // "similar to", "different from", "married to" etc. — preposition fallback when
  // options are short adjectival prepositions.
  if (opts.every(o => o.trim().split(/\s+/).length === 1)
      && opts.filter(o => PREPS.has(o.toLowerCase())).length >= 3) {
    return "idiomatic-prepositions";
  }
  // Wishes / regrets — past perfect chain.
  if (/\b(wish|wished|wishes|if only)\b/i.test(s)) return "connectors-tenses";
  // "X, as well as Y" / "Neither X nor Y" / "Everyone except X" subjects → SVA.
  if (/(as well as|in addition to|together with|along with|neither.*nor|either.*or|one of the|each of the|every|everyone|nobody)/i.test(s)
      && opts.some(o => /(is|are|was|were|has|have)/i.test(o))) {
    return "noun-number-rules";
  }
  // "Having + V-en" / "Being + V-en" / participle openers → verb-forms.
  if (/^\s*(having|being)\b/i.test(s) || /\b(suggest(s|ed)?\s+that)\b/i.test(s)) {
    return "verb-forms";
  }

  return "other";
}

(async () => {
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      subject: { contains: "english", mode: "insensitive" },
      OR: [{ level: "Primary 6" }, { level: "PSLE" }],
      NOT: { title: { startsWith: "Test Quiz" } },
    },
    select: { id: true, title: true },
  });
  type Row = { count: number; psle: number; school: number };
  const counts: Record<SubTopic, Row> = {
    "tag-questions": { count: 0, psle: 0, school: 0 },
    "noun-number-rules": { count: 0, psle: 0, school: 0 },
    "pronouns": { count: 0, psle: 0, school: 0 },
    "verb-forms": { count: 0, psle: 0, school: 0 },
    "connectors-tenses": { count: 0, psle: 0, school: 0 },
    "idiomatic-prepositions": { count: 0, psle: 0, school: 0 },
    "other": { count: 0, psle: 0, school: 0 },
  };
  // Dedupe by normalised stem so the same question copy-pasted across
  // dozens of practice papers counts ONCE. PSLE source wins ties so the
  // PSLE pool number reflects the actual paper origins.
  const normStem = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
  type Entry = { stem: string; opts: string[]; isPsle: boolean; paper: string };
  const dedup = new Map<string, Entry>();
  let totalRaw = 0;
  for (const p of papers) {
    const isPsle = /\bPSLE\b/i.test(p.title);
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id, syllabusTopic: "Grammar MCQ" },
      select: { transcribedStem: true, transcribedOptions: true },
    });
    for (const q of qs) {
      totalRaw++;
      const opts = (q.transcribedOptions as string[] | null) ?? [];
      if (!q.transcribedStem || opts.length !== 4) continue;
      const k = normStem(q.transcribedStem);
      if (k.length < 20) continue;
      const existing = dedup.get(k);
      if (!existing || (isPsle && !existing.isPsle)) {
        dedup.set(k, { stem: q.transcribedStem, opts, isPsle, paper: p.title });
      }
    }
  }
  const total = dedup.size;
  const otherSamples: Array<{ paper: string; q: string; opts: string[] }> = [];
  for (const e of dedup.values()) {
    const sub = classify(e.stem, e.opts);
    counts[sub].count++;
    if (e.isPsle) counts[sub].psle++; else counts[sub].school++;
    if (sub === "other" && otherSamples.length < 25) {
      otherSamples.push({ paper: e.paper, q: e.stem.slice(0, 120), opts: e.opts });
    }
  }
  console.log(`\nRaw question rows: ${totalRaw}, unique stems after dedup: ${total}`);
  console.log(`\nGrammar MCQ classification across ${papers.length} P6/PSLE English papers — ${total} questions total\n`);
  console.log(`Topic                       | All   | PSLE  | School`);
  console.log(`----------------------------|-------|-------|-------`);
  for (const k of Object.keys(counts) as SubTopic[]) {
    const r = counts[k];
    console.log(`${k.padEnd(28)}|${String(r.count).padStart(6)} |${String(r.psle).padStart(6)} |${String(r.school).padStart(6)}`);
  }
  const top6 = total - counts.other.count;
  console.log(`\nCoverage by the 6 buckets: ${top6}/${total} = ${((top6 / total) * 100).toFixed(1)}%`);
  console.log(`\nSample 'other' questions:`);
  for (const s of otherSamples.slice(0, 12)) {
    console.log(`  [${s.paper.slice(0, 38)}] ${s.q}…`);
    console.log(`     options: ${s.opts.join(" | ")}`);
  }
  await prisma.$disconnect();
})();
