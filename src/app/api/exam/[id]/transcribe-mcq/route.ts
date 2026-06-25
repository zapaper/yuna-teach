import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  transcribeMathMcqQuestion, transcribeMathOpenEndedQuestion,
  transcribeScienceMcqQuestion, transcribeScienceOpenEndedQuestion,
  detectQuestionType,
  DiagramBounds,
} from "@/lib/gemini";

/** Normalize MCQ answer to bare digit "1"–"4", handling A/B/C/D and (2) formats */
function normalizeMcqAnswer(ans: string | null): string {
  if (!ans) return "";
  const n = ans.trim().replace(/[().]/g, "").trim().toUpperCase();
  // Convert A/B/C/D → 1/2/3/4
  if (n === "A") return "1";
  if (n === "B") return "2";
  if (n === "C") return "3";
  if (n === "D") return "4";
  return n;
}

/** Crop the diagram bounding box from a base64 question image and return enhanced base64 */
async function cropDiagram(imageBase64: string, bounds: DiagramBounds): Promise<string> {
  const buf = Buffer.from(imageBase64, "base64");
  const meta = await sharp(buf).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;

  const PAD = 0.02; // 2% padding on each side
  const left = Math.max(0, Math.round(((bounds.left / 100) - PAD) * w));
  const top = Math.max(0, Math.round(((bounds.top / 100) - PAD) * h));
  const right = Math.min(w, Math.round(((bounds.right / 100) + PAD) * w));
  const bottom = Math.min(h, Math.round(((bounds.bottom / 100) + PAD) * h));
  const width = Math.max(right - left, 1);
  const height = Math.max(bottom - top, 1);

  // Drop sharpen — it amplified anti-aliasing into grey halos
  // around dark text and made faint lines look fuzzy. Bump JPEG
  // quality to 95 so the 8×8 DCT blocks become near-invisible
  // around text edges. Keep grayscale + normalize (helps faded
  // scans). Output stays JPEG so the 13+ <img src="data:image/jpeg;…">
  // call sites don't need touching.
  const cropped = await sharp(buf)
    .extract({ left, top, width, height })
    .grayscale()
    .normalize()
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toBuffer();

  return cropped.toString("base64");
}

/** GET — return saved transcription data from DB */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const questions = await prisma.examQuestion.findMany({
    where: { examPaperId: id },
    orderBy: { orderIndex: "asc" },
    select: {
      id: true, questionNum: true, answer: true, syllabusTopic: true, marksAvailable: true,
      transcribedStem: true, transcribedOptions: true, transcribedOptionImages: true,
      transcribedOptionTable: true, transcribedSubparts: true, diagramBounds: true,
      diagramImageData: true,
    },
  });
  const hasSaved = questions.some(q => q.transcribedStem || q.diagramImageData || q.transcribedOptionImages);
  return NextResponse.json({ hasSaved, questions });
}

/** PUT — save all transcription data to DB */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { questions } = await req.json() as {
    questions: {
      id: string;
      answer?: string | null;
      stem: string | null;
      options: string[] | null;
      optionImages: string[] | null;
      optionTable?: { columns: string[]; rows: string[][] } | null;
      subparts: { label: string; text: string }[] | null;
      diagramBounds: { top: number; left: number; bottom: number; right: number } | null;
      diagramImageData: string | null;
    }[];
  };

  // Nullable JSON columns need Prisma.DbNull to actually clear the
  // column -- `?? undefined` collapses null → undefined and Prisma
  // then skips the field, leaving the OLD value in place. The
  // canonical case: kid toggles a question MCQ → OEQ on the
  // transcribe-edit page, the client sends options: null, the save
  // appears to succeed but a page refresh shows the row still
  // classified as MCQ because transcribedOptions stayed
  // ["","","",""]. Map explicit nulls to Prisma.DbNull while still
  // letting undefined skip the field.
  const dbNullable = <T,>(v: T | null | undefined): T | typeof Prisma.DbNull | undefined =>
    v === null ? Prisma.DbNull : v === undefined ? undefined : v;
  await Promise.all(
    questions.map(q =>
      prisma.examQuestion.update({
        where: { id: q.id },
        data: {
          ...(q.answer !== undefined ? { answer: q.answer } : {}),
          transcribedStem: q.stem,
          transcribedOptions: dbNullable(q.options) as Prisma.InputJsonValue | typeof Prisma.DbNull | undefined,
          transcribedOptionImages: dbNullable(q.optionImages) as Prisma.InputJsonValue | typeof Prisma.DbNull | undefined,
          transcribedOptionTable: dbNullable(q.optionTable) as Prisma.InputJsonValue | typeof Prisma.DbNull | undefined,
          transcribedSubparts: dbNullable(q.subparts) as Prisma.InputJsonValue | typeof Prisma.DbNull | undefined,
          diagramBounds: dbNullable(q.diagramBounds) as Prisma.InputJsonValue | typeof Prisma.DbNull | undefined,
          diagramImageData: q.diagramImageData,
        },
      })
    )
  );

  // Verify they belong to this paper
  const paper = await prisma.examPaper.findUnique({ where: { id }, select: { id: true } });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });

  return NextResponse.json({ ok: true, saved: questions.length });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { subject: true },
  });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });

  const subjectLower = (paper.subject ?? "").toLowerCase();
  const isScience = subjectLower.includes("science");
  if (!subjectLower.includes("math") && !isScience) {
    return NextResponse.json({ error: "Clean extraction is supported for Math and Science papers" }, { status: 400 });
  }

  // ?force=1 re-transcribes every question even if it already has saved
  // transcription data. Default is RESUME mode: questions with a saved
  // transcribedStem return the cached row instantly, only the unfinished
  // ones hit Gemini. This makes the endpoint idempotent and survives
  // Cloudflare's 100s timeout on long (40+ question) papers — the
  // client just retries and the queue shrinks each round.
  const force = req.nextUrl.searchParams.get("force") === "1";

  const questions = await prisma.examQuestion.findMany({
    where: { examPaperId: id },
    orderBy: { orderIndex: "asc" },
    select: {
      id: true, questionNum: true, orderIndex: true, answer: true, imageData: true,
      syllabusTopic: true, marksAvailable: true,
      transcribedStem: true, transcribedOptions: true, transcribedOptionImages: true,
      transcribedOptionTable: true, transcribedSubparts: true,
      diagramBounds: true, diagramImageData: true,
    },
  });

  const alreadyDone = force ? 0 : questions.filter(q => (q.transcribedStem ?? "").trim().length > 0).length;
  console.log(`[transcribe] Paper ${id}: transcribing ${questions.length} questions (MCQ + open-ended)${force ? " — FORCE mode (will re-transcribe)" : alreadyDone > 0 ? ` — RESUME mode (${alreadyDone} already cached)` : ""}`);

  /** Strip trailing letters from questionNum to get the base, e.g. "35c" → "35", "35ab" → "35" */
  function baseQNum(questionNum: string) {
    return questionNum.replace(/[a-zA-Z]+$/, "");
  }

  /**
   * For Science OEQ follow-up parts (e.g. Q35c when Q35a/35b exist earlier),
   * prepend the first part's image so Gemini can see the preamble/context.
   * Returns the (possibly stitched) base64 JPEG string.
   */
  async function getContextualBase64(q: typeof questions[number]): Promise<string> {
    const raw = q.imageData.replace(/^data:image\/\w+;base64,/, "");
    if (!isScience) return raw;

    const base = baseQNum(q.questionNum);
    // Find the earliest sibling in this group that appears before this question
    const siblings = questions.filter(s =>
      s.id !== q.id &&
      baseQNum(s.questionNum) === base &&
      s.orderIndex < q.orderIndex
    );
    if (siblings.length === 0) return raw;

    // Stitch the first sibling's image on top of the current image
    const firstSibling = siblings.sort((a, b) => a.orderIndex - b.orderIndex)[0];
    const sibBase64 = firstSibling.imageData.replace(/^data:image\/\w+;base64,/, "");

    const topBuf = Buffer.from(sibBase64, "base64");
    const botBuf = Buffer.from(raw, "base64");
    const topMeta = await sharp(topBuf).metadata();
    const botMeta = await sharp(botBuf).metadata();

    const w = Math.max(topMeta.width ?? 0, botMeta.width ?? 0);
    const topResized = await sharp(topBuf).resize({ width: w, fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } }).toBuffer();
    const botResized = await sharp(botBuf).resize({ width: w, fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } }).toBuffer();
    const topH = (await sharp(topResized).metadata()).height ?? 0;
    const botH = (await sharp(botResized).metadata()).height ?? 0;

    const stitched = await sharp({
      create: { width: w, height: topH + botH, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        { input: topResized, top: 0, left: 0 },
        { input: botResized, top: topH, left: 0 },
      ])
      .jpeg({ quality: 90 })
      .toBuffer();

    return stitched.toString("base64");
  }

  // Sliding-window concurrency. Firing all ~28-40 transcription calls
  // through Promise.all hammers the 3.1-pro-preview tier hard enough
  // to trigger cascading 504s — we then burn 90s/question on retries
  // before falling through to flash. Cap concurrent in-flight calls
  // at 10: as one finishes the next starts, no batch-edge stalls.
  const CONCURRENCY = 10;
  const results: Array<Awaited<ReturnType<typeof transcribeOne>>> = new Array(questions.length);
  async function transcribeOne(q: typeof questions[number]) {
      // RESUME: if this question already has saved transcription data
      // (transcribedStem populated), return the cached row instantly
      // without burning a Gemini call. Bypassed by ?force=1.
      if (!force && (q.transcribedStem ?? "").trim().length > 0) {
        const ansNorm = (q.answer ?? "").trim().replace(/[().]/g, "").trim();
        const cachedMcq = /^[1-4]$/.test(ansNorm) || (q.transcribedOptions != null) || (q.transcribedOptionImages != null) || (q.transcribedOptionTable != null);
        return {
          id: q.id,
          type: cachedMcq ? "mcq" as const : "open" as const,
          questionNum: q.questionNum,
          answer: cachedMcq ? normalizeMcqAnswer(q.answer) : (q.answer ?? ""),
          syllabusTopic: q.syllabusTopic,
          marksAvailable: q.marksAvailable,
          stem: q.transcribedStem,
          options: (q.transcribedOptions as string[] | null) ?? null,
          optionImages: (q.transcribedOptionImages as (string | null)[] | null) ?? null,
          optionTable: q.transcribedOptionTable as { columns: string[]; rows: string[][] } | null ?? null,
          subparts: (q.transcribedSubparts as { label: string; text: string }[] | null) ?? null,
          diagramBounds: q.diagramBounds as DiagramBounds | null ?? null,
          diagramBase64: q.diagramImageData ? q.diagramImageData.replace(/^data:image\/\w+;base64,/, "") : null,
          error: null,
          cached: true as const,
        };
      }
      const base64 = await getContextualBase64(q);
      // Answer-first check — the answer key is the ground-truth
      // signal for MCQ vs OEQ. A stored answer of "(1)" / "(2)" /
      // "(3)" / "(4)" / bare "1"-"4" can ONLY come from an MCQ.
      // Override the vision-based detection in that case so Science
      // MCQs whose options ARE a table or image set (where the
      // visual detector frequently misreads "no MCQ buttons present"
      // as OEQ) still route through the MCQ extractor — which is
      // the only one that knows how to pull optionTable /
      // optionImages out of the image.
      const ansNormalized = (q.answer ?? "").trim().replace(/[().]/g, "").trim();
      const answerLooksMcq = /^[1-4]$/.test(ansNormalized);
      let mcq: boolean;
      if (answerLooksMcq) {
        mcq = true;
      } else {
        // Detect MCQ vs OEQ from the image itself when the answer
        // doesn't give us a clear signal (no answer key yet, or the
        // answer is text — typical for non-Science OEQ).
        const detectedType = await detectQuestionType(base64);
        mcq = detectedType === "mcq";
      }
      try {
        if (mcq) {
          // Science MCQ can additionally come back as a table-
          // format option set; the math extractor never does. Pull
          // optionTable from the result when the science variant
          // chose that shape; otherwise it's null.
          const transcribed = await (isScience ? transcribeScienceMcqQuestion(base64) : transcribeMathMcqQuestion(base64));
          const optionTable = isScience
            ? (transcribed as { optionTable?: { columns: string[]; rows: string[][] } | null }).optionTable ?? null
            : null;
          const diagramBase64 = transcribed.diagram
            ? await cropDiagram(base64, transcribed.diagram).catch(() => null)
            : null;

          // Auto-crop option images when Gemini returns option
          // bounding boxes. Skipped when the extractor chose
          // table-format — table cells are text-only.
          let optionImages: (string | null)[] | null = null;
          if (!optionTable && transcribed.optionBounds && transcribed.optionBounds.some(b => b !== null)) {
            optionImages = await Promise.all(
              transcribed.optionBounds.map(b =>
                b ? cropDiagram(base64, b).catch(() => null) : null
              )
            );
          }

          return {
            id: q.id,
            type: "mcq" as const,
            questionNum: q.questionNum,
            answer: normalizeMcqAnswer(q.answer),
            syllabusTopic: q.syllabusTopic,
            marksAvailable: q.marksAvailable,
            stem: transcribed.stem,
            options: optionTable || optionImages ? null : transcribed.options,
            optionImages,
            optionTable,
            subparts: null,
            diagramBounds: transcribed.diagram ?? null,
            diagramBase64,
            error: null,
          };
        } else {
          // Derive the segment letters BEFORE the call so we can hint
          // Gemini up-front (preferred) and also defensively filter
          // afterwards (belt-and-braces in case the hint isn't honoured).
          const segLetterMatch = q.questionNum.match(/^\d+([a-zA-Z]+)$/);
          const focusSubparts = segLetterMatch ? segLetterMatch[1].toLowerCase().split("") : undefined;
          const transcribed = await (isScience
            ? transcribeScienceOpenEndedQuestion(base64, focusSubparts && focusSubparts.length > 0 ? { focusSubparts } : undefined)
            : transcribeMathOpenEndedQuestion(base64));
          const diagramBase64 = transcribed.diagram
            ? await cropDiagram(base64, transcribed.diagram).catch(() => null)
            : null;
          // Defensive post-filter — even with the prompt hint above,
          // trim subparts to this segment's own letters in case Gemini
          // still emits sibling labels. Tracks the dropped count for
          // log visibility.
          if (focusSubparts && transcribed.subparts.length > 0) {
            const segLetters = new Set(focusSubparts);
            const before = transcribed.subparts.length;
            transcribed.subparts = transcribed.subparts.filter(sp => segLetters.has(sp.label.toLowerCase()));
            if (transcribed.subparts.length < before) {
              console.log(`[transcribe] Q${q.questionNum} split-segment filter: trimmed ${before - transcribed.subparts.length} sibling subparts (kept ${[...segLetters].join(",")})`);
            }
          }
          // Even-distribution default for per-subpart marks: if the
          // model didn't pull "[Nmarks]" suffixes off any subpart but
          // the total marksAvailable divides cleanly across the
          // subparts (e.g. 2 marks ÷ 2 subparts = 1 each), append the
          // inferred "[Nmarks]" suffix so admin/UI/marker all see it.
          const subs = transcribed.subparts;
          const hasAnyMarksSuffix = subs.some(s => /\[\s*\d+\s*(?:m(?:ark)?s?)?\s*\]/i.test(s.text ?? ""));
          const totalMarks = q.marksAvailable ?? null;
          if (!hasAnyMarksSuffix && subs.length > 0 && totalMarks && totalMarks > 0) {
            const perPart = totalMarks / subs.length;
            if (Number.isInteger(perPart) && perPart > 0) {
              for (const sp of subs) {
                sp.text = `${(sp.text ?? "").trim()} [${perPart}marks]`.trim();
              }
            }
          }
          return {
            id: q.id,
            type: "open" as const,
            questionNum: q.questionNum,
            answer: q.answer ?? "",
            syllabusTopic: q.syllabusTopic,
            marksAvailable: q.marksAvailable,
            stem: transcribed.stem,
            options: null,
            optionImages: null,
            optionTable: null,
            subparts: subs,
            diagramBounds: transcribed.diagram ?? null,
            diagramBase64,
            error: null,
          };
        }
      } catch (err) {
        console.error(`[transcribe] Q${q.questionNum} failed:`, err);
        return {
          id: q.id,
          type: mcq ? "mcq" as const : "open" as const,
          questionNum: q.questionNum,
          answer: mcq ? normalizeMcqAnswer(q.answer) : (q.answer ?? ""),
          syllabusTopic: q.syllabusTopic,
          marksAvailable: q.marksAvailable,
          stem: null,
          options: null,
          optionImages: null,
          optionTable: null,
          subparts: null,
          diagramBounds: null,
          diagramBase64: null,
          error: err instanceof Error ? err.message : "Failed",
        };
      }
  }

  // Worker also persists each successful Gemini result to the DB
  // immediately so a subsequent retry (after a Cloudflare 524 / network
  // blip) skips it via the RESUME branch above. The admin still hits
  // Save explicitly in the UI to lock in the human-reviewed final
  // version — what we save here is a "Gemini cache" used purely by
  // the resume path.
  async function persist(r: NonNullable<Awaited<ReturnType<typeof transcribeOne>>>) {
    // Don't re-save the cached-from-DB rows.
    if ("cached" in r && r.cached) return;
    if (r.error) return;                   // failed call — let it retry next time
    if (!r.stem || !r.stem.trim()) return; // nothing useful to cache
    try {
      await prisma.examQuestion.update({
        where: { id: r.id },
        data: {
          transcribedStem: r.stem,
          transcribedOptions: r.options ?? Prisma.DbNull,
          transcribedOptionImages: r.optionImages ?? Prisma.DbNull,
          transcribedOptionTable: r.optionTable ?? Prisma.DbNull,
          transcribedSubparts: r.subparts ?? Prisma.DbNull,
          diagramBounds: r.diagramBounds ?? Prisma.DbNull,
          diagramImageData: r.diagramBase64 ? `data:image/jpeg;base64,${r.diagramBase64}` : null,
        },
      });
    } catch (e) {
      console.warn(`[transcribe] persist Q${r.questionNum} cache failed:`, e instanceof Error ? e.message : e);
    }
  }

  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, questions.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= questions.length) return;
      const r = await transcribeOne(questions[i]);
      results[i] = r;
      if (r) await persist(r);
    }
  });
  await Promise.all(workers);

  const cachedCount = results.filter(r => r && "cached" in r && r.cached).length;
  const errorCount = results.filter(r => r && r.error).length;
  console.log(`[transcribe] Paper ${id} done. ${cachedCount} cached, ${results.length - cachedCount - errorCount} freshly transcribed, ${errorCount} failed.`);
  return NextResponse.json({ questions: results });
}
