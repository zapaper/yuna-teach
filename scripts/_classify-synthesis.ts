// Classify Synthesis & Transformation questions into the 6 umbrella
// sub-topics defined in english-synthesis-tricks.yaml:
//
//   reported-speech         Direct ↔ indirect speech (backshift)
//   subordinator            Concession (although/despite/no matter/while/however/but)
//                           + Cause (because/since/as/due to/owing to/so/thanks to)
//                           + Condition (if/unless/provided/as long as)
//                           + Purpose (in order to / so that)
//   correlative-preference  Inclusion (both/either/neither/not only/as well as)
//                           + Preference (would rather/prefer/preference)
//   participle-clauses      Having + V-ed, Not having + V-ed, AND bare -ing
//                           participles (seeing/hearing/fearing/being/connecting…)
//                           Upon/After/Before/On + -ing.
//   substitution-inversion  Instead of, except, much to, no other, little did,
//                           never did, no sooner…than
//   noun-phrase             Relative clauses (who/whom/which/whose/where)
//                           + Possessive transformations (the X's …)
//                           + Verb→noun conversions (made / came / took / gave
//                             / had / did)
//                           + Cleft / passive topicalisation ("what X enjoys")
//
// Anything genuinely outside those 6 lands in `misc`. Pass --apply to
// rewrite ExamQuestion.subTopic across every matching row.

import { prisma } from "../src/lib/db";

type Bucket =
  | "reported-speech"
  | "subordinator"
  | "correlative-preference"
  | "participle-clauses"
  | "substitution-inversion"
  | "noun-phrase"
  | "misc";

function extractBolds(stem: string | null): string[] {
  if (!stem) return [];
  return [...stem.matchAll(/\*\*([^*]{1,80})\*\*/g)]
    .map(m => m[1].trim().toLowerCase().replace(/\s+/g, " "))
    .filter(s => s.length > 0);
}

function bucketForKeyword(kw: string): Bucket | null {
  // REPORTED SPEECH — speech verbs in the bold keyword.
  if (/\b(asked|told|wanted to know|wondered|requested|enquired|inquired|said)\b/.test(kw))
    return "reported-speech";

  // SUBORDINATOR (concession + cause + condition + purpose + contrast connectives)
  // Concession
  if (/^although\b|^even though\b|^though\b/.test(kw)) return "subordinator";
  if (/^despite\b|^in spite of\b/.test(kw)) return "subordinator";
  if (/^no matter\b/.test(kw)) return "subordinator";
  if (/^however\b|^but\b|^yet\b/.test(kw)) return "subordinator";
  if (/^while\b/.test(kw)) return "subordinator";
  // Cause
  if (/^because\b|^because of\b/.test(kw)) return "subordinator";
  if (/^due to\b|^owing to\b|^on account of\b/.test(kw)) return "subordinator";
  if (/^as a result of\b|^thanks to\b/.test(kw)) return "subordinator";
  if (/^since\b|^as\b/.test(kw) && kw.length < 4) return "subordinator";
  if (/^so\b/.test(kw) && kw.length < 5) return "subordinator";
  // Condition
  if (/^if\b|^unless\b/.test(kw)) return "subordinator";
  if (/^only if\b|^only when\b|^only with\b|^only after\b|^only by\b/.test(kw)) return "subordinator";
  if (/^otherwise\b|^provided\b|^as long as\b/.test(kw)) return "subordinator";
  if (/^in the event\b/.test(kw)) return "subordinator";
  // Purpose
  if (/^in order to\b|^so as to\b|^so that\b/.test(kw)) return "subordinator";

  // CORRELATIVE-PREFERENCE
  // Inclusion / correlative pairs
  if (/^both\b|^neither\b|^either\b|^not only\b/.test(kw)) return "correlative-preference";
  if (/^or\b/.test(kw) && kw.length < 6) return "correlative-preference";
  if (/^as well as\b/.test(kw)) return "correlative-preference";
  // Preference
  if (/^would rather\b|^would prefer\b|^rather than\b/.test(kw)) return "correlative-preference";
  if (/^prefer\b|prefers\b|^preference\b/.test(kw)) return "correlative-preference";

  // PARTICIPLE-CLAUSES (Having + V-ed + bare -ing participles + Upon/After/Before/On + -ing)
  if (/^having\b|^not having\b/.test(kw)) return "participle-clauses";
  if (/^being\b|^not being\b/.test(kw)) return "participle-clauses";
  if (/^upon \w+ing\b|^on \w+ing\b|^after \w+ing\b|^before \w+ing\b|^while \w+ing\b/.test(kw))
    return "participle-clauses";
  // Bare -ing participle as the opener (Seeing / Hearing / Realising / etc.)
  if (/^(seeing|hearing|fearing|feeling|realising|realizing|noticing|knowing|believing|thinking|wanting|needing|wishing|enjoying|worrying|connecting|finishing|reaching|arriving|finding|holding|carrying|driving|running|walking|sitting|standing|looking|watching|reading|writing|playing|working|studying|listening|smelling|tasting)\b/.test(kw))
    return "participle-clauses";

  // SUBSTITUTION-INVERSION
  if (/^instead of\b/.test(kw)) return "substitution-inversion";
  if (/^except\b/.test(kw)) return "substitution-inversion";
  if (/^much to\b/.test(kw)) return "substitution-inversion";
  if (/^little did\b|^never did\b|^never has\b|^never have\b|^never had\b|^seldom\b|^rarely\b/.test(kw))
    return "substitution-inversion";
  if (/^no other\b|^no sooner\b/.test(kw)) return "substitution-inversion";
  if (/^hardly\b|^scarcely\b/.test(kw)) return "substitution-inversion";

  // NOUN-PHRASE (relative + possessive + verb→noun + cleft/passive)
  // Relative
  if (/^which\b|^who\b|^whom\b|^whose\b|^where\b/.test(kw)) return "noun-phrase";
  // Possessive opener — "The X's" or bare "X's"
  if (/^the \w+'s\b/.test(kw) || /\w+'s\b/.test(kw)) return "noun-phrase";
  // Verb → noun conversion openers (the most-tested PSLE form)
  if (/^made\b|^came\b|^took\b|^gave\b|^did\b|^had\b|^reported the\b|^admitted to\b/.test(kw))
    return "noun-phrase";
  // Cleft / pseudo-cleft
  if (/^what \w+\b|^it is\b|^it was\b|^the only\b|^everyone found\b/.test(kw)) return "noun-phrase";
  // Wish + past (close to cleft for our taxonomy)
  if (/^i wish\b|^he wishes\b|^she wishes\b|^they wish\b/.test(kw)) return "noun-phrase";

  return null;
}

function classify(stem: string | null): { bucket: Bucket; matchedOn: string | null } {
  const bolds = extractBolds(stem);
  for (const b of bolds) {
    const hit = bucketForKeyword(b);
    if (hit) return { bucket: hit, matchedOn: b };
  }
  // Stem-level fallbacks for patterns the bold doesn't always carry.
  if (stem) {
    if (/\b(asked|told|requested|wanted to know|wondered|enquired|inquired)\b/i.test(stem))
      return { bucket: "reported-speech", matchedOn: "(stem speech verb)" };
    if (/\b(which|whom|whose)\b/i.test(stem))
      return { bucket: "noun-phrase", matchedOn: "(stem relative)" };
  }
  return { bucket: "misc", matchedOn: null };
}

async function main() {
  const apply = process.argv.includes("--apply");
  // Tag both the source-paper template rows and the student-attempt
  // clones — the picker reads subTopic off the source rows; clones
  // need it for revision grouping. Both inherit syllabusTopic from
  // extraction so the filter catches them.
  const qs = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { in: ["Synthesis / Transformation", "Synthesis & Transformation"] },
    },
    select: {
      id: true, transcribedStem: true, subTopic: true,
      examPaper: { select: { level: true, visible: true } },
    },
  });
  console.log(`${qs.length} Synthesis & Transformation questions to classify\n`);

  const buckets = new Map<string, { count: number; samples: { stem: string; matchedOn: string | null }[] }>();
  const updates: { id: string; subTopic: string }[] = [];
  const miscBolds = new Map<string, number>();

  for (const q of qs) {
    const { bucket, matchedOn } = classify(q.transcribedStem);
    const b = buckets.get(bucket) ?? { count: 0, samples: [] };
    b.count++;
    if (b.samples.length < 3) b.samples.push({ stem: (q.transcribedStem ?? "").slice(0, 140), matchedOn });
    buckets.set(bucket, b);
    if (bucket !== "misc") updates.push({ id: q.id, subTopic: bucket });
    else {
      for (const kw of extractBolds(q.transcribedStem)) {
        miscBolds.set(kw, (miscBolds.get(kw) ?? 0) + 1);
      }
    }
  }

  console.log("Buckets:\n");
  for (const [name, b] of [...buckets.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${b.count.toString().padStart(4)}  ${name}`);
    for (const s of b.samples) {
      const m = s.matchedOn ? `  [matched: "${s.matchedOn}"]` : "  [no match]";
      console.log(`         ${s.stem.replace(/\n/g, " ⏎ ")}${m}`);
    }
  }

  console.log(`\nTop 25 bolded keywords still in MISC bucket:`);
  for (const [kw, count] of [...miscBolds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${count.toString().padStart(4)}  ${kw}`);
  }

  console.log(`\n${updates.length} questions would be tagged (misc rows left untouched).`);

  if (apply) {
    console.log(`\nApplying — writing subTopic to ${updates.length} rows…`);
    // Chunk into transactions of 200 to avoid hitting Prisma's parameter
    // limit on Neon when migrating ~1000 rows at once.
    const CHUNK = 200;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const slice = updates.slice(i, i + CHUNK);
      await prisma.$transaction(slice.map(u =>
        prisma.examQuestion.update({ where: { id: u.id }, data: { subTopic: u.subTopic } })
      ));
      console.log(`  ${Math.min(i + CHUNK, updates.length)} / ${updates.length}`);
    }
    console.log("Done.");
  } else {
    console.log(`\n(dry run — pass --apply to write)`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
