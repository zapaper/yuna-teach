// GET  /api/email-prefs?token=<signed>  — return current prefs for the
//                                          user the token resolves to.
// POST /api/email-prefs?token=<signed>  — update prefs. Body shape:
//                                          { marketing, progress, features }
//                                          (each boolean).
//
// No session required — the signed token is the credential. This is
// intentional: parents click the link from an email and shouldn't
// have to remember a password just to opt out.

import { NextRequest, NextResponse } from "next/server";
import {
  EmailPrefs,
  getEmailPrefs,
  setEmailPrefs,
  verifyUnsubscribeToken,
  DEFAULT_PREFS,
} from "@/lib/email-prefs";

function pickPrefs(body: unknown): EmailPrefs {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    marketing: typeof b.marketing === "boolean" ? b.marketing : DEFAULT_PREFS.marketing,
    progress:  typeof b.progress  === "boolean" ? b.progress  : DEFAULT_PREFS.progress,
    features:  typeof b.features  === "boolean" ? b.features  : DEFAULT_PREFS.features,
  };
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const userId = verifyUnsubscribeToken(token);
  if (!userId) {
    return NextResponse.json({ error: "Invalid or missing token" }, { status: 400 });
  }
  const prefs = await getEmailPrefs(userId);
  return NextResponse.json({ prefs });
}

export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const userId = verifyUnsubscribeToken(token);
  if (!userId) {
    return NextResponse.json({ error: "Invalid or missing token" }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const prefs = pickPrefs(body);
  try {
    const saved = await setEmailPrefs(userId, prefs);
    return NextResponse.json({ prefs: saved });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
