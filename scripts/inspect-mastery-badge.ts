import { prisma } from "../src/lib/db";
import { getMasteryReport } from "../src/lib/master-class/mastery";

async function main() {
  const studentNameOrEmail = process.argv[2] ?? "Mark Lim";
  const slugFilter = process.argv[3] ?? "pattern";

  // Find the student
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { name: { contains: studentNameOrEmail, mode: "insensitive" } },
        { displayName: { contains: studentNameOrEmail, mode: "insensitive" } },
        { email: { contains: studentNameOrEmail, mode: "insensitive" } },
      ],
      role: "STUDENT",
    },
    select: { id: true, name: true, displayName: true, level: true },
  });
  console.log(`Student matches: ${users.length}`);
  for (const u of users) {
    console.log(`  ${u.id}  name="${u.name}" display="${u.displayName ?? ""}" P${u.level}`);
  }
  if (users.length === 0) return;
  const student = users[0];
  console.log(`\nUsing student ${student.id} (${student.displayName ?? student.name})\n`);

  // Find all mastery papers for this student
  const papers = await prisma.examPaper.findMany({
    where: {
      assignedToId: student.id,
      paperType: "mastery",
    },
    select: {
      id: true, title: true, score: true, completedAt: true, metadata: true, markingStatus: true,
    },
    orderBy: { completedAt: "desc" },
  });
  console.log(`Mastery papers: ${papers.length}`);
  const slugSeen = new Set<string>();
  for (const p of papers) {
    const slug = (p.metadata as { masterClassSlug?: string } | null)?.masterClassSlug;
    if (!slug) continue;
    slugSeen.add(slug);
    if (!slug.toLowerCase().includes(slugFilter.toLowerCase())) continue;
    console.log(`  ${p.id}  slug=${slug}  score=${p.score}  status=${p.markingStatus}  completed=${p.completedAt?.toISOString().slice(0, 16) ?? "—"}  title=${p.title}`);
  }
  console.log(`\nAll slugs seen: ${[...slugSeen].join(", ")}`);

  // Pick the matching slug + compute the report
  const targetSlug = [...slugSeen].find(s => s.toLowerCase().includes(slugFilter.toLowerCase()));
  if (!targetSlug) {
    console.log(`No mastery slug matches "${slugFilter}".`);
    return;
  }
  console.log(`\nComputing mastery report for slug=${targetSlug}...`);
  const report = await getMasteryReport(targetSlug, student.id);
  console.log(`  totalAttempts: ${report.totalAttempts}`);
  console.log(`  latestAttemptScorePct: ${report.latestAttemptScorePct}`);
  console.log(`  hasAnyWrongQuestions: ${report.hasAnyWrongQuestions}`);
  console.log(`  weakSubTopicIds: ${JSON.stringify(report.weakSubTopicIds)}`);
  console.log(`\nSub-topics:`);
  for (const st of report.subTopics) {
    console.log(`  ${st.state.padEnd(10)} ${st.label}${st.scorePct != null ? ` (${(st.scorePct * 100).toFixed(0)}%)` : ""}`);
  }

  // Replicate the badge logic from src/app/master-class/page.tsx
  const allRows = report.subTopics;
  const overall = report.latestAttemptScorePct ?? 0;
  const allMastered = allRows.length > 0 && allRows.every(r => r.state === "mastered");
  const overallPass = overall >= 95;
  const badge = overallPass || allMastered;
  console.log(`\nBadge logic:`);
  console.log(`  overall ≥ 95?  ${overallPass}  (got ${overall})`);
  console.log(`  all sub-topics mastered?  ${allMastered}`);
  console.log(`  → badge earned?  ${badge}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
