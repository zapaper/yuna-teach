import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { prisma } from "@/lib/db";
import { transcribeMathMcqQuestion, transcribeMathOpenEndedQuestion, DiagramBounds } from "@/lib/gemini";

/** Normalize answer string to bare digit, e.g. "(2)" → "2" */
function normalizeMcqAnswer(ans: string | null): string {
  if (!ans) return "";
  return ans.trim().replace(/[().]/g, "").trim();
}

function isMathMcq(answer: string | null): boolean {
  const n = normalizeMcqAnswer(answer);
  return n === "1" || n === "2" || n === "3" || n === "4";
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

  const cropped = await sharp(buf)
    .extract({ left, top, width, height })
    .grayscale()
    .normalize()
    .sharpen()
    .jpeg({ quality: 90 })
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
      transcribedSubparts: true, diagramBounds: true, diagramImageData: true,
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
      stem: string | null;
      options: string[] | null;
      optionImages: string[] | null;
      subparts: { label: string; text: string }[] | null;
      diagramBounds: { top: number; left: number; bottom: number; right: number } | null;
      diagramImageData: string | null;
    }[];
  };

  await Promise.all(
    questions.map(q =>
      prisma.examQuestion.update({
        where: { id: q.id },
        data: {
          transcribedStem: q.stem,
          transcribedOptions: q.options ?? undefined,
          transcribedOptionImages: q.optionImages ?? undefined,
          transcribedSubparts: q.subparts ?? undefined,
          diagramBounds: q.diagramBounds ?? undefined,
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
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { subject: true },
  });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });

  const subjectLower = (paper.subject ?? "").toLowerCase();
  if (!subjectLower.includes("math")) {
    return NextResponse.json({ error: "Only Math papers supported for now" }, { status: 400 });
  }

  const questions = await prisma.examQuestion.findMany({
    where: { examPaperId: id },
    orderBy: { orderIndex: "asc" },
    select: { id: true, questionNum: true, answer: true, imageData: true, syllabusTopic: true, marksAvailable: true },
  });

  console.log(`[transcribe] Paper ${id}: transcribing ${questions.length} questions (MCQ + open-ended)`);

  const results = await Promise.all(
    questions.map(async (q) => {
      const base64 = q.imageData.replace(/^data:image\/\w+;base64,/, "");
      const mcq = isMathMcq(q.answer);
      try {
        if (mcq) {
          const transcribed = await transcribeMathMcqQuestion(base64);
          const diagramBase64 = transcribed.diagram
            ? await cropDiagram(base64, transcribed.diagram).catch(() => null)
            : null;
          return {
            id: q.id,
            type: "mcq" as const,
            questionNum: q.questionNum,
            answer: normalizeMcqAnswer(q.answer),
            syllabusTopic: q.syllabusTopic,
            marksAvailable: q.marksAvailable,
            stem: transcribed.stem,
            options: transcribed.options,
            subparts: null,
            diagramBounds: transcribed.diagram ?? null,
            diagramBase64,
            error: null,
          };
        } else {
          const transcribed = await transcribeMathOpenEndedQuestion(base64);
          const diagramBase64 = transcribed.diagram
            ? await cropDiagram(base64, transcribed.diagram).catch(() => null)
            : null;
          return {
            id: q.id,
            type: "open" as const,
            questionNum: q.questionNum,
            answer: q.answer ?? "",
            syllabusTopic: q.syllabusTopic,
            marksAvailable: q.marksAvailable,
            stem: transcribed.stem,
            options: null,
            subparts: transcribed.subparts,
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
          subparts: null,
          diagramBounds: null,
          diagramBase64: null,
          error: err instanceof Error ? err.message : "Failed",
        };
      }
    })
  );

  return NextResponse.json({ questions: results });
}
