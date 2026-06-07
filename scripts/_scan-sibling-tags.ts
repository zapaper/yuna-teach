// Audit + propose corrections for multi-part question groups whose
// siblings carry different syllabusTopic tags. Read-only — just
// prints a per-group preview so we can decide each case.
import { prisma } from "../src/lib/db";

function baseNum(n: string) { return n.replace(/[a-zA-Z()]+$/, ""); }
function trim(s: string | null | undefined, n = 180): string {
  if (!s) return "(empty)";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

async function main() {
  // Scan all subjects this time, not just science.
  const qs = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { not: null },
      examPaper: { sourceExamId: null, paperType: null },
    },
    select: {
      id: true, questionNum: true, examPaperId: true, syllabusTopic: true,
      transcribedStem: true, transcribedSubparts: true,
      examPaper: { select: { title: true, subject: true } },
    },
  });
  const groups = new Map<string, typeof qs>();
  for (const q of qs) {
    const k = `${q.examPaperId}::${baseNum(q.questionNum)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(q);
  }
  let conflicts = 0;
  const bySubject = new Map<string, number>();
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const topics = new Set(group.map(g => g.syllabusTopic ?? ""));
    if (topics.size <= 1) continue;
    conflicts++;
    const subj = group[0].examPaper?.subject ?? "?";
    bySubject.set(subj, (bySubject.get(subj) ?? 0) + 1);
    console.log(`\n══════════════════════════════════════════════════════════════════════`);
    console.log(`${subj} — ${group[0].examPaper?.title} — Q${baseNum(group[0].questionNum)}`);
    console.log(`══════════════════════════════════════════════════════════════════════`);
    for (const g of group) {
      console.log(`\nQ${g.questionNum}  [${g.syllabusTopic}]`);
      console.log(`  stem: ${trim(g.transcribedStem, 200)}`);
      const sps = (g.transcribedSubparts as Array<{label?: string; text?: string}> | null) ?? [];
      for (const sp of sps) {
        if (sp.label?.startsWith("_")) continue;
        console.log(`  (${sp.label}) ${trim(sp.text, 200)}`);
      }
    }
  }
  console.log(`\n\nTotal multi-part groups with mismatched topics: ${conflicts}`);
  console.log(`By subject: ${[...bySubject.entries()].map(([s, n]) => `${s}=${n}`).join(", ")}`);
  process.exit(0);
}
main();
