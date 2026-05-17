import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  // Find both PSLE science papers by title — exclude student clones
  // (Test Quiz copies). Only the master masters with sourceExamId
  // null and no "Test Quiz" prefix should be reported on. Title must
  // mention Physical/Life + Science + a 2022-2024 vintage marker so
  // we pick up "P6 Life Science MCQ 2022-2024" alongside the
  // "PSLE Physical Science MCQ/OEQ 2022-2024" pair (the former omits
  // the "PSLE" prefix in its title).
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      NOT: { title: { startsWith: "Test Quiz" } },
      AND: [
        { title: { contains: "science", mode: "insensitive" } },
        { OR: [
            { title: { contains: "physical", mode: "insensitive" } },
            { title: { contains: "life", mode: "insensitive" } },
          ] },
        { title: { contains: "2022-2024" } },
      ],
    },
    select: { id: true, title: true, subject: true },
    orderBy: { title: "asc" },
  });
  if (papers.length === 0) {
    // Print everything matching PSLE so the user can see what's there.
    const all = await prisma.examPaper.findMany({
      where: { title: { contains: "PSLE", mode: "insensitive" }, sourceExamId: null },
      select: { id: true, title: true, subject: true },
      orderBy: { title: "asc" },
    });
    console.log("No PSLE *science* masters matched. All PSLE masters on file:");
    for (const p of all) console.log(`  ${p.id} — ${p.title} (subject: ${p.subject})`);
    return;
  }
  console.log(`Matched ${papers.length} master paper(s):`);
  for (const p of papers) console.log(`  ${p.id} — ${p.title}`);
  console.log();

  // Combined per-group tallies (group = "Physical Science", "Life Science")
  // collected as we iterate. Topic → MCQ/OEQ counts.
  const combined = new Map<string, Map<string, { mcq: number; oeq: number }>>();
  const titleGroup = (t: string) => {
    const tl = t.toLowerCase();
    if (tl.includes("physical")) return "Physical Science";
    if (tl.includes("life")) return "Life Science";
    return t;
  };

  for (const paper of papers) {
    const group = titleGroup(paper.title);
    if (!combined.has(group)) combined.set(group, new Map());
    const groupMap = combined.get(group)!;
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: paper.id },
      select: {
        syllabusTopic: true,
        transcribedOptions: true,
        transcribedOptionImages: true,
        transcribedOptionTable: true,
        answer: true,
      },
      orderBy: { orderIndex: "asc" },
    });
    // MCQ = has any option representation OR answer normalises to 1-4.
    function isMcq(q: typeof qs[number]): boolean {
      const opts = q.transcribedOptions as unknown;
      if (Array.isArray(opts) && opts.some(o => String(o ?? "").trim().length > 0)) return true;
      const imgs = q.transcribedOptionImages as unknown;
      if (Array.isArray(imgs) && imgs.some(o => !!o)) return true;
      const tbl = q.transcribedOptionTable as { rows?: unknown[] } | null;
      if (tbl && Array.isArray(tbl.rows) && tbl.rows.length > 0) return true;
      const ans = String(q.answer ?? "").trim().replace(/[().]/g, "").toUpperCase();
      if (["1", "2", "3", "4", "A", "B", "C", "D"].includes(ans)) return true;
      return false;
    }

    // Tally
    type Row = { mcq: number; oeq: number };
    const byTopic = new Map<string, Row>();
    for (const q of qs) {
      const topic = (q.syllabusTopic ?? "").trim() || "(no topic)";
      const row = byTopic.get(topic) ?? { mcq: 0, oeq: 0 };
      if (isMcq(q)) row.mcq++;
      else row.oeq++;
      byTopic.set(topic, row);
      // Also accumulate into the group totals.
      const groupRow = groupMap.get(topic) ?? { mcq: 0, oeq: 0 };
      if (isMcq(q)) groupRow.mcq++;
      else groupRow.oeq++;
      groupMap.set(topic, groupRow);
    }

    // Sort by total desc
    const rows = [...byTopic.entries()]
      .map(([topic, r]) => ({ topic, mcq: r.mcq, oeq: r.oeq, total: r.mcq + r.oeq }))
      .sort((a, b) => b.total - a.total || a.topic.localeCompare(b.topic));

    const totals = rows.reduce(
      (acc, r) => ({ mcq: acc.mcq + r.mcq, oeq: acc.oeq + r.oeq, total: acc.total + r.total }),
      { mcq: 0, oeq: 0, total: 0 },
    );

    console.log(`\n=== ${paper.title} (${qs.length} questions) ===`);
    const topicWidth = Math.max(20, ...rows.map(r => r.topic.length));
    const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
    const padR = (s: string, w: number) => " ".repeat(Math.max(0, w - s.length)) + s;
    console.log(`${pad("Topic", topicWidth)}  ${padR("MCQ", 5)}  ${padR("OEQ", 5)}  ${padR("Total", 5)}`);
    console.log(`${"-".repeat(topicWidth)}  ${"-".repeat(5)}  ${"-".repeat(5)}  ${"-".repeat(5)}`);
    for (const r of rows) {
      console.log(`${pad(r.topic, topicWidth)}  ${padR(String(r.mcq), 5)}  ${padR(String(r.oeq), 5)}  ${padR(String(r.total), 5)}`);
    }
    console.log(`${"-".repeat(topicWidth)}  ${"-".repeat(5)}  ${"-".repeat(5)}  ${"-".repeat(5)}`);
    console.log(`${pad("TOTAL", topicWidth)}  ${padR(String(totals.mcq), 5)}  ${padR(String(totals.oeq), 5)}  ${padR(String(totals.total), 5)}`);
  }

  // Combined per-group tables — one row per topic, MCQ + OEQ summed
  // across the MCQ paper and the OEQ paper in that group.
  for (const [group, topicMap] of combined) {
    const rows = [...topicMap.entries()]
      .map(([topic, r]) => ({ topic, mcq: r.mcq, oeq: r.oeq, total: r.mcq + r.oeq }))
      .sort((a, b) => b.total - a.total || a.topic.localeCompare(b.topic));
    const totals = rows.reduce(
      (acc, r) => ({ mcq: acc.mcq + r.mcq, oeq: acc.oeq + r.oeq, total: acc.total + r.total }),
      { mcq: 0, oeq: 0, total: 0 },
    );
    const totalQ = totals.total;
    const topicWidth = Math.max(20, ...rows.map(r => r.topic.length));
    const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
    const padR = (s: string, w: number) => " ".repeat(Math.max(0, w - s.length)) + s;
    console.log(`\n=== ${group} — combined (${totalQ} questions) ===`);
    console.log(`${pad("Topic", topicWidth)}  ${padR("MCQ", 5)}  ${padR("OEQ", 5)}  ${padR("Total", 5)}`);
    console.log(`${"-".repeat(topicWidth)}  ${"-".repeat(5)}  ${"-".repeat(5)}  ${"-".repeat(5)}`);
    for (const r of rows) {
      console.log(`${pad(r.topic, topicWidth)}  ${padR(String(r.mcq), 5)}  ${padR(String(r.oeq), 5)}  ${padR(String(r.total), 5)}`);
    }
    console.log(`${"-".repeat(topicWidth)}  ${"-".repeat(5)}  ${"-".repeat(5)}  ${"-".repeat(5)}`);
    console.log(`${pad("TOTAL", topicWidth)}  ${padR(String(totals.mcq), 5)}  ${padR(String(totals.oeq), 5)}  ${padR(String(totals.total), 5)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
