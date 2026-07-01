import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// GET /api/admin/english-oral-coach/corpus
//
// Returns the 10-year PSLE English Paper 4 corpus for the admin
// Oral-Coach design harness. For each ingested year:
//   - basic metadata (year, status, char count)
//   - a preview of the Reading Passage section
//   - a preview of the Stimulus-based Conversation prompts section
//
// The paper4Text field bundles both components separated by
// "STIMULUS-BASED CONVERSATION" / "STIMULUS-BASED CONVERSATION PROMPTS"
// markers from the source PDF. We split on those markers so the two
// components can be inspected independently, and clip each preview to
// ~1500 chars so the payload stays lightweight for the picker UI.

export async function GET(request: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const papers = await prisma.englishSupplementaryPaper.findMany({
    where: { paper4Text: { not: null } },
    orderBy: { year: "desc" },
    select: {
      year: true,
      status: true,
      paper4Pages: true,
      paper4Text: true,
    },
  });

  const rows = papers.map((p) => {
    const text = p.paper4Text ?? "";
    const { reading, conversation } = splitPaper4(text);
    return {
      year: p.year,
      status: p.status,
      paper4TextChars: text.length,
      hasPaper4Pages: p.paper4Pages !== null,
      readingPassagePreview: reading.slice(0, 1500),
      conversationPromptsPreview: conversation.slice(0, 1500),
    };
  });

  return NextResponse.json({ rows });
}

// Split the raw OCR'd Paper 4 blob into (reading passage, conversation
// prompts). Section markers seen in the 2016-2025 corpus:
//   "READING PASSAGE"                — start of Component 1
//   "STIMULUS-BASED CONVERSATION"    — Component 2 (may appear with
//                                     "PROMPTS" suffix in prompts sheet)
// Falls back to naive halves if markers are absent.
function splitPaper4(text: string): { reading: string; conversation: string } {
  if (!text) return { reading: "", conversation: "" };
  const upper = text.toUpperCase();
  const stimulusIdx = upper.indexOf("STIMULUS-BASED CONVERSATION");
  if (stimulusIdx < 0) {
    // No conversation section found — treat everything as reading.
    return { reading: text.trim(), conversation: "" };
  }
  const readingRaw = text.slice(0, stimulusIdx);
  const conversationRaw = text.slice(stimulusIdx);
  // Strip the "READING PASSAGE" header block from the top of the
  // reading section so the preview starts at the actual passage.
  const readingCleaned = readingRaw.replace(
    /^.*?READING PASSAGE.*?(\r?\n){1,2}/is,
    "",
  ).trim();
  return { reading: readingCleaned, conversation: conversationRaw.trim() };
}
