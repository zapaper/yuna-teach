import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { setSession, getSessionUserId } from "@/lib/session";

// Dispatcher landed-on after a successful Google/Apple sign-in.
// Reads the NextAuth JWT (stamped with our internal user id by the
// jwt callback in src/lib/auth.ts), sets our own yuna_session
// cookie, and forwards to /home/<id>.
//
// Implemented as a Route Handler (not a Server Component) because
// Next.js 16 disallows cookie writes from Server Components — the
// previous page.tsx version threw "Cookies can only be modified in
// a Server Action or Route Handler" the first time setSession()
// ran. Route Handlers are explicitly cookie-write-safe.

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // On Railway request.url is the internal pod address
  // (https://0.0.0.0:8080/...) — using it for redirects sends users
  // to 0.0.0.0:8080. Build the public base from the forwarded
  // headers the proxy adds; fall back to request.url's host only as
  // a last resort.
  const fwdHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const fwdProto = request.headers.get("x-forwarded-proto") ?? "https";
  const base = fwdHost ? `${fwdProto}://${fwdHost}` : new URL(request.url).origin;

  // Already signed in to our cookie? Honour it. This handles repeat
  // OAuth visits after the cookie's already been set.
  const existing = await getSessionUserId();
  if (existing) {
    console.log(`[post-login] already-signed-in userId=${existing} base=${base}`);
    return NextResponse.redirect(new URL(`/home/${existing}`, base));
  }

  // Otherwise read the NextAuth JWT and bridge it into our cookie.
  const session = await auth();
  const uid = (session as { uid?: string } | null)?.uid
    ?? (session?.user as { uid?: string } | undefined)?.uid;
  if (!uid) {
    console.warn(`[post-login] no NextAuth session — bouncing to /login (base=${base})`);
    return NextResponse.redirect(new URL("/login", base));
  }
  await setSession(uid);
  console.log(`[post-login] bridged NextAuth JWT → yuna_session for userId=${uid} base=${base}`);
  return NextResponse.redirect(new URL(`/home/${uid}`, base));
}
