import { prisma } from "../src/lib/db";
import { promises as fs } from "fs";
import path from "path";

// Pull the 11 PSLE Science master papers (2016-2025) and dump their
// questions to a single JSON for trend / topic / question-type analysis.
//
// Two paper shapes are mixed in:
//   - Single-year papers (2016 / 17 / 18 / 19 / 20 / 21 / 25): each is
//     one full PSLE Science paper (MCQ Booklet A + OEQ Booklet B).
//   - 2022-2024 bundled papers: split by Life / Physical × MCQ / OEQ.
//     These come from a curated 3-year collection — questions still
//     individually trace back to a real PSLE Q via questionNum / year.

const TARGET_IDS = [
  { yearLabel: "2016",      id: "cmpoqpdu20001ie7zhjjikrj0",            kind: "year" },
  { yearLabel: "2017",      id: "cmpo2q0qo0001sm5jeg874w3r",            kind: "year" },
  { yearLabel: "2018",      id: "cmpnsc0yt0001ynu66am76yix",            kind: "year" },
  { yearLabel: "2019",      id: "cmpna5eon0001rh99weeor0gu",            kind: "year" },
  { yearLabel: "2020",      id: "cmp7t0q950023zrp7m9yyl2fe",            kind: "year" },
  { yearLabel: "2021",      id: "cmp7jpotn0043mzghzfaj5wb3",            kind: "year" },
  { yearLabel: "2022-2024", id: "cmoqvvp4x005pwu9980mndv8v", kind: "bundle-life-mcq" },
  { yearLabel: "2022-2024", id: "cmor0ghj80001msjf7wzhgkj9", kind: "bundle-life-oeq" },
  { yearLabel: "2022-2024", id: "cmp6okxsg000lk9u7zjbu76mx", kind: "bundle-physical-mcq" },
  { yearLabel: "2022-2024", id: "cmp6om1q8000nk9u7rabiiju5", kind: "bundle-physical-oeq" },
  { yearLabel: "2025",      id: "cmpn9gcda000149ocsxpjju2w",            kind: "year" },
] as const;

async function main() {
  const papers = await Promise.all(
    TARGET_IDS.map(async ({ yearLabel, id, kind }) => {
      const paper = await prisma.examPaper.findUnique({
        where: { id },
        select: {
          id: true,
          title: true,
          year: true,
          questions: {
            orderBy: [{ pageIndex: "asc" }, { orderIndex: "asc" }],
            select: {
              questionNum: true,
              marksAvailable: true,
              syllabusTopic: true,
              subTopic: true,
              transcribedStem: true,
              transcribedOptions: true,
              transcribedOptionTable: true,
              answer: true,
            },
          },
        },
      });
      return { yearLabel, kind, ...paper };
    })
  );

  const outPath = path.join(__dirname, "psle-science-dump.json");
  await fs.writeFile(outPath, JSON.stringify(papers, null, 2));
  console.log(`Wrote ${outPath} (${papers.length} papers, ${papers.reduce((s, p) => s + (p.questions?.length ?? 0), 0)} questions)`);

  // ─── Quick eyeball: topic frequency across all years ─────────────
  const topicCounts = new Map<string, { mcq: number; oeq: number; total: number }>();
  for (const p of papers) {
    for (const q of p.questions ?? []) {
      const topic = q.syllabusTopic ?? "(untagged)";
      const cur = topicCounts.get(topic) ?? { mcq: 0, oeq: 0, total: 0 };
      // MCQ if 2 marks AND has options. OEQ otherwise.
      const isMcq = (q.transcribedOptions || q.transcribedOptionTable) != null;
      if (isMcq) cur.mcq++; else cur.oeq++;
      cur.total++;
      topicCounts.set(topic, cur);
    }
  }
  const topicTable = [...topicCounts.entries()]
    .sort(([, a], [, b]) => b.total - a.total);
  console.log("\n=== Topic frequency (all years combined) ===");
  console.log("total\tmcq\toeq\ttopic");
  for (const [topic, c] of topicTable) {
    console.log(`${c.total}\t${c.mcq}\t${c.oeq}\t${topic}`);
  }

  // ─── Per-year breakdown for the single-year papers ───────────────
  console.log("\n=== Topic × Year (single-year papers only) ===");
  const yearPapers = papers.filter(p => (p.kind as string) === "year");
  const allTopics = new Set<string>();
  for (const p of yearPapers) for (const q of p.questions ?? []) if (q.syllabusTopic) allTopics.add(q.syllabusTopic);
  const topicList = [...allTopics].sort();
  const header = ["topic", ...yearPapers.map(p => p.yearLabel)].join("\t");
  console.log(header);
  for (const topic of topicList) {
    const row = [topic];
    for (const p of yearPapers) {
      const count = (p.questions ?? []).filter(q => q.syllabusTopic === topic).length;
      row.push(String(count));
    }
    console.log(row.join("\t"));
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
