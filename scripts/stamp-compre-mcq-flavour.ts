// Stamp subTopic on every PSLE Chinese 阅读理解 MCQ question with the
// "flavour" of its parent passage:
//   visual-text-informational — notice / poster / brochure / ad
//                               (the kind that pairs with English
//                               Visual Text MCQ playbook)
//   compre-narrative          — short story / personal recollection
//
// The classifier looks at the section's `passage` string in
// metadata.chineseSections. Heuristics mirror the earlier _compre-a-
// split.ts probe (notice keywords + dates + URLs vs first-person
// pronouns + past-tense + emotion). Real-paper masters only
// (sourceExamId null AND paperType null) — clones are excluded.
//
// Idempotent. Safe to re-run as new Chinese masters get uploaded.
import { prisma } from "../src/lib/db";

function classifyPassage(passage: string): "visual-text-informational" | "compre-narrative" {
  let info = 0, narr = 0;
  const head = passage.slice(0, 200);

  const boldHeads = (head.match(/\*\*[^*]+\*\*/g) ?? []).length;
  if (boldHeads >= 1) info += 2;

  if (/(通告|公告|招收|招聘|报名|主办|欢迎参加|有兴趣)/.test(passage)) info += 3;
  if (/(日期|时间|地点|收费|价格|费用|联系|查询|致电|拨电|登入|上网|网址)/.test(passage)) info += 2;
  if (/(年龄[:：]|要求[:：]|对象[:：])/.test(passage)) info += 2;
  if (/\d+\s*[月日时]/.test(passage.slice(0, 400))) info += 1;
  if (/(www\.|\.com|@)/.test(passage)) info += 2;

  if (/(^|\s)(我|我们)/.test(passage.slice(0, 100))) narr += 2;
  if (/(记得|有一次|那一天|那一年|当时|从前|从小|那时候|小时候)/.test(passage.slice(0, 200))) narr += 3;
  if (/(高兴|伤心|害怕|难过|惊讶|想哭|忍不住|后悔|感动|觉得|心想)/.test(passage)) narr += 2;
  if (/[妈爸老师叔阿姨爷奶]([^"]{0,8}["“])/.test(passage)) narr += 1;
  if (/(^|\n)\s*那|^\s*记得|^\s*我/.test(passage.slice(0, 100))) narr += 2;

  return info > narr ? "visual-text-informational" : "compre-narrative";
}

async function main() {
  const masters = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      paperType: null,
      subject: { contains: "chinese", mode: "insensitive" },
    },
    select: { id: true, title: true, metadata: true },
  });
  console.log(`Scanning ${masters.length} real Chinese master papers…`);

  let informational = 0, narrative = 0, skipped = 0, already = 0;
  for (const p of masters) {
    const meta = p.metadata as Record<string, unknown> | null;
    const sections = (meta?.chineseSections ?? []) as Array<{
      label: string; startIndex: number; endIndex: number; passage?: string;
    }>;
    for (const sec of sections) {
      if (!sec.label.includes("阅读理解")) continue;
      if (sec.label.includes("OEQ")) continue; // MCQ sections only
      if (!sec.passage || sec.passage.length < 80) continue;
      const target = classifyPassage(sec.passage);

      // Stamp every question in this section's index range. These
      // are the MCQs that sit on this passage.
      const qs = await prisma.examQuestion.findMany({
        where: {
          examPaperId: p.id,
          orderIndex: { gte: sec.startIndex, lte: sec.endIndex },
          syllabusTopic: { contains: "阅读理解 MCQ", mode: "insensitive" },
        },
        select: { id: true, subTopic: true },
      });
      for (const q of qs) {
        if (q.subTopic === target) { already++; continue; }
        await prisma.examQuestion.update({ where: { id: q.id }, data: { subTopic: target } });
        if (target === "visual-text-informational") informational++;
        else narrative++;
      }
      skipped += 0; // (just for symmetry)
    }
  }
  console.log(`\nStamped:`);
  console.log(`  visual-text-informational: +${informational}`);
  console.log(`  compre-narrative:          +${narrative}`);
  console.log(`  already tagged correctly:  ${already}`);
  process.exit(0);
}
main();
