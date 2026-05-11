import { NextRequest, NextResponse } from "next/server";

// API-wide default-deny authentication.
//
// Every /api/* request must carry a valid signed yuna_session
// cookie. Routes that legitimately have no session (login,
// signup, third-party webhooks) are whitelisted below.
//
// Why default-deny: the previous "opt-in auth" pattern meant
// every new endpoint was one missed import away from being a
// data leak. Symptoms seen in production:
//   - /api/exam/[id]/submission returned scanned answer pages
//     without any auth check at all.
//   - /api/parent-recommendations accepted parentId+studentId as
//     query params and trusted them — anyone with the IDs (which
//     leak through URLs, screenshots, history) could read.
// This middleware closes the broad surface; individual routes
// still need their own resource-ownership checks for things like
// "is this admin allowed to view that student's data".
//
// Runs in Node runtime so we can use Node's crypto.createHmac
// to verify the existing yuna_session cookie format (matches
// src/lib/session.ts).

export const runtime = "nodejs";

const COOKIE_NAME = "yuna_session";

// Paths that may be hit without a session cookie. Add new
// webhooks / public-facing endpoints here, and ONLY here.
// Each must enforce its own auth internally.
const PUBLIC_REGEXES: RegExp[] = [
  // NextAuth + our hybrid post-login bridge.
  /^\/api\/auth(\/.*)?$/,
  // Health / status endpoints (none currently — placeholder).
  // /^\/api\/health$/,
  // Webhooks (each has its own shared-secret auth).
  /^\/api\/inbound-email\/?$/,           // SendGrid Basic Auth (route-level)
  /^\/api\/iap\/asn-webhook\/?$/,        // RevenueCat signed header (route-level)
];

// Some paths are public for ONE method but auth'd for others.
function methodAwareAllowed(pathname: string, method: string): boolean {
  // POST /api/users = signup, unauth'd. GET /api/users = list, auth'd.
  if (pathname === "/api/users" && method === "POST") return true;
  return false;
}

function verifyYunaSession(cookieValue: string | undefined): boolean {
  if (!cookieValue) return false;
  const [id, sig] = cookieValue.split(".");
  if (!id || !sig) return false;
  const secret = process.env.SESSION_SECRET ?? "dev-only-change-me-in-production";
  const crypto = require("crypto");
  const expected = crypto.createHmac("sha256", secret).update(id).digest("hex");
  return expected === sig;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only enforce auth on /api/* — every other path (pages,
  // _next/*, public assets) is unaffected.
  if (!pathname.startsWith("/api/")) return NextResponse.next();

  // Public whitelist.
  for (const re of PUBLIC_REGEXES) {
    if (re.test(pathname)) return NextResponse.next();
  }
  if (methodAwareAllowed(pathname, request.method)) return NextResponse.next();

  // Default: require a valid yuna_session cookie.
  const cookie = request.cookies.get(COOKIE_NAME)?.value;
  if (!verifyYunaSession(cookie)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  // Run on every /api/* path. The "/api/:path*" form is the
  // matcher syntax Next.js middleware understands.
  matcher: "/api/:path*",
};
