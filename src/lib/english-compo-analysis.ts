// English composition analyser — parallel pipeline to compo-analysis.ts
// (which handles Chinese). The two modules MUST stay isolated:
//   - separate prompts (PSLE English rubric, not 华文)
//   - separate model essays (EnglishSupplementaryPaper.continuousModel /
//     situationalModel)
//   - separate output shapes when they diverge (Content 18 / Language 18
//     for Continuous; Task 6 / Language 8 for Situational)
//
// CompoAttempt rows route here when `language === "english"`. The
// dispatcher lives in compo-analysis.ts → analyseCompoAttempt().
//
// Stages will be added in chunk 2 of the build:
//   1. OCR             — English-aware handwriting transcription
//   2. Wrong words     — grammar / spelling / word choice
//   3. Critique        — Continuous 36 (Content 18 + Language 18) OR
//                        Situational 14 (Task 6 + Language 8)
//   4. Recommendations — sentence variety, "show don't tell", vocab
//   5. Elevated draft  — rewrite targeting 32-36 / 12-14

import { prisma } from "@/lib/db";

export async function analyseEnglishCompoAttempt(attemptId: string): Promise<void> {
  const tag = `[english-compo:${attemptId.slice(-6)}]`;
  console.log(`${tag} ── analyse start ────────────────────────`);
  // Stub for chunk 1 — flips the row to "failed" with a clear message
  // so admins testing the language picker see a deterministic error
  // instead of a hang. Chunk 2 replaces this with the full pipeline.
  await prisma.compoAttempt.update({
    where: { id: attemptId },
    data: {
      status: "failed",
      errorMessage:
        "English composition analyser is not yet wired (chunk 2 of the build). " +
        "The schema + router are in place; the analyser arrives in the next commit.",
    },
  });
  console.log(`${tag} stub: row marked failed with not-implemented note`);
}
