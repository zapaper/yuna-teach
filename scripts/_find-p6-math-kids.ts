// Same filter as _find-p6-science-kids.ts but for math: P6 students
// with at least 15 ANALYSABLE wrong records (MCQ, or OEQ with marker
// notes ≥ 10 chars), excluding revision-mode papers. Output ranked
// by analysable-wrongs descending.
import { prisma } from "../src/lib/db";

const EXCLUDED = ["admin", "student555", "student666"];

(async () => {
  const kids = await prisma.user.findMany({
    where: { role: "STUDENT", level: 6, NOT: { name: { in: EXCLUDED, mode: "insensitive" } } },
    select: { id: true, name: true },
  });
  type Result = { name: string; papers: number; wrongs: number; analysable: number; avg: number };
  const out: Result[] = [];
  const mcqShape = /Student\s*:\s*\(?\d+\)?\s*,\s*Correct\s*:\s*\(?\d+\)?/i;
  for (const k of kids) {
    const papers = await prisma.examPaper.findMany({
      where: {
        assignedToId: k.id,
        markingStatus: { in: ["complete", "released"] },
        OR: [
          { subject: { contains: "math", mode: "insensitive" } },
          { subject: { contains: "mathematics", mode: "insensitive" } },
        ],
      },
      select: { metadata: true, questions: { select: { marksAwarded: true, marksAvailable: true, studentAnswer: true, markingNotes: true, transcribedOptions: true } } },
    });
    const nonRev = papers.filter(p => !(p.metadata as { revisionMode?: unknown } | null)?.revisionMode);
    if (nonRev.length === 0) continue;
    let totalAv = 0, totalAw = 0, wrong = 0, analysable = 0;
    for (const p of nonRev) {
      for (const q of p.questions) {
        const av = q.marksAvailable ?? 0, aw = q.marksAwarded ?? 0;
        totalAv += av; totalAw += aw;
        if (av === 0 || aw >= av) continue;
        if (q.studentAnswer === "__SKIPPED__") continue;
        wrong++;
        const opts = q.transcribedOptions as unknown;
        const optsLen = Array.isArray(opts) ? opts.length : 0;
        const isMcq = optsLen >= 2 || mcqShape.test(q.markingNotes ?? "");
        if (isMcq || (q.markingNotes && q.markingNotes.length >= 10)) analysable++;
      }
    }
    out.push({ name: k.name, papers: nonRev.length, wrongs: wrong, analysable, avg: totalAv > 0 ? totalAw/totalAv*100 : 0 });
  }
  const qualified = out.filter(r => r.analysable >= 15).sort((a, b) => b.analysable - a.analysable);
  const notQualified = out.filter(r => r.analysable < 15 && r.papers > 0).sort((a, b) => b.analysable - a.analysable);
  console.log(`P6 Math, ≥15 analysable wrongs — ${qualified.length} kids qualify:\n`);
  for (const r of qualified) {
    console.log(`  ${r.name.padEnd(25)}  papers=${String(r.papers).padStart(3)}  wrong=${String(r.wrongs).padStart(3)}  analysable=${String(r.analysable).padStart(3)}  avg=${r.avg.toFixed(0)}%`);
  }
  console.log(`\nBelow threshold (${notQualified.length} kids, top 10):\n`);
  for (const r of notQualified.slice(0, 10)) {
    console.log(`  ${r.name.padEnd(25)}  papers=${String(r.papers).padStart(3)}  wrong=${String(r.wrongs).padStart(3)}  analysable=${String(r.analysable).padStart(3)}  avg=${r.avg.toFixed(0)}%`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
