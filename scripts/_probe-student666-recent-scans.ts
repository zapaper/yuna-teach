import { prisma } from "../src/lib/db";
import { readFileSync } from "fs";
import path from "path";

const COOKIE = readFileSync(path.join(__dirname, "..", "eval", "cookie.txt"), "utf-8").trim();
const BASE = "https://www.markforyou.com";
const headers = { cookie: `yuna_session=${COOKIE}` } as const;

async function listSub(paperId: string): Promise<{ files: string[]; latest: string | null }> {
  try {
    const r = await fetch(`${BASE}/api/exam/${paperId}/submission?list=1`, { headers });
    if (!r.ok) return { files: [], latest: null };
    const j = (await r.json()) as { files?: Array<{ name: string; mtime: string }> | string[] };
    if (!j.files) return { files: [], latest: null };
    const items = Array.isArray(j.files) ? j.files : [];
    const names: string[] = [];
    let latest: string | null = null;
    for (const x of items) {
      if (typeof x === "string") {
        names.push(x);
      } else {
        names.push(x.name);
        if (!latest || x.mtime > latest) latest = x.mtime;
      }
    }
    return { files: names, latest };
  } catch (e) {
    return { files: [], latest: null };
  }
}

(async () => {
  const studentIds = [
    "cmnsa6bww006bgmuwflevt143", // Student666
    "cmnzxv3m10000sh117b2eekvu", // Student66666
  ];

  // Pull last 60 papers assigned to either student666 (any title — the scan
  // dialog can be opened from any paper, including non-PSLE ones)
  const papers = await prisma.examPaper.findMany({
    where: { assignedToId: { in: studentIds } },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: { id: true, title: true, assignedToId: true, createdAt: true },
  });
  console.log(`Probing ${papers.length} papers for recent submission files...`);

  const results = await Promise.all(
    papers.map(async (p) => ({ p, sub: await listSub(p.id) })),
  );
  // Sort by latest file mtime
  results.sort((a, b) => (b.sub.latest ?? "").localeCompare(a.sub.latest ?? ""));
  console.log(`\nPapers with submission files, newest mtime first:`);
  for (const r of results.slice(0, 10)) {
    if (r.sub.files.length === 0) continue;
    const who = r.p.assignedToId === "cmnsa6bww006bgmuwflevt143" ? "Student666" : "Student66666";
    console.log(`  ${r.p.id}  '${r.p.title.slice(0, 55)}'  → ${who}`);
    console.log(`     files: ${r.sub.files.join(", ")}`);
    console.log(`     latest mtime: ${r.sub.latest}`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
