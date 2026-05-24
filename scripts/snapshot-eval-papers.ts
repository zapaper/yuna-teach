// Snapshot the current marked state of each paper in eval/corpus.json.
// Writes eval/snapshot.json — the ground-truth baseline that the eval
// runner compares re-marked clones against.
//
// Usage:
//   npx tsx scripts/snapshot-eval-papers.ts
//   npx tsx scripts/snapshot-eval-papers.ts cmpj... cmpj...   (override corpus)
//
// Only captures the numbers worth comparing — marksAwarded per question
// + total score. Marking notes and studentAnswer text are deliberately
// not snapshotted (AI wording will vary on re-mark; we only care that
// the scoring agrees).

import { promises as fs } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";

const CORPUS_PATH = path.join(__dirname, "..", "eval", "corpus.json");
const SNAPSHOT_PATH = path.join(__dirname, "..", "eval", "snapshot.json");

type CorpusEntry = { id: string; note?: string };
type Corpus = { papers: CorpusEntry[] };

type SnapshotQuestion = {
  questionNum: string;
  marksAvailable: number | null;
  marksAwarded: number | null;
  // syllabusTopic captured for sanity-checking the tagging pipeline
  // (separate from the marking pipeline but worth tracking).
  syllabusTopic: string | null;
};

type SnapshotPaper = {
  id: string;
  title: string;
  subject: string | null;
  level: string | null;
  paperType: string | null;
  totalMarks: string | null;
  score: number | null;
  questionCount: number;
  questions: SnapshotQuestion[];
  capturedAt: string;
  note?: string;
};

async function loadCorpus(cliIds: string[]): Promise<CorpusEntry[]> {
  if (cliIds.length > 0) return cliIds.map(id => ({ id }));
  const raw = await fs.readFile(CORPUS_PATH, "utf8");
  const corpus: Corpus = JSON.parse(raw);
  return corpus.papers;
}

async function snapshotPaper(entry: CorpusEntry): Promise<SnapshotPaper | { error: string; id: string }> {
  const paper = await prisma.examPaper.findUnique({
    where: { id: entry.id },
    select: {
      id: true,
      title: true,
      subject: true,
      level: true,
      paperType: true,
      totalMarks: true,
      score: true,
      questions: {
        select: {
          questionNum: true,
          marksAvailable: true,
          marksAwarded: true,
          syllabusTopic: true,
          orderIndex: true,
        },
        orderBy: { orderIndex: "asc" },
      },
    },
  });
  if (!paper) return { id: entry.id, error: "paper not found" };
  return {
    id: paper.id,
    title: paper.title,
    subject: paper.subject,
    level: paper.level,
    paperType: paper.paperType,
    totalMarks: paper.totalMarks,
    score: paper.score,
    questionCount: paper.questions.length,
    questions: paper.questions.map(q => ({
      questionNum: q.questionNum,
      marksAvailable: q.marksAvailable,
      marksAwarded: q.marksAwarded,
      syllabusTopic: q.syllabusTopic,
    })),
    capturedAt: new Date().toISOString(),
    note: entry.note,
  };
}

async function main() {
  const cliIds = process.argv.slice(2).filter(a => !a.startsWith("-"));
  const entries = await loadCorpus(cliIds);
  console.log(`Snapshotting ${entries.length} paper(s)...`);

  const snapshots: SnapshotPaper[] = [];
  const errors: { id: string; error: string }[] = [];
  for (const entry of entries) {
    const res = await snapshotPaper(entry);
    if ("error" in res) {
      console.warn(`  ${entry.id}: ${res.error}`);
      errors.push(res);
      continue;
    }
    const sumAwarded = res.questions.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);
    const sumAvailable = res.questions.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
    console.log(`  ${res.id} [${res.subject ?? "?"} ${res.level ?? "?"}] ${res.title}`);
    console.log(`    ${res.questionCount} questions · score ${sumAwarded}/${sumAvailable}${res.score !== null ? ` (paper.score=${res.score})` : ""}`);
    snapshots.push(res);
  }

  await fs.mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true });
  await fs.writeFile(
    SNAPSHOT_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), papers: snapshots, errors }, null, 2),
  );
  console.log(`\nWrote ${SNAPSHOT_PATH} (${snapshots.length} papers, ${errors.length} errors)`);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
