// Fix synthesis-bank rows where the middle-position template carries a
// capitalised keyword. Two distinct fixes depending on where the
// keyword actually appears in the AI-generated answer:
//
//   ANSWER starts with the keyword → rebuild stem to START-POSITION
//     template (`**Keyword** ____\n____`).
//   ANSWER has keyword mid-sentence → just LOWERCASE the keyword in
//     the existing middle template (`____ **keyword** ____`).
//
// Pass --apply to write; default is dry-run.

import { prisma } from "../src/lib/db";

const PROPER = new Set(["I", "Mr", "Mrs", "Miss", "Ms"]);
const U32 = "_".repeat(32);

type Offender = {
  id: string;
  questionNum: string;
  paperTitle: string;
  oldStem: string;
  answer: string | null;
  rawKeyword: string;
  newStem: string;
  reason: "start-rebuild" | "lowercase-middle";
};

function findMiddleKeyword(stem: string): { rawKw: string; replaceStart: number; replaceEnd: number; lineStart: number; lineEnd: number } | null {
  const re = /\*\*([^*]{1,80})\*\*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stem)) !== null) {
    const start = m.index;
    const before = stem.lastIndexOf("\n", start);
    const after = stem.indexOf("\n", start);
    const lineStart = before === -1 ? 0 : before + 1;
    const lineEnd = after === -1 ? stem.length : after;
    const line = stem.slice(lineStart, lineEnd);
    const kwStartInLine = start - lineStart;
    const beforeOnLine = line.slice(0, kwStartInLine).replace(/\s/g, "");
    if (beforeOnLine.length === 0) continue; // start-position, ignore
    const first = m[1].trim().split(/[\s']+/)[0] ?? "";
    if (!first.match(/[A-Z]/) || (first[0] < "A" || first[0] > "Z")) continue;
    if (PROPER.has(first)) continue;
    return { rawKw: m[1], replaceStart: start, replaceEnd: start + m[0].length, lineStart, lineEnd };
  }
  return null;
}

function answerStartsWith(answer: string, keyword: string): boolean {
  const ans = answer.trim();
  const kw = keyword.trim();
  return ans.slice(0, kw.length).toLowerCase() === kw.toLowerCase()
    && (ans.length === kw.length || /[\s,.]/.test(ans[kw.length] ?? " "));
}

function lowercaseKeyword(kw: string): string {
  // Lowercase only the first character; preserve any inner words (e.g.
  // "Instead of" → "instead of"). For "No matter" → "no matter".
  return kw.charAt(0).toLowerCase() + kw.slice(1);
}

function buildStartTemplate(promptPrefix: string, capitalisedKw: string): string {
  // promptPrefix is the stem content BEFORE the answer line — usually
  // the two input sentences plus a blank line.
  return `${promptPrefix.replace(/\s+$/, "")}\n\n**${capitalisedKw}** ${U32}\n${U32}`;
}

function buildMiddleTemplate(promptPrefix: string, lowercaseKw: string): string {
  return `${promptPrefix.replace(/\s+$/, "")}\n\n${U32} **${lowercaseKw}** ${U32}`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const synthRows = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { in: ["Synthesis / Transformation", "Synthesis & Transformation"] },
      examPaper: { OR: [{ examType: "Synthetic" }, { title: { startsWith: "[Synthetic Bank]" } }] },
    },
    select: { id: true, questionNum: true, transcribedStem: true, answer: true, examPaper: { select: { title: true } } },
  });

  const offenders: Offender[] = [];
  for (const r of synthRows) {
    const stem = r.transcribedStem ?? "";
    if (!stem) continue;
    const hit = findMiddleKeyword(stem);
    if (!hit) continue;

    // Split stem into (prefix before answer-line) + (answer-line).
    const promptPrefix = stem.slice(0, hit.lineStart).replace(/\s+$/, "");
    const ans = r.answer ?? "";
    const startsWithKw = answerStartsWith(ans, hit.rawKw);

    let newStem: string;
    let reason: Offender["reason"];
    if (startsWithKw) {
      // Rebuild to start template; keyword stays capitalised at start.
      const capKw = hit.rawKw.charAt(0).toUpperCase() + hit.rawKw.slice(1);
      newStem = buildStartTemplate(promptPrefix, capKw);
      reason = "start-rebuild";
    } else {
      // Keep middle template but lowercase the keyword.
      const lcKw = lowercaseKeyword(hit.rawKw);
      newStem = buildMiddleTemplate(promptPrefix, lcKw);
      reason = "lowercase-middle";
    }
    if (newStem === stem) continue;
    offenders.push({
      id: r.id,
      questionNum: r.questionNum,
      paperTitle: r.examPaper.title ?? "",
      oldStem: stem,
      answer: r.answer,
      rawKeyword: hit.rawKw,
      newStem,
      reason,
    });
  }

  console.log(`Found ${offenders.length} synth-bank rows to fix.`);
  console.log(`  start-rebuild:    ${offenders.filter(o => o.reason === "start-rebuild").length}`);
  console.log(`  lowercase-middle: ${offenders.filter(o => o.reason === "lowercase-middle").length}`);
  console.log();

  for (const o of offenders) {
    console.log(`--- ${o.paperTitle} Q${o.questionNum} (id=${o.id}) — ${o.reason} ---`);
    console.log(`  KW:  **${o.rawKeyword}**`);
    console.log(`  ANS: ${(o.answer ?? "").slice(0, 100)}`);
    console.log(`  OLD: ${o.oldStem.replace(/\n/g, " ⏎ ")}`);
    console.log(`  NEW: ${o.newStem.replace(/\n/g, " ⏎ ")}`);
  }

  if (apply) {
    console.log(`\nApplying — updating ${offenders.length} rows…`);
    for (const o of offenders) {
      await prisma.examQuestion.update({ where: { id: o.id }, data: { transcribedStem: o.newStem } });
    }
    console.log("Done.");
  } else {
    console.log(`\n(dry-run — pass --apply to write)`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
