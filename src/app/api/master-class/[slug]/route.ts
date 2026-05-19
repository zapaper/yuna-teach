import { NextRequest, NextResponse } from "next/server";
import { getMasterClassHydrated } from "@/lib/master-class/hydrate";

// GET /api/master-class/[slug]
// Returns the Master Class content with any admin edits applied.
// Used by the student-facing player so saved scripts show up live
// without a redeploy.
export async function GET(_req: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const content = await getMasterClassHydrated(slug);
  if (!content) return NextResponse.json({ error: "Master Class not found" }, { status: 404 });
  return NextResponse.json({ content });
}
