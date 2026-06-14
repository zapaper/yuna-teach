// Smoke test for the four core kid flows. Hits the SAME API endpoints
// the production UI hits, so a quiet test run means each button (Assign
// Daily Quiz, taps in the quiz, Submit, opening Review) still works
// end-to-end.
//
// What it checks (same buttons → same handlers as in production):
//   (a) Assign Daily Quiz  → POST /api/daily-quiz
//   (b) Attempt quiz       → GET  /api/exam/[id]
//                            PATCH /api/exam/questions/[id]   (per Q)
//   (c) Submit quiz        → PATCH /api/exam/[id]              (completedAt)
//                            POST  /api/exam/[id]/mark
//   (d) Review quiz        → GET  /api/exam/[id]               (with marked data)
//
// Auth: reads eval/cookie.txt (same file used by run-marking-eval.ts).
// Cookie is the value of the yuna_session cookie for an admin user.
//
// Test student: env SMOKE_STUDENT_ID, else falls back to the first
// linked student the admin user has. Uses the existing student (no
// throwaway creation), so re-running just creates a fresh quiz paper
// for that kid — same as them getting a quiz manually. Pass --cleanup
// to delete the test paper after the run.
//
// Usage:
//   npx tsx scripts/run-smoke-test.ts                  (run, leave paper for inspection)
//   npx tsx scripts/run-smoke-test.ts --cleanup        (delete paper after)
//   SMOKE_STUDENT_ID=cmxxx... npx tsx scripts/run-smoke-test.ts
//   EVAL_REMOTE_BASE=http://localhost:3000 npx tsx scripts/run-smoke-test.ts

import { readFileSync } from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));

const POLL_MS = 3000;
const POLL_TIMEOUT_MS = 180_000; // marking takes a while on cold start

type Step = { label: string; ok: boolean; ms: number; detail?: string };
const steps: Step[] = [];

function readEvalConfig(): { base: string; cookie: string } {
  const envBase = process.env.EVAL_REMOTE_BASE;
  const envCookie = process.env.EVAL_SESSION_COOKIE;
  let base = envBase ?? "";
  let cookie = envCookie ?? "";
  if (!base) {
    try {
      const baseFile = path.join(__dirname, "..", "eval", "base.txt");
      const raw = readFileSync(baseFile, "utf-8").trim();
      if (raw) base = raw;
    } catch { /* fall through */ }
    if (!base) base = "https://www.markforyou.com";
  }
  if (!cookie) {
    try {
      const cookieFile = path.join(__dirname, "..", "eval", "cookie.txt");
      const raw = readFileSync(cookieFile, "utf-8").trim();
      if (raw) cookie = raw;
    } catch { /* fall through */ }
  }
  if (!cookie) {
    console.error("EVAL_SESSION_COOKIE or eval/cookie.txt required.");
    process.exit(1);
  }
  return { base, cookie };
}

const { base, cookie } = readEvalConfig();
const headers = { cookie: `yuna_session=${cookie}` } as const;
const jsonHeaders = { ...headers, "Content-Type": "application/json" } as const;

function fmtMs(ms: number) { return `${(ms / 1000).toFixed(1)}s`; }

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - t0;
    steps.push({ label, ok: true, ms });
    console.log(`  ✓ ${label.padEnd(45)} ${fmtMs(ms)}`);
    return out;
  } catch (err) {
    const ms = Date.now() - t0;
    const detail = err instanceof Error ? err.message : String(err);
    steps.push({ label, ok: false, ms, detail });
    console.log(`  ✗ ${label.padEnd(45)} ${fmtMs(ms)}  ${detail}`);
    throw err;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function resolveStudentId(): Promise<string> {
  if (process.env.SMOKE_STUDENT_ID) return process.env.SMOKE_STUDENT_ID;
  // /api/users (no userId param) is admin-only and returns all users
  // — admin's linkedStudents are populated on the row that matches
  // the session cookie. Pick the first linked student.
  const meRes = await fetch(`${base}/api/users/me`, { headers });
  if (meRes.ok) {
    const me = await meRes.json() as { user?: { id?: string; linkedStudents?: Array<{ id: string }> } };
    const linked = me.user?.linkedStudents ?? [];
    if (linked.length > 0) return linked[0].id;
    if (me.user?.id) return me.user.id;
  }
  throw new Error("Could not resolve a student id. Set SMOKE_STUDENT_ID env var.");
}

async function main() {
  const cleanup = process.argv.includes("--cleanup");
  console.log(`Smoke test → ${base}`);
  console.log(`Cookie: ${cookie.slice(0, 12)}…  cleanup=${cleanup}\n`);

  const studentId = await step("Resolve student id", async () => {
    const id = await resolveStudentId();
    console.log(`    student=${id}`);
    return id;
  });

  // ── (a) ASSIGN DAILY QUIZ ────────────────────────────────────────
  const paperId = await step("(a) POST /api/daily-quiz (assign)", async () => {
    const res = await fetch(`${base}/api/daily-quiz`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        userId: studentId,
        quizType: "mcq",
        subject: "math",  // smallest blast radius — math MCQ marker is fastest
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} — ${body.slice(0, 200)}`);
    }
    const j = await res.json() as { paperId?: string; id?: string };
    const id = j.paperId ?? j.id;
    assert(id, "no paperId in response");
    return id;
  });

  // ── (b) ATTEMPT — fetch + answer every Q ─────────────────────────
  const questions = await step("(b1) GET /api/exam/[id] (load quiz)", async () => {
    const res = await fetch(`${base}/api/exam/${paperId}`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json() as { questions?: Array<{ id: string; answer?: string | null; transcribedOptions?: unknown }> };
    assert(Array.isArray(j.questions) && j.questions.length > 0, "no questions");
    return j.questions;
  });

  await step(`(b2) PATCH ${questions.length} answers`, async () => {
    let okCount = 0;
    let failed = 0;
    for (const q of questions) {
      // Always answer option "1" — the test isn't checking correctness,
      // only that the persistence path works. Marker will compute
      // marks based on whether 1 happened to be right.
      const res = await fetch(`${base}/api/exam/questions/${q.id}`, {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ studentAnswer: "1" }),
      });
      if (res.ok) okCount++; else failed++;
    }
    assert(failed === 0, `${failed}/${questions.length} PATCH failed`);
    return okCount;
  });

  // ── (c) SUBMIT ───────────────────────────────────────────────────
  await step("(c1) PATCH /api/exam/[id] (completedAt)", async () => {
    const res = await fetch(`${base}/api/exam/${paperId}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ completedAt: new Date().toISOString(), timeSpentSeconds: 60 }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  await step("(c2) POST /api/exam/[id]/mark (kick marker)", async () => {
    const res = await fetch(`${base}/api/exam/${paperId}/mark`, {
      method: "POST",
      headers,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  // ── (d) REVIEW — poll until marked ───────────────────────────────
  const reviewed = await step("(d) GET /api/exam/[id] until markingStatus=complete", async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < POLL_TIMEOUT_MS) {
      const res = await fetch(`${base}/api/exam/${paperId}`, { headers });
      if (res.ok) {
        const j = await res.json() as {
          markingStatus?: string | null;
          score?: number | null;
          questions?: Array<{ id: string; marksAwarded: number | null }>;
        };
        if (j.markingStatus === "complete" || j.markingStatus === "released") {
          return j;
        }
      }
      await new Promise(r => setTimeout(r, POLL_MS));
    }
    throw new Error(`marker did not finish within ${POLL_TIMEOUT_MS / 1000}s`);
  });

  // Quality checks on the reviewed shape.
  await step("(d2) review payload has score + per-Q marks", async () => {
    assert(typeof reviewed.score === "number", "score missing");
    const qs = reviewed.questions ?? [];
    const withMarks = qs.filter(q => typeof q.marksAwarded === "number").length;
    assert(withMarks === qs.length, `only ${withMarks}/${qs.length} questions have marksAwarded`);
  });

  console.log(`\n  paperId=${paperId}`);
  console.log(`  score=${reviewed.score}`);

  // ── CLEANUP ──────────────────────────────────────────────────────
  if (cleanup) {
    console.log("\nCleanup: deleting test paper...");
    const prisma = new PrismaClient();
    try {
      await prisma.examPaper.delete({ where: { id: paperId } });
      console.log(`  ✓ paper ${paperId} deleted`);
    } catch (err) {
      console.warn("  ✗ cleanup failed:", err instanceof Error ? err.message : err);
    } finally {
      await prisma.$disconnect();
    }
  } else {
    console.log("\n(Test paper left in place. Pass --cleanup to delete it.)");
  }

  // ── SUMMARY ──────────────────────────────────────────────────────
  const failed = steps.filter(s => !s.ok);
  console.log(`\n=== Summary: ${steps.length - failed.length}/${steps.length} steps passed (${fmtMs(steps.reduce((s, x) => s + x.ms, 0))}) ===`);
  if (failed.length > 0) {
    console.log("\nFailed steps:");
    for (const s of failed) console.log(`  ✗ ${s.label} — ${s.detail}`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error("\nFATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
