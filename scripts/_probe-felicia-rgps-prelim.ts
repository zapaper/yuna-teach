// Locate Felicia's RGPS Prelim 2025 submission and see why marking
// went badly. Felicia = Felicia Chua (Caleb's mother). RGPS = Raffles
// Girls' Primary School, Prelim 2025 = P6 EOY-equivalent (some SG
// schools call their late-year mock "Prelim").
//
// Strategy:
//   1. Find Felicia's user id + her kids' ids.
//   2. Look up papers assigned to those kids with a title matching
//      RGPS/Raffles/Prelim + 2025.
//   3. For each candidate, print: paper meta, question count, marks
//      awarded vs available, markingNotes summary, and any obvious
//      marker-failure signals (all-zero, "could not read" notes,
//      hallucination flags, blank-clamp trips).

import "dotenv/config";
import { prisma } from "../src/lib/db";

(async () => {
  // 1) Felicia user id.
  const feliciaCandidates = await prisma.user.findMany({
    where: {
      role: "PARENT",
      OR: [
        { name: { contains: "felicia", mode: "insensitive" } },
        { displayName: { contains: "felicia", mode: "insensitive" } },
        { email: { contains: "felicia", mode: "insensitive" } },
      ],
    },
    select: {
      id: true, name: true, displayName: true, email: true,
      parentLinks: { select: { student: { select: { id: true, name: true } } } },
    },
  });
  console.log(`Felicia candidates: ${feliciaCandidates.length}`);
  for (const f of feliciaCandidates) {
    const kidNames = f.parentLinks.map(l => `${l.student.name} (${l.student.id})`).join(", ");
    console.log(`  ${f.name}  (${f.displayName ?? "—"})  ${f.email ?? "—"}  · kids: ${kidNames}`);
  }
  const felicia = feliciaCandidates[0];
  if (!felicia) { console.log(`No Felicia found`); return; }
  const kidIds = felicia.parentLinks.map(l => l.student.id);
  console.log(`\nUsing Felicia = ${felicia.name} (${felicia.id})  · ${kidIds.length} linked kid(s)`);

  // 2) Papers assigned to those kids matching RGPS / Raffles / Prelim / 2025.
  const papers = await prisma.examPaper.findMany({
    where: {
      assignedToId: { in: kidIds },
      AND: [
        // NULL doesn't count as "not in" in Prisma — need this OR
        // form to include master papers whose paperType is null.
        { OR: [{ paperType: null }, { paperType: { notIn: ["eval", "quiz", "focused"] } }] },
        { OR: [
          { title: { contains: "RGPS", mode: "insensitive" } },
          { title: { contains: "raffles", mode: "insensitive" } },
          { title: { contains: "prelim", mode: "insensitive" } },
        ] },
      ],
    },
    select: {
      id: true, title: true, subject: true, level: true,
      markingStatus: true, paperType: true,
      createdAt: true, completedAt: true,
      metadata: true,
      _count: { select: { questions: true } },
      assignedToId: true,
    },
    orderBy: { createdAt: "desc" },
  });
  console.log(`\nCandidate papers: ${papers.length}`);
  for (const p of papers) {
    console.log(`  ${p.createdAt.toISOString().slice(0, 10)}  ${(p.markingStatus ?? "null").padEnd(11)}  ${(p.paperType ?? "master").padEnd(8)}  qs=${p._count.questions.toString().padStart(3)}  ${p.subject}  → ${p.title.slice(0, 60)}`);
  }
  if (papers.length === 0) return;

  // 3) Pick the most likely = most recent, has "RGPS" or "Raffles" or "Prelim" + "2025"
  const rgps2025 = papers.filter(p => /2025/.test(p.title) && /(RGPS|Raffles|Prelim)/i.test(p.title));
  const target = rgps2025[0] ?? papers[0];
  console.log(`\n== Deep-dive on: ${target.title} (${target.id}) ==`);
  console.log(`  subject=${target.subject}  level=${target.level}  paperType=${target.paperType}  status=${target.markingStatus}`);
  console.log(`  created ${target.createdAt.toISOString()}  · completed ${target.completedAt?.toISOString() ?? "—"}`);
  const meta = target.metadata as Record<string, unknown> | null;
  if (meta) console.log(`  metadata keys: ${Object.keys(meta).join(", ")}`);

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: target.id },
    orderBy: [{ orderIndex: "asc" }],
    select: {
      id: true, questionNum: true,
      transcribedOptions: true, answer: true, studentAnswer: true,
      marksAwarded: true, marksAvailable: true, markingNotes: true,
      imageData: true, transcribedSubparts: true, diagramImageData: true,
      syllabusTopic: true, subTopic: true,
    },
  });
  const totalAvail = qs.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
  const totalAwarded = qs.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);
  const nUnmarked = qs.filter(q => q.marksAwarded == null).length;
  const nZero = qs.filter(q => q.marksAwarded === 0).length;
  console.log(`\n  ${qs.length} questions · ${totalAwarded}/${totalAvail} marks (${totalAvail > 0 ? (totalAwarded / totalAvail * 100).toFixed(0) : "—"}%)`);
  console.log(`  unmarked: ${nUnmarked}  ·  0-mark: ${nZero}  ·  imageData present: ${qs.filter(q => (q.imageData?.length ?? 0) > 0).length}`);

  // Failure-signal scan
  const canNotRead = qs.filter(q => (q.markingNotes ?? "").toLowerCase().includes("could not read"));
  const blank = qs.filter(q => !q.studentAnswer && (q.markingNotes ?? "").toLowerCase().includes("blank"));
  const emptyMeta = qs.filter(q => (q.markingNotes ?? "").trim().length === 0);
  console.log(`  "could not read" notes: ${canNotRead.length}`);
  console.log(`  "blank" notes + null studentAnswer: ${blank.length}`);
  console.log(`  empty markingNotes: ${emptyMeta.length}`);

  // Show first 8 questions in detail
  console.log(`\n  ── first 8 questions ──`);
  for (const q of qs.slice(0, 8)) {
    const optsLen = Array.isArray(q.transcribedOptions) ? q.transcribedOptions.length : 0;
    const kind = optsLen >= 2 ? "MCQ" : "OEQ";
    const notes = (q.markingNotes ?? "").slice(0, 150).replace(/\s+/g, " ");
    console.log(`    Q${q.questionNum.padStart(3)} [${kind}] ${(q.syllabusTopic ?? "?").slice(0, 22).padEnd(22)} awarded=${(q.marksAwarded ?? "—").toString().padStart(4)}/${(q.marksAvailable ?? "—")}  sa=${q.studentAnswer ? `"${q.studentAnswer.slice(0, 40)}"` : "—"}  img=${q.imageData?.length ?? 0}`);
    if (notes) console.log(`         notes: ${notes}${(q.markingNotes?.length ?? 0) > 150 ? " …" : ""}`);
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
