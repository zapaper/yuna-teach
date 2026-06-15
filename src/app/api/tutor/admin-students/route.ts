import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guard";
import { TUTOR_CACHE } from "@/lib/tutor-cache";

// Returns students an admin can pick from the Tutor view's selector,
// even when they're not linked to the admin's own parent account.
//
// Two sources merged in:
//   1. Every kid we have a workshop diagnosis cached for (TUTOR_CACHE).
//      They show up regardless of subject so admin can always jump
//      into any subject they care about, even with no cache there.
//   2. (Optional, when ?subject= is provided) every kid who QUALIFIES
//      for a Lumi diagnosis in that subject right now — i.e. has at
//      least 15 analysable wrong records. Lets admin select kids who
//      haven't had a workshop run yet, see their topline + topics for
//      practice, and decide whether to run a workshop.
//
// hasDiagnosis is true when the kid has a bundled cache for the
// requested subject (or, when no subject is requested, for any
// subject). False means "qualifies but no cached workshop yet."
const SUBJECT_FILTER: Record<string, { OR?: Array<Record<string, unknown>>; subject?: Record<string, unknown> }> = {
  science: { subject: { contains: "science", mode: "insensitive" } },
  math: { subject: { contains: "math", mode: "insensitive" } },
  english: { subject: { contains: "english", mode: "insensitive" } },
  chinese: {
    OR: [
      { subject: { contains: "chinese", mode: "insensitive" } },
      { subject: { contains: "华文" } },
      { subject: { contains: "中文" } },
    ],
  },
};

const MIN_ANALYSABLE = 15;
const MCQ_SHAPE = /Student\s*:\s*\(?\d+\)?\s*,\s*Correct\s*:\s*\(?\d+\)?/i;
const EXCLUDED_NAMES = new Set(["admin", "student555", "student666"]);

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const subjectParam = request.nextUrl.searchParams.get("subject")?.toLowerCase() ?? null;
  const subjectKey = subjectParam && SUBJECT_FILTER[subjectParam] ? subjectParam : null;

  // Source #1 — cached diagnoses. Two passes per safe name: pull every
  // (safe-name, subject) cache key. Note safeName lowercased and
  // dash-joined non-alphanumerics, so "Mark Lim" → "mark-lim",
  // "JeremiahSy" → "jeremiahsy".
  type CacheEntry = { safe: string; subject: string };
  const cacheEntries: CacheEntry[] = [];
  for (const key of Object.keys(TUTOR_CACHE)) {
    const [safe, subj] = key.split(":");
    if (safe && subj) cacheEntries.push({ safe, subject: subj });
  }

  const allUsers = await prisma.user.findMany({
    where: { role: "STUDENT" },
    select: { id: true, name: true, level: true },
  });
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const userBySafe = new Map<string, { id: string; name: string; level: number | null }>();
  for (const u of allUsers) {
    if (!u.name) continue;
    userBySafe.set(norm(u.name), { id: u.id, name: u.name, level: u.level });
  }

  type Hit = { id: string; name: string; level: number | null; hasDiagnosis: boolean };
  const hits = new Map<string, Hit>();
  for (const ce of cacheEntries) {
    const u = userBySafe.get(norm(ce.safe));
    if (!u) continue;
    // hasDiagnosis is true if EITHER (no subject filter — any cache
    // counts) OR the cache matches the requested subject.
    const matches = !subjectKey || ce.subject.toLowerCase() === subjectKey;
    const prior = hits.get(u.id);
    hits.set(u.id, { id: u.id, name: u.name, level: u.level, hasDiagnosis: prior?.hasDiagnosis || matches });
  }

  // Source #2 — kids who qualify for the requested subject by
  // analysable-wrongs count but don't yet have a cache. Only runs
  // when ?subject= is provided.
  if (subjectKey) {
    const papers = await prisma.examPaper.findMany({
      where: {
        markingStatus: { in: ["complete", "released"] },
        assignedToId: { not: null },
        ...SUBJECT_FILTER[subjectKey],
      },
      select: {
        assignedToId: true, metadata: true,
        questions: { select: { marksAwarded: true, marksAvailable: true, studentAnswer: true, markingNotes: true, transcribedOptions: true } },
      },
    });
    // Track BOTH analysable-wrong count and distinct-paper count per
    // kid. The tutor route's data gate (loadTutorData at tutor.ts:932)
    // requires ≥3 papers; without mirroring that here, English kids
    // with 1-2 papers but 30+ MCQ items per paper showed up in the
    // admin dropdown but the page then returned "Not enough data yet"
    // on selection. Math/Science were unaffected because their papers
    // carry fewer items and the ≥15 wrongs threshold naturally requires
    // ≥3 papers anyway.
    const analysableByKid = new Map<string, number>();
    const papersByKid = new Map<string, number>();
    for (const p of papers) {
      if ((p.metadata as { revisionMode?: unknown } | null)?.revisionMode) continue;
      if (!p.assignedToId) continue;
      papersByKid.set(p.assignedToId, (papersByKid.get(p.assignedToId) ?? 0) + 1);
      let count = analysableByKid.get(p.assignedToId) ?? 0;
      for (const q of p.questions) {
        const av = q.marksAvailable ?? 0, aw = q.marksAwarded ?? 0;
        if (av === 0 || aw >= av) continue;
        if (q.studentAnswer === "__SKIPPED__") continue;
        const opts = q.transcribedOptions as unknown;
        const optsLen = Array.isArray(opts) ? opts.length : 0;
        const isMcq = optsLen >= 2 || MCQ_SHAPE.test(q.markingNotes ?? "");
        if (isMcq || (q.markingNotes && q.markingNotes.length >= 10)) count++;
      }
      analysableByKid.set(p.assignedToId, count);
    }
    const MIN_PAPERS = 3;
    for (const [kidId, count] of analysableByKid) {
      if (count < MIN_ANALYSABLE) continue;
      if ((papersByKid.get(kidId) ?? 0) < MIN_PAPERS) continue;
      if (hits.has(kidId)) continue;       // already covered via cache source
      const u = allUsers.find(x => x.id === kidId);
      if (!u || !u.name) continue;
      if (EXCLUDED_NAMES.has(u.name.toLowerCase())) continue;
      hits.set(kidId, { id: u.id, name: u.name, level: u.level, hasDiagnosis: false });
    }
  }

  const students = [...hits.values()].sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ students });
}
