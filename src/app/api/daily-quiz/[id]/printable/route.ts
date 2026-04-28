// Printable PDF for a daily quiz / focused practice clone. The
// existing /api/focused-test/[id]/printable endpoint is paper-agnostic
// (it just renders ExamPaper.questions onto A4 with the print code
// stamped top-right), so we re-export the same handler under this
// path for callers that came in via the daily-quiz creation flow.
export { GET } from "@/app/api/focused-test/[id]/printable/route";
