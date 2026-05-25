// Marking regression eval. Re-runs the marking pipeline against each
// paper in eval/snapshot.json and reports per-question diffs.
//
// Workflow:
//   1. For each snapshot, clone the source paper (new ExamPaper row +
//      copy submission files on disk). Clone is paperType="eval" so it
//      doesn't pollute the parent dashboard.
//   2. Reset marksAwarded / markingNotes on the clone's questions
//      (preserving studentAnswer + the canvas images on disk).
//   3. Trigger the appropriate marker (markQuizPaper / markExamPaper /
//      markFocusedTest) on the clone.
//   4. Compare per-question marksAwarded vs the snapshot. Notes text is
//      ignored — only the numbers matter.
//   5. By default, leave clones in place for inspection. Pass --cleanup
//      to delete them after the run.
//
// Usage:
//   npx tsx scripts/run-marking-eval.ts                  (run full eval)
//   npx tsx scripts/run-marking-eval.ts --cleanup        (delete clones after)
//   npx tsx scripts/run-marking-eval.ts --tolerance=0    (strict equality)
//   npx tsx scripts/run-marking-eval.ts --paper=cmpj...  (run one paper)

import { promises as fs } from "fs";
import path from "path";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { markQuizPaper, markExamPaper, markFocusedTest } from "../src/lib/marking";

const SNAPSHOT_PATH = path.join(__dirname, "..", "eval", "snapshot.json");
const RESULTS_PATH = path.join(__dirname, "..", "eval", "results.json");
const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(__dirname, "..", ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

type SnapshotQuestion = {
  questionNum: string;
  marksAvailable: number | null;
  marksAwarded: number | null;
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
};
type Snapshot = { generatedAt: string; papers: SnapshotPaper[] };

type DiffEntry = { questionNum: string; expected: number | null; actual: number | null; delta: number; pass: boolean };
type PaperResult = {
  sourceId: string;
  cloneId: string;
  title: string;
  expectedTotal: number;
  actualTotal: number;
  pass: boolean;
  matched: number;
  total: number;
  diffs: DiffEntry[];
};

function parseArgs() {
  const args = process.argv.slice(2);
  const cleanup = args.includes("--cleanup");
  const paper = args.find(a => a.startsWith("--paper="))?.split("=")[1];
  const tolArg = args.find(a => a.startsWith("--tolerance="))?.split("=")[1];
  const tolerance = tolArg !== undefined ? parseFloat(tolArg) : 0.5;
  return { cleanup, paper, tolerance };
}

// Copy a directory tree (Node 20+ has fs.cp; falling back to manual copy keeps
// the script working on older Node too).
async function copyDir(src: string, dst: string) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else if (entry.isFile()) await fs.copyFile(s, d);
  }
}

// Fetch all submission files for a source paper from the deployed app's
// /api/exam/<id>/submission endpoint and write them to a local directory.
// Used when running the eval locally against prod data — the marker reads
// from local disk, so the canvases need to be on disk first.
//
// Requires:
//   EVAL_REMOTE_BASE     — e.g. "https://www.markforyou.com"
//   EVAL_SESSION_COOKIE  — value of the yuna_session cookie (copy from
//                          browser dev tools while logged in as admin)
//
// Approach: call ?list=1 once to get the directory listing, then fetch
// each named file. Works for both quiz papers (per-question canvas
// files) and printable / scanned papers (per-page scans), since we
// stop guessing filenames and just mirror what the server has.
async function fetchRemoteSubmissionFiles(
  sourceId: string,
  dstSubDir: string,
): Promise<{ fetched: number; failed: number }> {
  const base = process.env.EVAL_REMOTE_BASE;
  const cookie = process.env.EVAL_SESSION_COOKIE;
  if (!base || !cookie) return { fetched: 0, failed: 0 };

  const headers = { cookie: `yuna_session=${cookie}` } as const;

  // Step 1: list the directory.
  let files: string[] = [];
  try {
    const listRes = await fetch(`${base}/api/exam/${sourceId}/submission?list=1`, { headers });
    if (!listRes.ok) {
      console.warn(`  remote list failed (${listRes.status}) — falling back to empty`);
      return { fetched: 0, failed: 1 };
    }
    const data = await listRes.json() as { files?: string[] };
    files = data.files ?? [];
  } catch (err) {
    console.warn(`  remote list error: ${(err as Error).message}`);
    return { fetched: 0, failed: 1 };
  }
  if (files.length === 0) return { fetched: 0, failed: 0 };

  await fs.mkdir(dstSubDir, { recursive: true });

  // Step 2: fetch each file via the existing per-file endpoint. Parse
  // the filename back into (page, subpart, type) so we can hit the
  // same handler that the marker eventually reads from on disk.
  let fetched = 0;
  let failed = 0;
  await Promise.all(files.map(async (file) => {
    // Filename shapes:
    //   page_N.jpg
    //   page_N_ink.png
    //   page_N_<label>.jpg
    //   page_N_<label>_ink.png
    const m = file.match(/^page_(\d+)(?:_([a-z0-9-]+))?(_ink)?\.(jpg|png)$/i);
    if (!m) return; // unknown shape — skip
    const page = m[1];
    const subpart = m[2] && m[2] !== "ink" ? m[2] : null;
    const isInk = !!m[3];
    const qs = new URLSearchParams({ page });
    if (subpart) qs.set("subpart", subpart);
    if (isInk) qs.set("type", "ink");
    try {
      const res = await fetch(`${base}/api/exam/${sourceId}/submission?${qs.toString()}`, { headers });
      if (!res.ok) { failed++; return; }
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(path.join(dstSubDir, file), buf);
      fetched++;
    } catch {
      failed++;
    }
  }));
  return { fetched, failed };
}

async function clonePaper(sourceId: string): Promise<string> {
  const source = await prisma.examPaper.findUnique({
    where: { id: sourceId },
    include: { questions: true },
  });
  if (!source) throw new Error(`source paper ${sourceId} not found`);

  const cloneTitle = `[EVAL] ${source.title} (${new Date().toISOString().slice(0, 16)})`;
  const clone = await prisma.examPaper.create({
    data: {
      title: cloneTitle,
      school: source.school,
      level: source.level,
      subject: source.subject,
      year: source.year,
      semester: source.semester,
      totalMarks: source.totalMarks,
      metadata: (source.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      pdfPath: source.pdfPath,
      pageCount: source.pageCount,
      userId: source.userId,
      assignedToId: source.assignedToId,
      // Carry the marking-relevant state but RESET the marking outputs.
      // The marker will re-populate marksAwarded / markingNotes.
      completedAt: source.completedAt,
      instantFeedback: source.instantFeedback,
      // "eval" paperType keeps these out of the parent dashboard's
      // activity lists (which only surface "quiz" / "focused" / etc.).
      paperType: "eval",
      examType: source.examType,
      visible: false,
      sourceExamId: source.id,
      questions: {
        create: source.questions.map(q => ({
          questionNum: q.questionNum,
          imageData: q.imageData,
          answer: q.answer,
          answerImageData: q.answerImageData,
          pageIndex: q.pageIndex,
          orderIndex: q.orderIndex,
          yStartPct: q.yStartPct,
          yEndPct: q.yEndPct,
          printableBounds: (q.printableBounds ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          marksAvailable: q.marksAvailable,
          // RESET marking outputs — preserve studentAnswer so the marker
          // grades the same input.
          marksAwarded: null,
          markingNotes: null,
          syllabusTopic: q.syllabusTopic,
          subTopic: q.subTopic,
          studentAnswer: q.studentAnswer,
          elaboration: q.elaboration,
          transcribedStem: q.transcribedStem,
          transcribedOptions: (q.transcribedOptions ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          transcribedOptionImages: (q.transcribedOptionImages ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          transcribedOptionTable: (q.transcribedOptionTable ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          transcribedSubparts: (q.transcribedSubparts ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          diagramImageData: q.diagramImageData,
          diagramBounds: (q.diagramBounds ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          sourceQuestionId: q.id,
        })),
      },
    },
    select: { id: true },
  });

  // Make canvas files available for the marker to read.
  //   Local mode: copy from the local SUBMISSIONS_DIR if files exist.
  //   Remote mode (EVAL_REMOTE_BASE set): fetch each file over HTTP from
  //                                       the deployed app and write into
  //                                       the clone's local sub-dir.
  const srcSubDir = path.join(SUBMISSIONS_DIR, sourceId);
  const dstSubDir = path.join(SUBMISSIONS_DIR, clone.id);
  if (process.env.EVAL_REMOTE_BASE) {
    const { fetched, failed } = await fetchRemoteSubmissionFiles(sourceId, dstSubDir);
    if (failed > 0) console.warn(`  remote fetch: ${fetched} files OK, ${failed} failed`);
    else process.stdout.write(`fetched=${fetched} `);
  } else {
    try {
      await copyDir(srcSubDir, dstSubDir);
    } catch (err) {
      // Some papers (MCQ-only printed) have no submission files. Not fatal.
      if ((err as { code?: string }).code !== "ENOENT") {
        console.warn(`  warning: failed to copy ${srcSubDir}: ${(err as Error).message}`);
      }
    }
  }
  return clone.id;
}

async function markClone(cloneId: string, paperType: string | null) {
  if (paperType === "quiz" || paperType === "mastery") {
    await markQuizPaper(cloneId);
  } else if (paperType === "focused") {
    await markFocusedTest(cloneId);
  } else {
    await markExamPaper(cloneId);
  }
}

async function evalPaper(snap: SnapshotPaper, tolerance: number, cleanup: boolean): Promise<PaperResult> {
  process.stdout.write(`\n[${snap.id}] ${snap.title} ... `);
  const cloneId = await clonePaper(snap.id);
  process.stdout.write(`cloned=${cloneId.slice(0, 10)}… `);
  await markClone(cloneId, snap.paperType);
  process.stdout.write(`marked. `);

  const cloneQs = await prisma.examQuestion.findMany({
    where: { examPaperId: cloneId },
    select: { questionNum: true, marksAwarded: true },
    orderBy: { orderIndex: "asc" },
  });
  const actualByNum = new Map(cloneQs.map(q => [q.questionNum, q.marksAwarded]));

  const diffs: DiffEntry[] = snap.questions.map(q => {
    const expected = q.marksAwarded;
    const actual = actualByNum.get(q.questionNum) ?? null;
    const delta = (actual ?? 0) - (expected ?? 0);
    const pass = Math.abs(delta) <= tolerance;
    return { questionNum: q.questionNum, expected, actual, delta, pass };
  });

  const matched = diffs.filter(d => d.pass).length;
  const expectedTotal = snap.questions.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);
  const actualTotal = cloneQs.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);
  const pass = matched === diffs.length;
  process.stdout.write(`${matched}/${diffs.length} ${pass ? "PASS" : "FAIL"} (total ${actualTotal} vs ${expectedTotal})\n`);

  if (!pass) {
    for (const d of diffs.filter(x => !x.pass)) {
      console.log(`  Q${d.questionNum}: expected ${d.expected}, got ${d.actual} (Δ${d.delta > 0 ? "+" : ""}${d.delta})`);
    }
  }

  if (cleanup) {
    await prisma.examPaper.delete({ where: { id: cloneId } });
    try { await fs.rm(path.join(SUBMISSIONS_DIR, cloneId), { recursive: true, force: true }); } catch {}
  }

  return { sourceId: snap.id, cloneId, title: snap.title, expectedTotal, actualTotal, pass, matched, total: diffs.length, diffs };
}

async function main() {
  const { cleanup, paper: paperFilter, tolerance } = parseArgs();
  const raw = await fs.readFile(SNAPSHOT_PATH, "utf8");
  const snapshot: Snapshot = JSON.parse(raw);
  let papers = snapshot.papers;
  if (paperFilter) papers = papers.filter(p => p.id === paperFilter);
  if (papers.length === 0) {
    console.error(`No papers matched. Run snapshot-eval-papers.ts first.`);
    process.exit(1);
  }

  console.log(`Eval: ${papers.length} paper(s), tolerance ±${tolerance} mark per question, cleanup=${cleanup}`);
  const results: PaperResult[] = [];
  for (const snap of papers) {
    try {
      results.push(await evalPaper(snap, tolerance, cleanup));
    } catch (err) {
      console.error(`[${snap.id}] FAILED:`, err instanceof Error ? err.message : err);
    }
  }

  const passed = results.filter(r => r.pass).length;
  const totalQ = results.reduce((s, r) => s + r.total, 0);
  const matchedQ = results.reduce((s, r) => s + r.matched, 0);
  console.log(`\n=== SUMMARY ===`);
  console.log(`Papers: ${passed}/${results.length} pass`);
  console.log(`Questions: ${matchedQ}/${totalQ} match within ±${tolerance} (${((matchedQ / totalQ) * 100).toFixed(1)}%)`);

  await fs.writeFile(
    RESULTS_PATH,
    JSON.stringify({ ranAt: new Date().toISOString(), tolerance, summary: { papers: { passed, total: results.length }, questions: { matched: matchedQ, total: totalQ } }, results }, null, 2),
  );
  console.log(`\nWrote ${RESULTS_PATH}`);

  if (passed < results.length) process.exit(1);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
