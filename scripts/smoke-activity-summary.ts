// CLI smoke test for fetchActivitySummary() — hits the live main app
// at MAIN_APP_URL (default https://www.markforyou.com) with the
// NURTURE_API_TOKEN env var. Pretty-prints the parsed JSON.
//
// Usage:
//   npx tsx scripts/smoke-activity-summary.ts --parent <parentId>
//   npx tsx scripts/smoke-activity-summary.ts --student <studentId>
//   npx tsx scripts/smoke-activity-summary.ts --parent <id> --days 30 --no-by-subject

import "dotenv/config";
import { fetchActivitySummary } from "../src/lib/yuna-activity";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

(async () => {
  const parentId = arg("parent");
  const studentId = arg("student");
  if (!parentId && !studentId) {
    console.error("Usage: --parent <id> | --student <id> [--days N] [--no-by-subject]");
    process.exit(1);
  }
  if (parentId && studentId) {
    console.error("Pass only one of --parent or --student.");
    process.exit(1);
  }
  const daysRaw = arg("days");
  const days = daysRaw ? Math.max(1, Math.min(90, parseInt(daysRaw, 10))) : undefined;
  const bySubject = !flag("no-by-subject");

  try {
    const summary = parentId
      ? await fetchActivitySummary({ parentId, days, bySubject })
      : await fetchActivitySummary({ studentId: studentId!, days, bySubject });
    console.log(JSON.stringify(summary, null, 2));
    console.log();
    console.log(`# ${summary.mode}=${summary.id}  window=${summary.windowDays}d  ` +
                `students=${summary.students.length}  total_papers=${summary.totals.totalPapers}  ` +
                `avg=${summary.totals.marks.percent.toFixed(1)}%`);
  } catch (err) {
    const e = err as Error;
    console.error(`FAILED: ${e.message}`);
    process.exit(1);
  }
})();
