// Cross-kid probe for the "ratio / fraction reference-whole" trap that
// Mark + David's Lumi diagnoses identified. Goal: see if this is a
// niche-kid problem or a P6 cohort-wide weakness.
//
// Definition of in-scope wrong: P6 math wrong record on a question
// whose syllabusTopic OR transcribedStem mentions ratio/fraction/
// proportion/percentage concepts. We then tally per-kid lost marks
// on these vs total marks on these, so we can rank by who falls for
// it most.
import { prisma } from "../src/lib/db";

const TOPIC_HINTS = /ratio|fraction|proportion|percentage|whole|share|part/i;
const STEM_HINTS = /ratio|fraction|proportion|percentage|what fraction of|of the (total|original|whole)|how many times/i;

(async () => {
  const kids = await prisma.user.findMany({
    where: { role: "STUDENT", level: 6, NOT: { name: { in: ["admin", "student555", "student666"], mode: "insensitive" } } },
    select: { id: true, name: true },
  });
  console.log(`Probing ${kids.length} P6 students...\n`);

  type Row = { name: string; touchedQs: number; touchedMarksAvailable: number; touchedMarksAwarded: number; ratioWrongs: number; pctLost: number };
  const out: Row[] = [];
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
      select: {
        metadata: true,
        questions: { select: { syllabusTopic: true, transcribedStem: true, marksAwarded: true, marksAvailable: true, studentAnswer: true } },
      },
    });
    const nonRev = papers.filter(p => !(p.metadata as { revisionMode?: unknown } | null)?.revisionMode);
    if (nonRev.length === 0) continue;
    let touchedQs = 0, touchedAv = 0, touchedAw = 0, ratioWrongs = 0;
    for (const p of nonRev) {
      for (const q of p.questions) {
        const av = q.marksAvailable ?? 0;
        if (av === 0) continue;
        if (q.studentAnswer === "__SKIPPED__") continue;
        const t = q.syllabusTopic ?? "";
        const stem = q.transcribedStem ?? "";
        if (!TOPIC_HINTS.test(t) && !STEM_HINTS.test(stem)) continue;
        touchedQs++;
        touchedAv += av;
        touchedAw += q.marksAwarded ?? 0;
        if ((q.marksAwarded ?? 0) < av) ratioWrongs++;
      }
    }
    if (touchedQs < 5) continue; // need at least 5 to be meaningful
    const pctLost = touchedAv > 0 ? ((touchedAv - touchedAw) / touchedAv) * 100 : 0;
    out.push({ name: k.name, touchedQs, touchedMarksAvailable: touchedAv, touchedMarksAwarded: touchedAw, ratioWrongs, pctLost });
  }
  out.sort((a, b) => b.pctLost - a.pctLost);
  console.log(`P6 kids with ≥5 ratio/fraction-flavour attempts (${out.length} kids), sorted by % marks lost on that flavour:\n`);
  console.log("  Kid                       Qs   Wrong   Marks lost   % lost");
  for (const r of out) {
    const lost = r.touchedMarksAvailable - r.touchedMarksAwarded;
    console.log(`  ${r.name.padEnd(25)} ${String(r.touchedQs).padStart(3)}   ${String(r.ratioWrongs).padStart(3)}     ${String(lost).padStart(6)}      ${r.pctLost.toFixed(0)}%`);
  }
  // Headline metric.
  const aboveThirty = out.filter(r => r.pctLost >= 30).length;
  console.log(`\nKids losing ≥30% on ratio/fraction-flavour questions: ${aboveThirty} / ${out.length}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
