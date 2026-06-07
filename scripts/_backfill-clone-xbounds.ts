// Copy xStartPct/xEndPct from master questions to clone questions on
// a specific paper. Useful when a clone was created before the daily-
// quiz route started copying x-bounds. Idempotent — only overwrites
// when clone has null x-bounds AND master has them.

import { readFileSync } from "fs";
import { join } from "path";

const PAPER = process.argv[2];
const SOURCE = process.argv[3];
if (!PAPER || !SOURCE) {
  console.log("Usage: tsx _backfill-clone-xbounds.ts <clone-paper-id> <master-paper-id>");
  process.exit(1);
}

const cookieValue = readFileSync(join("eval", "cookie.txt"), "utf8").trim();
const cookie = `yuna_session=${cookieValue}`;
const baseUrl = "https://www.markforyou.com";

async function getQuestions(paperId: string) {
  const res = await fetch(`${baseUrl}/api/exam/${paperId}`, { headers: { cookie } });
  if (!res.ok) throw new Error(`Fetch ${paperId} failed: ${res.status}`);
  const json = await res.json() as { questions: Array<{ id: string; questionNum: string; xStartPct?: number | null; xEndPct?: number | null; syllabusTopic?: string | null }> };
  return json.questions ?? [];
}

async function main() {
  console.log(`Backfilling x-bounds from master ${SOURCE} → clone ${PAPER}\n`);
  const [cloneQs, masterQs] = await Promise.all([getQuestions(PAPER), getQuestions(SOURCE)]);
  const masterByNum = new Map(masterQs.map(q => [q.questionNum, q]));

  let updates = 0, skipped = 0;
  for (const cq of cloneQs) {
    if (cq.xStartPct != null || cq.xEndPct != null) { skipped++; continue; }
    const mq = masterByNum.get(cq.questionNum);
    if (!mq || mq.xStartPct == null || mq.xEndPct == null) { skipped++; continue; }
    const res = await fetch(`${baseUrl}/api/admin/exam/${PAPER}/normal-extract-english`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ questionId: cq.id, xStartPct: mq.xStartPct, xEndPct: mq.xEndPct }),
    });
    if (!res.ok) {
      console.log(`  Q${cq.questionNum}: PUT failed (${res.status})`);
      skipped++;
      continue;
    }
    console.log(`  Q${cq.questionNum} (${cq.syllabusTopic ?? '-'}): x ${mq.xStartPct}-${mq.xEndPct} ✓`);
    updates++;
  }
  console.log(`\nStamped: ${updates}, Skipped: ${skipped} (already-set or no-master-x)`);

  if (updates > 0) {
    console.log("\nTriggering re-mark…");
    const markRes = await fetch(`${baseUrl}/api/exam/${PAPER}/mark`, { method: "POST", headers: { cookie } });
    console.log(`Re-mark: ${markRes.status} ${await markRes.text()}`);
  }
  process.exit(0);
}
main();
