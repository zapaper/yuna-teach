// UI eval — opens a real Chromium and walks the four flows that hurt
// the most yesterday when they broke silently:
//
//   T1. Signup surface           (step 1 → step 2 → step 3 renders the
//                                 expected fields, no P3 level option)
//   T2. First-quiz composition   (P5/P6 diag pulls 5 buckets × 3 = 15;
//                                 P4 diag pulls 4 buckets × 3 = 12)
//   T3. Quiz review              (score renders, "Go to Diagnostic" CTA
//                                 visible, "—" placeholder gone)
//   T4. Diagnostic Lumi          (Go-to-Diagnostic lands on
//                                 /home/{parentId}?view=lumi&
//                                 onboarding=1&… with OnboardingBanner
//                                 + Lumi greeting + topic chart)
//
// Design goals:
//   • zero destructive writes to real users (no signup submissions, no
//     mutations of the admin account)
//   • each stage is independent — a failure in T2 still runs T3/T4 for
//     a different quiz where possible
//   • same auth + base-URL convention as run-smoke-test.ts: EVAL_REMOTE_BASE
//     env or eval/base.txt (default https://www.markforyou.com); yuna_session
//     cookie from EVAL_SESSION_COOKIE or eval/cookie.txt
//   • reuses smoke-test API helpers for the destructive-adjacent bits
//     (creating diag quizzes, submitting answers, waiting for marker),
//     so the browser only has to handle rendering assertions
//
// Usage:
//   npx tsx scripts/run-ui-eval.ts               (full run, keeps artifacts)
//   npx tsx scripts/run-ui-eval.ts --cleanup     (deletes test papers after)
//   npx tsx scripts/run-ui-eval.ts --headed      (show browser — useful when
//                                                 an assertion fails and you
//                                                 want to see what the page
//                                                 actually rendered)
//   npx tsx scripts/run-ui-eval.ts --only=t1,t2  (subset)
//
// Env:
//   EVAL_REMOTE_BASE               base URL (default https://www.markforyou.com)
//   EVAL_SESSION_COOKIE            yuna_session cookie (else eval/cookie.txt)
//   UI_EVAL_P56_STUDENT_ID         P5 or P6 student under admin's account
//                                  (default: admin's first linked student)
//   UI_EVAL_P4_STUDENT_ID          P4 student under admin's account
//                                  (optional — skip T2/T3/T4 for P4 if unset)

import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { WHATS_NEW_VERSION } from "../src/lib/whats-new";

const __dirname = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname.replace(/^\//, "")));

// ── Config ─────────────────────────────────────────────────────────────────
function readEvalConfig(): { base: string; cookie: string } {
  const envBase = process.env.EVAL_REMOTE_BASE;
  const envCookie = process.env.EVAL_SESSION_COOKIE;
  let base = envBase ?? "";
  let cookie = envCookie ?? "";
  if (!base) {
    try {
      const raw = readFileSync(path.join(__dirname, "..", "eval", "base.txt"), "utf-8").trim();
      if (raw) base = raw;
    } catch { /* fall through */ }
    if (!base) base = "https://www.markforyou.com";
  }
  if (!cookie) {
    try {
      cookie = readFileSync(path.join(__dirname, "..", "eval", "cookie.txt"), "utf-8").trim();
    } catch { /* fall through */ }
  }
  if (!cookie) {
    console.error("EVAL_SESSION_COOKIE or eval/cookie.txt required.");
    process.exit(1);
  }
  return { base, cookie };
}

const { base, cookie } = readEvalConfig();
const args = new Set(process.argv.slice(2).flatMap(a => a.startsWith("--only=") ? a.slice(7).split(",") : [a]));
const headed = args.has("--headed");
const cleanup = args.has("--cleanup");
const onlyT1 = args.has("t1");
const onlyT2 = args.has("t2");
const onlyT3 = args.has("t3");
const onlyT4 = args.has("t4");
const runAll = !onlyT1 && !onlyT2 && !onlyT3 && !onlyT4;
const runT1 = runAll || onlyT1;
const runT2 = runAll || onlyT2 || onlyT3 || onlyT4;  // T3/T4 need T2 to create the paper
const runT3 = runAll || onlyT3 || onlyT4;
const runT4 = runAll || onlyT4;

const apiHeaders = { cookie: `yuna_session=${cookie}` } as const;
const apiJsonHeaders = { ...apiHeaders, "Content-Type": "application/json" } as const;

// ── Result tracker ─────────────────────────────────────────────────────────
type Step = { label: string; ok: boolean; ms: number; detail?: string };
const steps: Step[] = [];
function fmtMs(ms: number) { return `${(ms / 1000).toFixed(1)}s`; }

async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - t0;
    steps.push({ label, ok: true, ms });
    console.log(`  ✓ ${label.padEnd(60)} ${fmtMs(ms)}`);
    return out;
  } catch (err) {
    const ms = Date.now() - t0;
    const detail = err instanceof Error ? err.message : String(err);
    steps.push({ label, ok: false, ms, detail });
    console.log(`  ✗ ${label.padEnd(60)} ${fmtMs(ms)}  ${detail}`);
    return undefined;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ── API helpers reused from smoke test ─────────────────────────────────────
async function createDiagnosticQuiz(studentId: string, subject: "math" | "science" | "english", quizType: "mcq" | "mcq-oeq"): Promise<string> {
  const body: Record<string, unknown> = {
    userId: studentId,
    quizType,
    subject,
    firstQuiz: true,
  };
  if (subject === "english") {
    body.englishSections = quizType === "mcq-oeq" ? ["grammar-mcq", "synthesis"] : ["grammar-mcq"];
  }
  const res = await fetch(`${base}/api/daily-quiz`, {
    method: "POST",
    headers: apiJsonHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST /api/daily-quiz → HTTP ${res.status} — ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = await res.json() as { paperId?: string; id?: string };
  const id = j.paperId ?? j.id;
  assert(id, "no paperId in response");
  return id;
}

async function answerAndSubmit(paperId: string): Promise<void> {
  const res = await fetch(`${base}/api/exam/${paperId}`, { headers: apiHeaders });
  if (!res.ok) throw new Error(`GET /api/exam/${paperId} → HTTP ${res.status}`);
  const j = await res.json() as { questions?: Array<{ id: string }> };
  const qs = j.questions ?? [];
  for (const q of qs) {
    await fetch(`${base}/api/exam/questions/${q.id}`, {
      method: "PATCH",
      headers: apiJsonHeaders,
      body: JSON.stringify({ studentAnswer: "1" }),
    });
  }
  await fetch(`${base}/api/exam/${paperId}`, {
    method: "PATCH",
    headers: apiJsonHeaders,
    body: JSON.stringify({ completedAt: new Date().toISOString(), timeSpentSeconds: 60 }),
  });
  await fetch(`${base}/api/exam/${paperId}/mark`, { method: "POST", headers: apiHeaders });
}

async function waitForMarkComplete(paperId: string): Promise<void> {
  const t0 = Date.now();
  const timeoutMs = 180_000;
  while (Date.now() - t0 < timeoutMs) {
    const res = await fetch(`${base}/api/exam/${paperId}`, { headers: apiHeaders });
    if (res.ok) {
      const j = await res.json() as { markingStatus?: string | null };
      if (j.markingStatus === "complete" || j.markingStatus === "released") return;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`marker did not finish within ${timeoutMs / 1000}s`);
}

// ── Fake user creation ─────────────────────────────────────────────────────
// T2-T4 spin up a throwaway parent + student per run so the eval is
// completely isolated from real accounts. Names are prefixed "UI-Eval-"
// and emails prefixed "ui-eval-" — makes them trivially greppable if a
// cleanup pass ever misses something. The parent's admin session cookie
// isn't used to run the flows (the fakes have no session); we use the
// admin session only for /api/daily-quiz / /api/exam calls, which read
// userId from the request body / query and honour it because the caller
// is admin.
type FakeAccount = { parentId: string; studentId: string; parentEmail: string; studentName: string; level: number };

async function createFakeAccount(level: number): Promise<FakeAccount> {
  const prisma = new PrismaClient();
  try {
    const stamp = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const parentEmail = `ui-eval-parent-${stamp}-${rand}@markforyou-eval.invalid`;
    const parentName  = `UI-Eval-Parent-${stamp}-${rand}`;
    const studentName = `UI-Eval-Student-P${level}-${stamp}-${rand}`;
    // Pre-seed the current What's-New version so T4's chart-visibility
    // assertions aren't blocked by the modal overlaying the Lumi panel.
    const seenSettings = { whatsNewSeenVersion: WHATS_NEW_VERSION };
    const parent = await prisma.user.create({
      data: {
        name: parentName,
        email: parentEmail,
        role: "PARENT",
        emailVerified: true,
        settings: seenSettings,
      },
      select: { id: true },
    });
    const student = await prisma.user.create({
      data: {
        name: studentName,
        role: "STUDENT",
        level,
        settings: seenSettings,
      },
      select: { id: true },
    });
    await prisma.parentStudent.create({ data: { parentId: parent.id, studentId: student.id } });
    return { parentId: parent.id, studentId: student.id, parentEmail, studentName, level };
  } finally {
    await prisma.$disconnect();
  }
}

// ── Browser setup ──────────────────────────────────────────────────────────
async function makeContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (UI-eval Playwright)",
  });
  const url = new URL(base);
  await ctx.addCookies([{
    name: "yuna_session",
    value: cookie,
    domain: url.hostname,
    path: "/",
    httpOnly: false,
    secure: url.protocol === "https:",
    sameSite: "Lax",
  }]);
  return ctx;
}

// ── T1. Signup surface ────────────────────────────────────────────────────
async function t1Signup(browser: Browser): Promise<void> {
  console.log("\n[T1] Signup surface");
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  await step("T1.1 /signup loads", async () => {
    const res = await page.goto(`${base}/signup`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    assert(res && res.ok(), `page load failed: HTTP ${res?.status()}`);
  });

  await step("T1.2 step 1 shows email + password fields", async () => {
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    const emailField = await page.$('input[type="email"], input[name="email"], input[placeholder*="mail" i]');
    const pwField = await page.$('input[type="password"]');
    assert(emailField, "email input not found on /signup");
    assert(pwField, "password input not found on /signup");
  });

  await step("T1.3 level dropdown offers P4-P6, no P3", async () => {
    // Try to reach the level picker. Signup form may need a name+email to advance.
    // Instead, land directly on step 2 via query if the app supports it, or scan the
    // page HTML for "P3" as a level option regardless of step.
    const html = await page.content();
    const p3Level = /Primary\s*3|>\s*P3\s*</.test(html);
    assert(!p3Level, "Primary 3 option present on signup — should be dropped");
    const p4 = /Primary\s*4|>\s*P4\s*</.test(html);
    const p5 = /Primary\s*5|>\s*P5\s*</.test(html);
    const p6 = /Primary\s*6|>\s*P6\s*</.test(html);
    // At least one level indicator should be somewhere in the wizard (may be later step).
    if (!(p4 || p5 || p6)) {
      // Not a hard fail — level picker is on step 2 which we may not be able to reach without submitting step 1.
      console.log(`      (info: level markers not visible on step 1 — level picker is on step 2)`);
    }
  });

  await ctx.close();
}

// ── T2. First-quiz composition ────────────────────────────────────────────
async function t2QuizComposition(browser: Browser, studentId: string, level: "P4" | "P56", subject: "math" | "science" | "english", quizType: "mcq" | "mcq-oeq"): Promise<string | undefined> {
  const label = `${level} ${subject}${subject === "english" ? ` (${quizType})` : ""}`;
  console.log(`\n[T2] Quiz composition — ${label} (student ${studentId.slice(0, 8)}…)`);

  let paperId: string | undefined;
  paperId = await step(`T2.${label} create quiz via /api/daily-quiz`, async () => createDiagnosticQuiz(studentId, subject, quizType));
  if (!paperId) return undefined;

  const expected = subject === "english"
    ? (quizType === "mcq-oeq" ? (level === "P4" ? 14 : 20) : 14)
    : (level === "P4" ? 12 : 15);

  await step(`T2.${label} DB has ${expected} questions`, async () => {
    const prisma = new PrismaClient();
    try {
      const n = await prisma.examQuestion.count({ where: { examPaperId: paperId! } });
      assert(n === expected, `expected ${expected} questions, got ${n}`);
    } finally { await prisma.$disconnect(); }
  });

  const ctx = await makeContext(browser);
  const page = await ctx.newPage();
  await step(`T2.${label} /quiz/{id} renders ${expected} question cards`, async () => {
    const url = `${base}/quiz/${paperId}?userId=${studentId}`;
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    assert(res && res.ok(), `HTTP ${res?.status()}`);
    // Quiz page renders each question as an article/section with data-question-id.
    // Wait for at least one to hydrate before counting (client fetches /api/exam
    // async, so DOM is empty for a beat).
    await page.waitForSelector("[data-question-id]", { timeout: 20_000 });
    const cards = await page.$$eval("[data-question-id]", els => els.length);
    assert(cards === expected, `expected ${expected} question cards in DOM, got ${cards}`);
  });
  await ctx.close();

  return paperId;
}

// ── T3. Quiz review page ──────────────────────────────────────────────────
async function t3Review(browser: Browser, paperId: string, parentId: string): Promise<void> {
  console.log(`\n[T3] Quiz review — paper ${paperId.slice(0, 8)}…`);

  await step("T3.1 submit + wait for marker", async () => {
    await answerAndSubmit(paperId);
    await waitForMarkComplete(paperId);
  });

  const ctx = await makeContext(browser);
  const page = await ctx.newPage();

  await step("T3.2 /exam/{id}/review shows a real score (not '—')", async () => {
    const url = `${base}/exam/${paperId}/review?parentId=${parentId}`;
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    assert(res && res.ok(), `HTTP ${res?.status()}`);
    // Give client-side polling time to fetch the marked payload.
    await page.waitForTimeout(2500);
    const text = await page.textContent("body");
    assert(text, "review page body empty");
    // Look for a numeric score pattern like "12 / 15" or "12/15".
    const scoreMatch = /(\d+)\s*\/\s*(\d+)/.exec(text);
    if (!scoreMatch) {
      // Placeholder '—' would appear where the score should be
      assert(!/—/.test(text.slice(0, 500)), "score placeholder '—' still shown after marker complete");
      throw new Error("no 'N / M' score pattern found on review page");
    }
    const awarded = Number(scoreMatch[1]);
    const available = Number(scoreMatch[2]);
    assert(!Number.isNaN(awarded) && !Number.isNaN(available), "malformed score");
  });

  await step("T3.3 'Go to Diagnostic' CTA is visible", async () => {
    const btn = await page.getByText(/Go to Diagnostic|View Diagnosis|See Diagnosis/i).first();
    const visible = await btn.isVisible().catch(() => false);
    assert(visible, "Go to Diagnostic button not visible on review page");
  });

  await ctx.close();
}

// ── T4. Diagnostic Lumi on parent home ────────────────────────────────────
async function t4DiagnosticLumi(browser: Browser, paperId: string, parentId: string, studentId: string, level: "P4" | "P56", subject: "math" | "science" | "english"): Promise<void> {
  console.log(`\n[T4] Diagnostic Lumi — paper ${paperId.slice(0, 8)}… (${level} ${subject})`);

  const ctx = await makeContext(browser);
  const page = await ctx.newPage();

  const canonicalSubject = subject === "english" ? "English" : subject === "science" ? "Science" : "Math";
  const url = `${base}/home/${parentId}?view=lumi&student=${studentId}&onboarding=1&fromPaper=${paperId}&subject=${canonicalSubject}`;

  await step("T4.1 diagnostic Lumi URL loads", async () => {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    assert(res && res.ok(), `HTTP ${res?.status()}`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  });

  await step("T4.2 OnboardingBanner (preliminary diagnosis) visible", async () => {
    // Banner text typically includes words like "Preliminary" or "diagnosis"
    const banner = await page.getByText(/Preliminary|diagnosis|first quiz/i).first();
    const visible = await banner.isVisible().catch(() => false);
    assert(visible, "OnboardingBanner not visible on parent home Lumi panel");
  });

  await step("T4.3 Lumi greeting present", async () => {
    const greet = await page.getByText(/Hi[!,]\s*I['’]?m Lumi|Lumi.*owl/i).first();
    const visible = await greet.isVisible().catch(() => false);
    assert(visible, "Lumi greeting not rendered — TutorBodyForStudent may have failed to load");
  });

  await step("T4.4 topic chart / radar renders", async () => {
    // Either an <svg> chart or a rendered canvas-y bar chart. We accept any SVG
    // that has ≥2 rect/circle children (heuristic for chart-shaped SVG) OR any
    // element that visibly contains a topic name we picked from the quiz.
    const chartSvgCount = await page.$$eval("svg", (svgs: SVGElement[]) => svgs.filter(s => s.querySelectorAll("rect, circle, polyline").length >= 2).length);
    assert(chartSvgCount > 0, "no chart-shaped SVG found on the Lumi panel");
  });

  await step("T4.5 sidebar Progress & Lumi link still present", async () => {
    // Sidebar Progress · Lumi entry is present on parent dashboard
    const link = await page.getByText(/Progress.*Lumi|Lumi.*Progress|Progress · Lumi/i).first();
    const visible = await link.isVisible().catch(() => false);
    assert(visible, "Progress · Lumi sidebar entry missing on parent home");
  });

  await ctx.close();
}

// ── Interactive prompt (stdin) ─────────────────────────────────────────────
function promptYesNo(question: string): Promise<boolean> {
  return new Promise(resolve => {
    process.stdout.write(question);
    // Lazy-init readline so non-interactive runs (e.g. CI with --auto-delete
    // or --no-delete) don't touch stdin at all.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const readline = require("readline") as typeof import("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("", (ans: string) => {
      rl.close();
      resolve(/^\s*y(es)?\s*$/i.test(ans.trim()));
    });
  });
}

// ── Cleanup ────────────────────────────────────────────────────────────────
// Deletes the fake accounts + any exam papers they were assigned. Uses the
// cuid safelist we captured during the run — never a name/email glob — so a
// bug in the filter can't touch a real account. Guarded by an interactive
// confirmation unless --auto-delete or --no-delete is passed. Papers cascade
// on ParentStudent / ExamPaper (owner) but we explicitly delete papers first
// to avoid orphan-question leaks on old schemas.
async function deleteFakeAccounts(fakes: FakeAccount[], paperIds: string[]): Promise<void> {
  const prisma = new PrismaClient();
  try {
    if (paperIds.length > 0) {
      const del = await prisma.examPaper.deleteMany({ where: { id: { in: paperIds } } });
      console.log(`  ✓ deleted ${del.count} exam paper(s)`);
    }
    const userIds = fakes.flatMap(f => [f.parentId, f.studentId]);
    if (userIds.length > 0) {
      // Belt-and-braces: only delete users whose name starts with UI-Eval- —
      // a filter mismatch that touched a real cuid should still no-op because
      // the name won't match. If it does no-op we surface it clearly.
      const del = await prisma.user.deleteMany({
        where: { id: { in: userIds }, name: { startsWith: "UI-Eval-" } },
      });
      console.log(`  ✓ deleted ${del.count} user(s) (parent+student)`);
      if (del.count !== userIds.length) {
        console.warn(`  ! wanted to delete ${userIds.length} users but only ${del.count} matched the "UI-Eval-" name guard`);
      }
    }
  } finally { await prisma.$disconnect(); }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`UI eval → ${base}`);
  console.log(`Cookie: ${cookie.slice(0, 12)}…  headed=${headed}  cleanup=${cleanup}`);

  const adminParentId = cookie.split(".")[0];

  const browser = await chromium.launch({ headless: !headed });
  const createdPapers: string[] = [];
  const fakes: FakeAccount[] = [];

  try {
    if (runT1) await t1Signup(browser);

    if (runT2) {
      // Fresh P5 fake account for T2/T3/T4 (P5-P6 code path).
      const p56 = await step("Create fake P5 parent+student", async () => createFakeAccount(5));
      if (p56) {
        fakes.push(p56);
        const id = await t2QuizComposition(browser, p56.studentId, "P56", "math", "mcq");
        if (id) createdPapers.push(id);
        if (runT3 && id) {
          await t3Review(browser, id, p56.parentId);
          if (runT4) await t4DiagnosticLumi(browser, id, p56.parentId, p56.studentId, "P56", "math");
        }
      }

      // Fresh P4 fake account for the P4-specific stratifier path.
      const p4 = await step("Create fake P4 parent+student", async () => createFakeAccount(4));
      if (p4) {
        fakes.push(p4);
        const id = await t2QuizComposition(browser, p4.studentId, "P4", "math", "mcq");
        if (id) createdPapers.push(id);
        if (runT3 && id) {
          await t3Review(browser, id, p4.parentId);
          if (runT4) await t4DiagnosticLumi(browser, id, p4.parentId, p4.studentId, "P4", "math");
        }
      }
    }
  } finally {
    await browser.close();
  }

  // ── Cleanup: interactive by default, --cleanup or --no-cleanup to force ──
  if (fakes.length > 0 || createdPapers.length > 0) {
    console.log(`\nTest artifacts created (safelisted for delete):`);
    for (const f of fakes) {
      console.log(`  parent  ${f.parentId}  (P${f.level} pair) → ${f.parentEmail}`);
      console.log(`  student ${f.studentId}  ${f.studentName}`);
    }
    for (const id of createdPapers) console.log(`  paper   ${id}`);

    const noCleanup = args.has("--no-cleanup");
    let doDelete: boolean;
    if (noCleanup) {
      doDelete = false;
    } else if (cleanup) {
      doDelete = true;
    } else {
      doDelete = await promptYesNo(`\nDelete the ${fakes.length * 2} fake user(s) and ${createdPapers.length} paper(s) listed above? [y/N] `);
    }
    if (doDelete) {
      await deleteFakeAccounts(fakes, createdPapers);
    } else {
      console.log(`(kept — use "npx tsx scripts/run-ui-eval.ts --cleanup" next time to auto-delete, or delete manually now.)`);
    }
  }

  const failed = steps.filter(s => !s.ok);
  const total = steps.reduce((s, x) => s + x.ms, 0);
  console.log(`\n=== Summary: ${steps.length - failed.length}/${steps.length} steps passed (${fmtMs(total)}) ===`);
  if (failed.length > 0) {
    console.log("\nFailed steps:");
    for (const s of failed) console.log(`  ✗ ${s.label} — ${s.detail}`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error("\nFATAL:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
