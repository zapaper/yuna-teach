// Pull a deep set of English grammar / vocab MCQ + Synthesis mistakes
// for social-media content. We want INTERESTING grammar rules, so we
// widen the net and keep everything with a useful explanation.

import { prisma } from "../src/lib/db";
import * as fs from "fs";
import * as path from "path";

type Row = {
  id: string;
  questionNum: string;
  marksAwarded: number | null;
  marksAvailable: number | null;
  syllabusTopic: string | null;
  subTopic: string | null;
  studentAnswer: string | null;
  answer: string | null;
  markingNotes: string | null;
  elaboration: string | null;
  transcribedStem: string | null;
  transcribedOptions: unknown;
  transcribedSubparts: unknown;
  examPaper: { id: string; title: string; subject: string | null };
};

function brief(s: string | null | undefined, n = 1500): string {
  if (!s) return "";
  return s.trim().replace(/\s+/g, " ").slice(0, n);
}
function formatOptions(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw.map((o, i) => `(${i + 1}) ${String(o)}`).join("  ");
}

const TARGET_TOPICS = new Set<string>([
  "Synthesis / Transformation",
  "Grammar MCQ",
  "Grammar Cloze",
  "Vocabulary MCQ",
  "Vocabulary Cloze MCQ",
  "Vocabulary Cloze",
  "Editing",
]);

(async () => {
  const rows = await prisma.examQuestion.findMany({
    where: {
      marksAwarded: { not: null },
      marksAvailable: { not: null, gt: 0 },
      studentAnswer: { not: null },
      examPaper: { subject: { contains: "English", mode: "insensitive" } },
    },
    select: {
      id: true, questionNum: true, marksAwarded: true, marksAvailable: true,
      syllabusTopic: true, subTopic: true,
      studentAnswer: true, answer: true,
      markingNotes: true, elaboration: true,
      transcribedStem: true, transcribedOptions: true, transcribedSubparts: true,
      examPaper: { select: { id: true, title: true, subject: true } },
    },
    take: 10000,
  });

  const buckets = new Map<string, Row[]>();
  for (const q of rows) {
    if (q.marksAwarded == null || q.marksAvailable == null) continue;
    if (q.marksAwarded >= q.marksAvailable) continue;
    const topic = q.syllabusTopic ?? "(untagged)";
    if (!TARGET_TOPICS.has(topic)) continue;
    // need a substantive explanation OR a clear right/wrong contrast
    const hasExplain = !!(q.elaboration && q.elaboration.length > 80) ||
                       !!(q.markingNotes && q.markingNotes.length > 30);
    if (!hasExplain) continue;
    if (!q.transcribedStem || q.transcribedStem.length < 10) continue;
    if (!q.studentAnswer || q.studentAnswer.trim().length < 1) continue;
    if (!buckets.has(topic)) buckets.set(topic, []);
    buckets.get(topic)!.push(q as Row);
  }

  console.log("=== ENGLISH GRAMMAR / VOCAB / SYNTHESIS — TOPIC COUNTS ===");
  for (const [t, list] of [...buckets.entries()].sort((a,b) => b[1].length - a[1].length)) {
    console.log(`  ${list.length.toString().padStart(4)}  ${t}`);
  }

  // Dump full list with rich fields, ordered by topic
  const dump: Record<string, unknown[]> = {};
  for (const [t, list] of buckets.entries()) {
    dump[t] = list.map(s => ({
      id: s.id,
      paper: s.examPaper.title,
      stem: brief(s.transcribedStem, 1000),
      options: formatOptions(s.transcribedOptions),
      studentAnswer: brief(s.studentAnswer, 600),
      correctAnswer: brief(s.answer, 600),
      marksAwarded: s.marksAwarded,
      marksAvailable: s.marksAvailable,
      markingNotes: brief(s.markingNotes, 1500),
      elaboration: brief(s.elaboration, 2500),
    }));
  }
  const out = path.join(process.cwd(), "scripts", "english-mistakes-dump.json");
  fs.writeFileSync(out, JSON.stringify(dump, null, 2));
  console.log(`\nDump written: ${out}`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
