// Pull common mistakes from marking data across English, Math, Science.
// Goal: surface real, social-media-shareable question + wrong-answer + AI explanation rows.

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

function classify(s: string | null | undefined): "math" | "science" | "english" | "other" {
  const lower = (s ?? "").toLowerCase();
  if (lower.includes("math")) return "math";
  if (lower.includes("science")) return "science";
  if (lower.includes("english")) return "english";
  return "other";
}

function brief(s: string | null | undefined, n = 600): string {
  if (!s) return "";
  return s.trim().replace(/\s+/g, " ").slice(0, n);
}

function formatOptions(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw.map((o, i) => `  (${i + 1}) ${String(o)}`).join("\n");
}

function formatSubparts(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw
    .filter((sp): sp is { label: string; text: string } =>
      !!sp && typeof sp === "object" && "label" in sp &&
      !String((sp as { label: string }).label).startsWith("_"))
    .map(sp => `  (${sp.label}) ${sp.text}`)
    .join("\n");
}

(async () => {
  // Pull a wide net of partial-credit / wrong OEQ + MCQ rows that have a real
  // student answer and an AI elaboration or marking note (= the explanation we
  // can repurpose for social media).
  const rows = await prisma.examQuestion.findMany({
    where: {
      marksAwarded: { not: null },
      marksAvailable: { not: null, gt: 0 },
      studentAnswer: { not: null },
      // we want the model to have judged it wrong / partial
    },
    select: {
      id: true, questionNum: true, marksAwarded: true, marksAvailable: true,
      syllabusTopic: true, subTopic: true,
      studentAnswer: true, answer: true,
      markingNotes: true, elaboration: true,
      transcribedStem: true, transcribedOptions: true, transcribedSubparts: true,
      examPaper: { select: { id: true, title: true, subject: true } },
    },
    take: 5000,
  });

  type Bucket = { math: Row[]; science: Row[]; english: Row[] };
  const mistakes: Bucket = { math: [], science: [], english: [] };

  for (const q of rows) {
    if (q.marksAwarded == null || q.marksAvailable == null) continue;
    if (q.marksAwarded >= q.marksAvailable) continue;
    const subj = classify(q.examPaper.subject);
    if (subj === "other") continue;
    // must have a useful explanation
    const hasExplain = !!(q.markingNotes && q.markingNotes.length > 30) ||
                       !!(q.elaboration && q.elaboration.length > 30);
    if (!hasExplain) continue;
    // must have a stem we can show
    if (!q.transcribedStem || q.transcribedStem.length < 15) continue;
    // student answer must be substantive
    if (!q.studentAnswer || q.studentAnswer.trim().length < 1) continue;
    mistakes[subj].push(q as Row);
  }

  // Group by syllabus topic, count frequency
  function topicCounts(bucket: Row[]): { topic: string; count: number; sample: Row[] }[] {
    const map = new Map<string, Row[]>();
    for (const r of bucket) {
      const t = r.syllabusTopic ?? "(untagged)";
      if (!map.has(t)) map.set(t, []);
      map.get(t)!.push(r);
    }
    return [...map.entries()]
      .map(([topic, items]) => ({ topic, count: items.length, sample: items.slice(0, 3) }))
      .sort((a, b) => b.count - a.count);
  }

  const out: Record<string, ReturnType<typeof topicCounts>> = {
    math: topicCounts(mistakes.math),
    science: topicCounts(mistakes.science),
    english: topicCounts(mistakes.english),
  };

  console.log("=== SUMMARY ===");
  for (const subj of ["english", "math", "science"] as const) {
    console.log(`\n${subj.toUpperCase()}: ${mistakes[subj].length} marked-wrong rows with explanations`);
    for (const row of out[subj].slice(0, 12)) {
      console.log(`  ${row.count.toString().padStart(4)}  ${row.topic}`);
    }
  }

  // Dump rich JSON for the markdown writer
  const dumpPath = path.join(process.cwd(), "scripts", "common-mistakes-dump.json");
  const dump = {
    english: out.english.slice(0, 15).map(g => ({
      topic: g.topic,
      count: g.count,
      examples: g.sample.map(s => ({
        id: s.id,
        paper: s.examPaper.title,
        stem: brief(s.transcribedStem, 800),
        options: formatOptions(s.transcribedOptions),
        subparts: formatSubparts(s.transcribedSubparts),
        studentAnswer: brief(s.studentAnswer, 400),
        correctAnswer: brief(s.answer, 400),
        marksAwarded: s.marksAwarded,
        marksAvailable: s.marksAvailable,
        markingNotes: brief(s.markingNotes, 1500),
        elaboration: brief(s.elaboration, 1500),
      })),
    })),
    math: out.math.slice(0, 15).map(g => ({
      topic: g.topic,
      count: g.count,
      examples: g.sample.map(s => ({
        id: s.id,
        paper: s.examPaper.title,
        stem: brief(s.transcribedStem, 800),
        options: formatOptions(s.transcribedOptions),
        subparts: formatSubparts(s.transcribedSubparts),
        studentAnswer: brief(s.studentAnswer, 400),
        correctAnswer: brief(s.answer, 400),
        marksAwarded: s.marksAwarded,
        marksAvailable: s.marksAvailable,
        markingNotes: brief(s.markingNotes, 1500),
        elaboration: brief(s.elaboration, 1500),
      })),
    })),
    science: out.science.slice(0, 15).map(g => ({
      topic: g.topic,
      count: g.count,
      examples: g.sample.map(s => ({
        id: s.id,
        paper: s.examPaper.title,
        stem: brief(s.transcribedStem, 800),
        options: formatOptions(s.transcribedOptions),
        subparts: formatSubparts(s.transcribedSubparts),
        studentAnswer: brief(s.studentAnswer, 400),
        correctAnswer: brief(s.answer, 400),
        marksAwarded: s.marksAwarded,
        marksAvailable: s.marksAvailable,
        markingNotes: brief(s.markingNotes, 1500),
        elaboration: brief(s.elaboration, 1500),
      })),
    })),
  };
  fs.writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
  console.log(`\nDump written: ${dumpPath}`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
