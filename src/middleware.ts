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
  // Railway deploy healthcheck. No auth, no DB hit — just returns 200.
  // Public so Railway can probe without a session cookie.
  /^\/api\/health$/,
  // Webhooks (each has its own shared-secret auth).
  /^\/api\/inbound-email\/?$/,           // SendGrid Basic Auth (route-level)
  /^\/api\/iap\/asn-webhook\/?$/,        // RevenueCat signed header (route-level)
  // markforyou-mailer cron pulls daily user data from here. Route
  // handler verifies Bearer ${NURTURE_API_TOKEN} OR an admin session,
  // so the middleware bypass is safe.
  /^\/api\/admin\/parent-progress\/?$/,
  // markforyou-mailer Daily Emails dashboard "Refresh from main app"
  // pulls server-event email records from here. Route handler verifies
  // Bearer ${NURTURE_API_TOKEN} OR an admin session.
  /^\/api\/admin\/email-events\/?$/,
  // markforyou-mailer quiz-activity summaries for the
  // weekly-progress / nurture emails. Bearer ${NURTURE_API_TOKEN}.
  /^\/api\/admin\/activity-summary\/?$/,
];

// Some paths are public for ONE method but auth'd for others.
function methodAwareAllowed(pathname: string, method: string): boolean {
  // POST /api/users = signup, unauth'd. GET /api/users = list, auth'd.
  if (pathname === "/api/users" && method === "POST") return true;
  // GET /api/users/check?name=...|?email=... = "is this name/email
  // available" check on signup / username-picker screens. Called
  // before the user has a session — must be reachable unauth. Read
  // only, returns just { available: boolean }.
  if (pathname === "/api/users/check" && method === "GET") return true;
  // GET /api/users/lookup?id=... = "fetch username by userId" used
  // by the login page to pre-fill the identity field when bounced
  // from /home/<userId> with no session. Called before the user has
  // a session. Read-only, returns just { name: string | null }.
  // Exposure equivalent to /api/users/check (userId → name leak vs
  // name → exists leak); userId is already in the URL the caller
  // arrived from.
  if (pathname === "/api/users/lookup" && method === "GET") return true;
  return false;
}

type SessionCheck = { ok: true } | { ok: false; reason: "no_cookie" | "malformed" | "bad_sig" };

function verifyYunaSession(cookieValue: string | undefined): SessionCheck {
  if (!cookieValue) return { ok: false, reason: "no_cookie" };
  const [id, sig] = cookieValue.split(".");
  if (!id || !sig) return { ok: false, reason: "malformed" };
  const secret = process.env.SESSION_SECRET ?? "dev-only-change-me-in-production";
  const crypto = require("crypto");
  const expected = crypto.createHmac("sha256", secret).update(id).digest("hex");
  if (expected !== sig) return { ok: false, reason: "bad_sig" };
  return { ok: true };
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── Apex → www canonicalisation ──────────────────────────────────
  // Google OAuth + NEXTAUTH_URL are wired to www.markforyou.com.
  // Hitting apex (markforyou.com) breaks the Google callback because
  // the redirect_uri allow-list + the pkceCodeVerifier cookie are
  // bound to the www origin. Permanently redirect every apex request
  // to www before any other logic runs.
  const host = request.headers.get("host") ?? "";
  if (host === "markforyou.com" || host === "markforyou.com:8080") {
    const url = request.nextUrl.clone();
    url.host = "www.markforyou.com";
    url.protocol = "https:";
    url.port = "";
    return NextResponse.redirect(url, 308);
  }
  // Strip the :8080 (or any explicit port) from the canonical hosts.
  // Railway's internal load balancer sometimes echoes the proxy port
  // into the Host header, so users hit URLs like www.markforyou.com:8080
  // — which Google OAuth, cookies, and the rest of the app aren't
  // registered for. Permanently redirect to the port-less canonical
  // before anything else runs.
  if (host === "www.markforyou.com:8080" || host === "markforyou.com:8080") {
    const url = request.nextUrl.clone();
    url.host = "www.markforyou.com";
    url.protocol = "https:";
    url.port = "";
    return NextResponse.redirect(url, 308);
  }

  // Only enforce auth on /api/* — every other path (pages,
  // _next/*, public assets) is unaffected.
  if (!pathname.startsWith("/api/")) return NextResponse.next();

  // Public whitelist.
  for (const re of PUBLIC_REGEXES) {
    if (re.test(pathname)) return NextResponse.next();
  }
  if (methodAwareAllowed(pathname, request.method)) return NextResponse.next();

  // Default: require a valid yuna_session cookie. Log the reason
  // when we reject so silent "kicked to /login" reports have a
  // trail in Railway. Includes a short UA + the cookie-id prefix
  // (NOT the signature) so we can tell whether the user even
  // sent a cookie and which user-id it claimed to be.
  const cookie = request.cookies.get(COOKIE_NAME)?.value;
  const check = verifyYunaSession(cookie);
  if (!check.ok) {
    const idPrefix = cookie ? cookie.split(".")[0]?.slice(0, 12) ?? "" : "";
    const ua = request.headers.get("user-agent") ?? "";
    const uaTag = /Capacitor|MarkForYou|CFNetwork/i.test(ua) ? "ios-app"
      : /iPhone|iPad/i.test(ua) ? "ios-safari"
      : /Android/i.test(ua) ? "android"
      : "web";
    // Suppress log for known-noisy fire-and-forget paths that pre-date
    // a settled cookie. The callers (signup/onboarding) treat failure
    // as non-fatal — the missing cookie is expected during the cookie-
    // set + redirect dance, especially in iOS WKWebView. Security is
    // unchanged: we still return 401, the routes' own auth checks
    // still fire if the middleware ever lets them through.
    const isNoisy = request.method === "PATCH" && pathname === "/api/users";
    if (!isNoisy) {
      console.warn(
        `[middleware] 401 ${request.method} ${pathname} reason=${check.reason} ua=${uaTag} id=${idPrefix || "none"}`,
      );
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  // Two layered concerns: (a) the apex→www redirect needs to fire on
  // every page route too (login, home, /api, etc.), and (b) the
  // /api/* auth gate runs on every API call. The negative-lookahead
  // matcher catches everything except Next's own static asset paths
  // and a handful of public root-level files we serve from /public.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|icon\\.png|apple-icon\\.png|opengraph-image\\.png|email-images/).*)",
  ],
};
