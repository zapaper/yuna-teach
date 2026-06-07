// Pull a handful of interesting / tricky math + science questions
// for social-media content. Bias toward:
//   - MCQ where many students get fooled (a wrong answer is a clue)
//   - OEQs with a rich AI elaboration (3+ marks, has stepwise reasoning)
//   - Real exam papers (Prelim / WA / EOY), not daily quiz boilerplate
//   - Variety of topics so the set doesn't all look the same

import { prisma } from "../src/lib/db";
import * as fs from "fs";
import * as path from "path";

type Row = {
  id: string;
  questionNum: string;
  marksAvailable: number | null;
  syllabusTopic: string | null;
  studentAnswer: string | null;
  answer: string | null;
  markingNotes: string | null;
  elaboration: string | null;
  transcribedStem: string | null;
  transcribedOptions: unknown;
  transcribedSubparts: unknown;
  examPaper: { id: string; title: string; subject: string | null };
};

function brief(s: string | null | undefined, n = 2000): string {
  if (!s) return "";
  return s.trim().replace(/\s+/g, " ").slice(0, n);
}
function fmtOpts(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw.map((o, i) => `(${i + 1}) ${String(o)}`).join("  ");
}

(async () => {
  const rows = await prisma.examQuestion.findMany({
    where: {
      // need a real stem we can show
      transcribedStem: { not: null },
      // tricky = explanation exists OR student got it wrong
      OR: [
        { elaboration: { not: null } },
        { markingNotes: { not: null } },
      ],
      // skip rows the student didn't even attempt
      studentAnswer: { not: null },
      examPaper: {
        OR: [
          { subject: { contains: "Math", mode: "insensitive" } },
          { subject: { contains: "Science", mode: "insensitive" } },
        ],
      },
    },
    select: {
      id: true, questionNum: true, marksAvailable: true,
      syllabusTopic: true,
      studentAnswer: true, answer: true,
      markingNotes: true, elaboration: true,
      transcribedStem: true, transcribedOptions: true, transcribedSubparts: true,
      examPaper: { select: { id: true, title: true, subject: true } },
    },
    take: 8000,
  });

  function subjectOf(s: string | null): "math" | "science" | "other" {
    const t = (s ?? "").toLowerCase();
    if (t.includes("math")) return "math";
    if (t.includes("science")) return "science";
    return "other";
  }
  function isReal(title: string): boolean {
    return /Prelim|WA\d|EOY|End of Year|PSLE/i.test(title);
  }
  function isMcq(opts: unknown, answer: string | null): boolean {
    if (Array.isArray(opts) && opts.length === 4) return true;
    const a = (answer ?? "").trim().replace(/[().]/g, "");
    return ["1","2","3","4"].includes(a);
  }
  // "Tricky" = real-exam, with a rich explanation, and either:
  //   - the student got it wrong (so the wrong answer is a clue), OR
  //   - it's a high-mark OEQ (3+ marks) with a substantive elaboration
  function score(q: Row): number {
    let s = 0;
    if (isReal(q.examPaper.title)) s += 3;
    if ((q.marksAvailable ?? 0) >= 3) s += 2;
    if ((q.elaboration ?? "").length > 400) s += 2;
    if ((q.markingNotes ?? "").length > 200) s += 1;
    // prefer cases where stem itself is short enough to read on a phone
    const stemLen = (q.transcribedStem ?? "").length;
    if (stemLen > 60 && stemLen < 400) s += 1;
    return s;
  }
  const buckets: Record<"math" | "science", Row[]> = { math: [], science: [] };
  for (const q of rows) {
    const subj = subjectOf(q.examPaper.subject);
    if (subj === "other") continue;
    // need a usable stem and explanation
    if (!q.transcribedStem || q.transcribedStem.length < 30) continue;
    if (!((q.elaboration ?? "").length > 200 || (q.markingNotes ?? "").length > 150)) continue;
    if (q.studentAnswer && q.studentAnswer.trim().length === 0) continue;
    buckets[subj].push(q as Row);
  }
  // Rank and dedupe by stem to avoid showing the same Q twice
  // (we have a lot of repeated test paper questions across attempts).
  function pickTop(arr: Row[], n: number): Row[] {
    const ranked = [...arr].sort((a, b) => score(b) - score(a));
    const seen = new Set<string>();
    const out: Row[] = [];
    for (const q of ranked) {
      const key = (q.transcribedStem ?? "").slice(0, 100);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(q);
      if (out.length >= n) break;
    }
    return out;
  }
  // Spread across topics so we don't get e.g. 10 Heat questions.
  function pickTopByTopic(arr: Row[], n: number, perTopicCap = 2): Row[] {
    const ranked = [...arr].sort((a, b) => score(b) - score(a));
    const seenStem = new Set<string>();
    const topicCount = new Map<string, number>();
    const out: Row[] = [];
    for (const q of ranked) {
      const key = (q.transcribedStem ?? "").slice(0, 100);
      if (seenStem.has(key)) continue;
      const t = q.syllabusTopic ?? "(untagged)";
      const c = topicCount.get(t) ?? 0;
      if (c >= perTopicCap) continue;
      seenStem.add(key);
      topicCount.set(t, c + 1);
      out.push(q);
      if (out.length >= n) break;
    }
    return out;
  }
  const mathTop = pickTopByTopic(buckets.math, 12);
  const sciTop = pickTopByTopic(buckets.science, 12);

  console.log(`MATH candidates: ${buckets.math.length}, picked ${mathTop.length}`);
  console.log(`SCIENCE candidates: ${buckets.science.length}, picked ${sciTop.length}`);

  const out = {
    math: mathTop.map(q => ({
      id: q.id, paper: q.examPaper.title, topic: q.syllabusTopic,
      marks: q.marksAvailable, mcq: isMcq(q.transcribedOptions, q.answer),
      stem: brief(q.transcribedStem, 800),
      options: fmtOpts(q.transcribedOptions),
      studentAnswer: brief(q.studentAnswer, 300),
      correctAnswer: brief(q.answer, 500),
      markingNotes: brief(q.markingNotes, 1500),
      elaboration: brief(q.elaboration, 2500),
    })),
    science: sciTop.map(q => ({
      id: q.id, paper: q.examPaper.title, topic: q.syllabusTopic,
      marks: q.marksAvailable, mcq: isMcq(q.transcribedOptions, q.answer),
      stem: brief(q.transcribedStem, 800),
      options: fmtOpts(q.transcribedOptions),
      studentAnswer: brief(q.studentAnswer, 300),
      correctAnswer: brief(q.answer, 500),
      markingNotes: brief(q.markingNotes, 1500),
      elaboration: brief(q.elaboration, 2500),
    })),
  };
  const file = path.join(process.cwd(), "scripts", "tricky-math-science-dump.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Dump: ${file}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
