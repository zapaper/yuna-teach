// Who is eligible for the Lumi intro email today?
// Threshold per (kid × subject):
//   • ≥ 3 non-revision completed papers
//   • ≥ 15 analysable wrong records
//   • parent has an email
// Also reports which (kid × subject) ALREADY have a bundled Lumi cache
// (so the refresh-and-send pass knows what to regen vs what to generate
// fresh).
import { prisma } from "../src/lib/db";
import { TUTOR_CACHE } from "../src/lib/tutor-cache";

const EXCLUDED_NAMES = new Set(["admin", "student555", "student666"]);

function classifySubject(s: string | null | undefined): string | null {
  if (!s) return null;
  const lc = s.toLowerCase();
  if (lc.includes("math")) return "Math";
  if (lc.includes("science")) return "Science";
  if (lc.includes("english")) return "English";
  if (lc.includes("chinese") || s.includes("华文") || s.includes("中文") || s.includes("华语")) return "Chinese";
  return null;
}

function safeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

(async () => {
  // Excluded admin / test / settings-admin users.
  const allUsers = await prisma.user.findMany({ select: { id: true, name: true, email: true, settings: true } });
  const excludedIds = new Set<string>();
  for (const u of allUsers) {
    const lc = (u.name ?? "").toLowerCase();
    if (EXCLUDED_NAMES.has(lc) || lc === "admin") { excludedIds.add(u.id); continue; }
    const s = u.settings as { admin?: unknown } | null;
    if (s?.admin === true) excludedIds.add(u.id);
  }

  // Parent links + parent emails.
  const parentLinks = await prisma.parentStudent.findMany({ select: { parentId: true, studentId: true } });
  const parentsOfKid = new Map<string, string[]>();
  for (const l of parentLinks) {
    if (!parentsOfKid.has(l.studentId)) parentsOfKid.set(l.studentId, []);
    parentsOfKid.get(l.studentId)!.push(l.parentId);
  }
  const userById = new Map(allUsers.map(u => [u.id, u]));

  // All completed/released papers, with per-question marks + studentAnswer
  // so we can count wrongs per (kid × subject).
  const papers = await prisma.examPaper.findMany({
    where: { markingStatus: { in: ["complete", "released"] }, assignedToId: { not: null } },
    select: { assignedToId: true, subject: true, metadata: true,
      questions: { select: { marksAwarded: true, marksAvailable: true, studentAnswer: true, markingNotes: true, transcribedOptions: true } } },
  });

  type Acc = { papers: number; wrongs: number; mcqOnly: boolean; lastPaperAt: Date | null };
  const byKey = new Map<string, Acc>();
  for (const p of papers) {
    if (!p.assignedToId || excludedIds.has(p.assignedToId)) continue;
    const subj = classifySubject(p.subject);
    if (!subj) continue;
    const meta = p.metadata as { revisionMode?: string } | null;
    if (meta?.revisionMode) continue; // revision papers don't count
    const key = `${p.assignedToId}::${subj}`;
    const acc = byKey.get(key) ?? { papers: 0, wrongs: 0, mcqOnly: true, lastPaperAt: null };
    acc.papers++;
    // Wrong = analysable wrong record (MCQ with marker shape or any
    // OEQ with non-trivial markingNotes). Mirrors tutor.ts collectWrongs.
    const mcqMarkerRe = /Student\s*:\s*\(?\d+\)?\s*,\s*Correct\s*:\s*\(?\d+\)?/i;
    for (const q of p.questions) {
      const av = q.marksAvailable ?? 0, aw = q.marksAwarded ?? 0;
      if (av === 0 || aw >= av) continue;
      if (q.studentAnswer === "__SKIPPED__") continue;
      const opts = q.transcribedOptions as unknown;
      const optsArr: string[] = Array.isArray(opts) ? (opts as unknown[]).filter(Boolean).map(o => typeof o === "string" ? o : "") : [];
      const isMcq = optsArr.length >= 2 || mcqMarkerRe.test(q.markingNotes ?? "");
      if (!isMcq && (!q.markingNotes || q.markingNotes.trim().length < 10)) continue;
      acc.wrongs++;
      if (!isMcq) acc.mcqOnly = false;
    }
    byKey.set(key, acc);
  }

  type Row = {
    studentId: string; studentName: string;
    subject: string;
    papers: number; wrongs: number;
    parentEmails: string[];
    cacheKey: string; hasCache: boolean;
  };
  const eligible: Row[] = [];
  for (const [key, acc] of byKey) {
    if (acc.papers < 3 || acc.wrongs < 10) continue;
    const [studentId, subject] = key.split("::");
    const student = userById.get(studentId);
    if (!student) continue;
    const parents = (parentsOfKid.get(studentId) ?? []).map(pid => userById.get(pid)).filter((u): u is NonNullable<typeof u> => !!u);
    const parentEmails = parents.map(p => p.email).filter((e): e is string => !!e);
    if (parentEmails.length === 0) continue;
    const cacheKey = `${safeName(student.name ?? "")}:${subject.toLowerCase()}`;
    eligible.push({
      studentId, studentName: student.name ?? "?",
      subject,
      papers: acc.papers, wrongs: acc.wrongs,
      parentEmails,
      cacheKey,
      hasCache: !!TUTOR_CACHE[cacheKey],
    });
  }

  // Sort by subject then by wrongs desc
  eligible.sort((a, b) => a.subject.localeCompare(b.subject) || b.wrongs - a.wrongs);

  // Summary by subject
  const bySubject = new Map<string, Row[]>();
  for (const r of eligible) {
    if (!bySubject.has(r.subject)) bySubject.set(r.subject, []);
    bySubject.get(r.subject)!.push(r);
  }
  console.log(`\n========== SUMMARY ==========`);
  for (const subj of ["Math", "Science", "English", "Chinese"]) {
    const rows = bySubject.get(subj) ?? [];
    const fresh = rows.filter(r => !r.hasCache).length;
    const cached = rows.filter(r => r.hasCache).length;
    console.log(`  ${subj.padEnd(8)}  eligible: ${String(rows.length).padStart(3)}   (fresh: ${fresh}, already cached: ${cached})`);
  }
  console.log(`  ${"TOTAL".padEnd(8)}  eligible: ${String(eligible.length).padStart(3)}`);

  console.log(`\n========== DETAIL ==========`);
  for (const [subj, rows] of bySubject) {
    console.log(`\n--- ${subj} (${rows.length}) ---`);
    for (const r of rows) {
      const tag = r.hasCache ? "[cached]" : "[FRESH ]";
      console.log(`  ${tag} ${r.studentName.padEnd(28)} papers=${String(r.papers).padStart(3)}  wrongs=${String(r.wrongs).padStart(3)}  parents: ${r.parentEmails.join(", ")}`);
    }
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
