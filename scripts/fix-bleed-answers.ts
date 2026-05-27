// One-shot: re-split the `answer` field for the 3 Science c-segment
// questions where the original split missed and the full multi-part
// answer key was stored. Mirrors splitAnswerBySubParts from
// src/lib/extraction.ts so the filter is identical to extraction-time
// behaviour.
//
// Strategy per case:
//   Q7c   subs=[b], answer "(b) X" — relabel (b) → (c). This is a
//                                    mis-tag from structure detect;
//                                    the content IS the c-segment.
//   Q34bc subs=[], answer "(a)X | (b)Y" — re-split keeping (b)+(c).
//                                          Only (b) survives because
//                                          there's no (c) in source.
//   Q37c  subs=[], answer "(a)X | (b)Y" — re-split keeping (c).
//                                          Both labels stripped because
//                                          there's no (c) — kept blank.
//
// Pass --apply to write. Dry-run by default.

import { prisma } from "../src/lib/db";

type Mode = "filter" | "relabel-only";

const TARGETS: Array<{
  paperTitlePrefix: string;
  questionNum: string;
  mode: Mode;
  // For relabel-only: rename (oldLetter) → (newLetter) in the answer text.
  relabelFrom?: string;
  relabelTo?: string;
}> = [
  // Nanyang Q7c — mis-tagged. Subs=[b] but the content IS c.
  { paperTitlePrefix: "P5 Science WA1 Nanyang", questionNum: "7c", mode: "relabel-only", relabelFrom: "b", relabelTo: "c" },
  // Rosyth Q34bc — multi-part answer key, keep b+c portions.
  { paperTitlePrefix: "Rosyth", questionNum: "34bc", mode: "filter" },
  // Rosyth Q37c — multi-part answer key, keep c only.
  { paperTitlePrefix: "Rosyth", questionNum: "37c", mode: "filter" },
];

/** Same algorithm as splitAnswerBySubParts in src/lib/extraction.ts. */
function splitAnswerBySubParts(fullAnswer: string, subParts: string): string {
  if (!fullAnswer || !subParts) return "";
  const letters = subParts.split("");
  const partRegex = /(?:^|[\s|])\(?([a-z])\)\s*/gi;
  const positions: { label: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = partRegex.exec(fullAnswer)) !== null) {
    positions.push({ label: m[1].toLowerCase(), start: m.index });
  }
  if (positions.length === 0) return fullAnswer;
  const parts: { label: string; text: string }[] = [];
  for (let i = 0; i < positions.length; i++) {
    const end = i + 1 < positions.length ? positions[i + 1].start : fullAnswer.length;
    parts.push({ label: positions[i].label, text: fullAnswer.slice(positions[i].start, end).trim().replace(/\s*\|\s*$/, "") });
  }
  return parts.filter(p => letters.includes(p.label)).map(p => p.text).join(" | ");
}

function relabel(answer: string, from: string, to: string): string {
  // Replace label markers like "(b)" / "b)" / " b)" at start or after pipe/whitespace.
  // Only replaces the LABEL, not the content. Trailing space preserved.
  const re = new RegExp(`((?:^|[\\s|])\\(?)${from}(\\)\\s*)`, "gi");
  return answer.replace(re, `$1${to}$2`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  for (const target of TARGETS) {
    const q = await prisma.examQuestion.findFirst({
      where: {
        questionNum: target.questionNum,
        examPaper: {
          sourceExamId: null, paperType: null,
          title: { startsWith: target.paperTitlePrefix },
        },
      },
      select: { id: true, questionNum: true, answer: true, examPaper: { select: { title: true } } },
    });
    if (!q) {
      console.log(`[skip] no match for "${target.paperTitlePrefix}" Q${target.questionNum}`);
      continue;
    }
    const before = q.answer ?? "";
    let after = before;
    if (target.mode === "relabel-only" && target.relabelFrom && target.relabelTo) {
      after = relabel(before, target.relabelFrom, target.relabelTo);
    } else if (target.mode === "filter") {
      const segLetters = target.questionNum.replace(/^\d+/, "");
      after = splitAnswerBySubParts(before, segLetters);
      if (!after) {
        console.log(`[skip] ${q.examPaper.title.slice(0, 40)} Q${q.questionNum} — filter("${segLetters}") on answer returned empty; leaving alone`);
        continue;
      }
    }
    if (after === before) {
      console.log(`[noop] ${q.examPaper.title.slice(0, 40)} Q${q.questionNum} — no change`);
      continue;
    }
    console.log(`[${apply ? "FIX " : "DRY "}] ${q.examPaper.title.slice(0, 40)} Q${q.questionNum}`);
    console.log(`         before:  ${before.slice(0, 240)}`);
    console.log(`         after:   ${after.slice(0, 240)}`);
    if (apply) {
      await prisma.examQuestion.update({ where: { id: q.id }, data: { answer: after } });
    }
  }
  if (!apply) console.log(`\nDry-run. Pass --apply to write.`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
