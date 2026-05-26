import { prisma } from "../src/lib/db";
async function main() {
  const rows = await prisma.englishSupplementaryPaper.findMany({
    orderBy: { year: "asc" },
    select: {
      year: true, status: true,
      situationalWriting: true, continuousTheme: true, continuousPrompts: true,
      situationalModel: true, continuousModel: true,
      listeningMcqs: true, listeningTexts: true,
      oralDays: true, oralModelAnswers: true,
    },
  });
  console.log(`Total papers: ${rows.length}`);
  for (const r of rows) {
    const sw = r.situationalWriting as Record<string, unknown> | null;
    const cps = (r.continuousPrompts as Array<Record<string, unknown>>) ?? [];
    const od = (r.oralDays as Array<Record<string, unknown>>) ?? [];
    const oma = (r.oralModelAnswers as Array<Record<string, unknown>>) ?? [];
    console.log(`\n[${r.year}] status=${r.status}`);
    console.log(`  Situational: ${typeof sw?.purpose === "string" ? sw.purpose.slice(0, 80) : "—"}`);
    console.log(`  Continuous theme: ${r.continuousTheme ?? "—"} | prompts: ${cps.length}`);
    cps.forEach((c, i) => console.log(`    opt${c.optionNum ?? i+1}: ${(typeof c.brief === "string" ? c.brief : "").slice(0, 80)}`));
    console.log(`  Situational model: ${r.situationalModel ? r.situationalModel.length + " chars" : "—"}`);
    console.log(`  Continuous model: ${r.continuousModel ? r.continuousModel.length + " chars" : "—"}`);
    console.log(`  Oral days: ${od.length}`);
    od.forEach(d => {
      const stim = typeof d.stimulusBrief === "string" ? d.stimulusBrief : (typeof d.stimulus === "string" ? d.stimulus : "");
      const qs = (d.questions as unknown[] | undefined) ?? [];
      console.log(`    Day ${d.dayNum}: stim "${stim.slice(0, 80)}" | Q ${qs.length}`);
    });
    console.log(`  Oral model answers: ${oma.length}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
