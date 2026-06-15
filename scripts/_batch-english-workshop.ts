// Run _workshop-unified.ts for every P6 English kid who qualifies
// (>=15 analysable wrongs), skipping any whose cache already exists.
// Sequential — Gemini Pro is too expensive to fan out in parallel.

import { prisma } from "../src/lib/db";
import { existsSync } from "fs";
import path from "path";
import { spawn } from "child_process";

const EXCLUDED = ["admin", "student555", "student666"];
const THRESHOLD = 15;

function safe(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

(async () => {
  const kids = await prisma.user.findMany({
    where: { role: "STUDENT", level: 6, NOT: { name: { in: EXCLUDED, mode: "insensitive" } } },
    select: { id: true, name: true },
  });
  const mcqShape = /Student\s*:\s*\(?\d+\)?\s*,\s*Correct\s*:\s*\(?\d+\)?/i;

  type Row = { name: string; analysable: number };
  const out: Row[] = [];
  for (const k of kids) {
    const papers = await prisma.examPaper.findMany({
      where: { assignedToId: k.id, markingStatus: { in: ["complete", "released"] }, subject: { contains: "english", mode: "insensitive" } },
      select: { metadata: true, questions: { select: { marksAwarded: true, marksAvailable: true, studentAnswer: true, markingNotes: true, transcribedOptions: true } } },
    });
    const nonRev = papers.filter(p => !(p.metadata as { revisionMode?: unknown } | null)?.revisionMode);
    let analysable = 0;
    for (const p of nonRev) {
      for (const q of p.questions) {
        const av = q.marksAvailable ?? 0, aw = q.marksAwarded ?? 0;
        if (av === 0 || aw >= av) continue;
        if (q.studentAnswer === "__SKIPPED__") continue;
        const opts = q.transcribedOptions as unknown;
        const optsLen = Array.isArray(opts) ? opts.length : 0;
        const isMcq = optsLen >= 2 || mcqShape.test(q.markingNotes ?? "");
        if (isMcq || (q.markingNotes && q.markingNotes.length >= 10)) analysable++;
      }
    }
    if (analysable >= THRESHOLD) out.push({ name: k.name, analysable });
  }
  out.sort((a, b) => b.analysable - a.analysable);
  console.log(`[batch-english] ${out.length} P6 English kids qualify:`);
  for (const r of out) console.log(`   ${r.name.padEnd(25)} analysable=${r.analysable}`);

  await prisma.$disconnect();

  const evalDir = path.join(process.cwd(), "eval");
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    const cachePath = path.join(evalDir, `unified-diagnosis-${safe(r.name)}-english.gemini-cache.json`);
    if (existsSync(cachePath)) {
      console.log(`\n[${i + 1}/${out.length}] ${r.name} — cache exists, skipping`);
      continue;
    }
    console.log(`\n[${i + 1}/${out.length}] Running workshop for ${r.name}…`);
    await new Promise<void>((resolve, reject) => {
      // On Windows we need shell:true to find npx (a .cmd shim), but
      // shell:true also splits args by whitespace. So pass the entire
      // command as one quoted string with the student name wrapped in
      // double quotes so "Mark lim" stays a single argv entry.
      const cmd = `npx tsx scripts/_workshop-unified.ts "${r.name}" English`;
      const child = spawn(cmd, {
        stdio: "inherit",
        shell: true,
      });
      child.on("exit", code => {
        if (code === 0) resolve();
        else { console.error(`workshop exited ${code} for ${r.name}`); resolve(); /* continue regardless */ }
      });
      child.on("error", reject);
    });
  }
  console.log(`\n[batch-english] done.`);
})().catch(e => { console.error(e); process.exit(1); });
