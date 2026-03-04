import { NextRequest, NextResponse } from "next/server";
import { generateFeedbackSummary } from "@/lib/marking";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const feedback = await generateFeedbackSummary(id);
    return NextResponse.json({ feedbackSummary: feedback });
  } catch (err) {
    console.error("[feedback] Generation failed:", err);
    return NextResponse.json(
      { error: "Failed to generate feedback" },
      { status: 500 }
    );
  }
}
