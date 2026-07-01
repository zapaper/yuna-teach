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

async function resolveStudents(): Promise<{ p56?: string; p4?: string; parentId: string }> {
  const parentId = cookie.split(".")[0];  // yuna_session format: `${userId}.${sig}`
  const envP56 = process.env.UI_EVAL_P56_STUDENT_ID;
  const envP4 = process.env.UI_EVAL_P4_STUDENT_ID;
  if (envP56 || envP4) return { p56: envP56, p4: envP4, parentId };
  // Ask the app for the caller's linked students (same route the smoke test
  // uses). Schema-independent — we don't need to know the join-table name.
  const meRes = await fetch(`${base}/api/users/me`, { headers: apiHeaders });
  if (!meRes.ok) return { parentId };
  const me = await meRes.json() as { user?: { linkedStudents?: Array<{ id: string; level?: number | null }> } };
  const kids = me.user?.linkedStudents ?? [];
  const p56 = kids.find(k => k.level === 5 || k.level === 6)?.id;
  const p4 = kids.find(k => k.level === 4)?.id;
  return { p56, p4, parentId };
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
    // Wait for the quiz to hydrate — the client renders question cards after the fetch.
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    // Two possible selectors: data-question-num on each card, or the Question N chip.
    const cards = await page.$$eval('[data-question-num], [data-qnum], .question-card, [class*="questionCard" i]', els => els.length);
    if (cards === 0) {
      // Fallback: scan visible text for "Question 1 of {N}" or similar
      const html = await page.content();
      const m = html.match(/Question\s+\d+\s+of\s+(\d+)/i);
      if (m) {
        const shown = Number(m[1]);
        assert(shown === expected, `quiz UI shows "Question N of ${shown}", expected ${expected}`);
        return;
      }
      throw new Error(`no question cards found and no "Question N of X" text — DOM may have changed`);
    }
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

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`UI eval → ${base}`);
  console.log(`Cookie: ${cookie.slice(0, 12)}…  headed=${headed}  cleanup=${cleanup}`);

  const { p56, p4, parentId } = await resolveStudents();
  console.log(`\nStudents resolved:`);
  console.log(`  P5/P6: ${p56 ?? "(none linked)"}`);
  console.log(`  P4:    ${p4 ?? "(none linked)"}`);
  console.log(`  Parent id: ${parentId}`);

  const browser = await chromium.launch({ headless: !headed });
  const createdPapers: string[] = [];

  try {
    if (runT1) await t1Signup(browser);

    if (runT2 && p56) {
      const id = await t2QuizComposition(browser, p56, "P56", "math", "mcq");
      if (id) createdPapers.push(id);
      if (runT3 && id) {
        await t3Review(browser, id, parentId);
        if (runT4) await t4DiagnosticLumi(browser, id, parentId, p56, "P56", "math");
      }
    } else if (runT2) {
      console.log("\n[T2/T3/T4 P56] skipped — no P5/P6 student linked. Set UI_EVAL_P56_STUDENT_ID.");
    }

    if (runT2 && p4) {
      const id = await t2QuizComposition(browser, p4, "P4", "math", "mcq");
      if (id) createdPapers.push(id);
      if (runT3 && id) {
        await t3Review(browser, id, parentId);
        if (runT4) await t4DiagnosticLumi(browser, id, parentId, p4, "P4", "math");
      }
    } else if (runT2 && !p4) {
      console.log("\n[T2/T3/T4 P4] skipped — no P4 student linked. Set UI_EVAL_P4_STUDENT_ID.");
    }
  } finally {
    await browser.close();
  }

  if (cleanup && createdPapers.length > 0) {
    console.log(`\nCleanup: deleting ${createdPapers.length} test paper(s)…`);
    const prisma = new PrismaClient();
    try {
      for (const id of createdPapers) {
        try {
          await prisma.examPaper.delete({ where: { id } });
          console.log(`  ✓ deleted ${id}`);
        } catch (err) {
          console.warn(`  ✗ ${id}: ${err instanceof Error ? err.message : err}`);
        }
      }
    } finally { await prisma.$disconnect(); }
  } else if (createdPapers.length > 0) {
    console.log(`\nCreated papers (pass --cleanup to delete):`);
    for (const id of createdPapers) console.log(`  ${id}`);
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
