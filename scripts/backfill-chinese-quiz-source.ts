// One-off backfill: every Chinese quiz/test-quiz clone that was
// created before the daily-quiz route started setting sourceExamId
// has no link back to its master. Match by exact title — daily-quiz
// titles match the master's title verbatim, so any quiz whose title
// also appears as a (paperType=null, sourceExamId=null) Chinese paper
// is paired up. Also inherits answerPages / skipPages /
// normalExtractChinese metadata so the marker can find the OEQ pad.

import { prisma } from "../src/lib/db";

function isChineseSubject(s: string | null | undefined): boolean {
  const lc = (s ?? "").toLowerCase();
  if (lc.includes("chinese")) return true;
  if (!s) return false;
  return s.includes("华文") || s.includes("中文") || s.includes("华语");
}

async function main() {
  // All Chinese masters (paperType=null, sourceExamId=null) with their metadata.
  const masters = await prisma.examPaper.findMany({
    where: { paperType: null, sourceExamId: null },
    select: { id: true, title: true, subject: true, pageCount: true, metadata: true },
  });
  const cnMasters = masters.filter(m => isChineseSubject(m.subject));
  const byTitle = new Map<string, typeof cnMasters[number]>();
  for (const m of cnMasters) byTitle.set(m.title.trim(), m);
  console.log(`Found ${cnMasters.length} Chinese master papers`);

  // Chinese quiz/mastery clones with no sourceExamId.
  const clones = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      paperType: { in: ["quiz", "mastery", "mastery-review"] },
    },
    select: { id: true, title: true, subject: true, paperType: true, metadata: true, pageCount: true },
  });
  const cnClones = clones.filter(c => isChineseSubject(c.subject));
  console.log(`Found ${cnClones.length} Chinese clones with no sourceExamId`);

  let matched = 0, skipped = 0;
  for (const c of cnClones) {
    const master = byTitle.get(c.title.trim());
    if (!master) { skipped++; continue; }
    if (master.id === c.id) { skipped++; continue; }
    const masterMeta = (master.metadata ?? {}) as Record<string, unknown>;
    const cloneMeta = (c.metadata ?? {}) as Record<string, unknown>;
    const nextMeta = {
      ...cloneMeta,
      // Only inherit if the clone didn't already have these.
      ...(cloneMeta.answerPages === undefined ? { answerPages: masterMeta.answerPages ?? [] } : {}),
      ...(cloneMeta.skipPages === undefined ? { skipPages: masterMeta.skipPages ?? [] } : {}),
      ...(cloneMeta.normalExtractChinese === undefined && masterMeta.normalExtractChinese ? { normalExtractChinese: masterMeta.normalExtractChinese } : {}),
    };
    await prisma.examPaper.update({
      where: { id: c.id },
      data: {
        sourceExamId: master.id,
        // Only overwrite pageCount=0; if a non-zero value was set, leave it.
        ...(c.pageCount === 0 ? { pageCount: master.pageCount } : {}),
        metadata: nextMeta as object,
      },
    });
    matched++;
    console.log(`  clone=${c.id} (${c.paperType}) → master=${master.id} (title="${c.title.slice(0, 50)}")`);
  }
  console.log(`Backfilled ${matched} clones; skipped ${skipped} with no matching master.`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
