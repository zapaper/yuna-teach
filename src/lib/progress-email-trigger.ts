// Thin wrapper that the marking API route awaits after a paper's
// markingStatus flips to complete / released. Looks up the paper to
// resolve studentId + subject, then hands off to the eligibility +
// send logic in scripts/send-progress-emails.ts.
//
// All errors are caught + logged. Returning a rejected promise here
// would silently break the marking pipeline, so we never throw.

import { prisma } from "@/lib/db";

export async function triggerProgressEmailFromPaper(paperId: string): Promise<void> {
  try {
    const paper = await prisma.examPaper.findUnique({
      where: { id: paperId },
      select: { id: true, assignedToId: true, subject: true, markingStatus: true },
    });
    if (!paper) return;
    if (!paper.assignedToId) return;
    if (paper.markingStatus !== "complete" && paper.markingStatus !== "released") return;
    // Dynamic import keeps the heavier @napi-rs/canvas + sgMail deps
    // out of route bundles that never need them — only the few API
    // routes that call this trigger pay the cost.
    const { triggerForStudentSubject } = await import("../../scripts/send-progress-emails");
    await triggerForStudentSubject(paper.assignedToId, paper.subject);
  } catch (err) {
    console.error(`[progress-email-trigger] paperId=${paperId} failed:`, err);
  }
}
