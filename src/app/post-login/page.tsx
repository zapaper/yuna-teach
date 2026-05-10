import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { setSession, getSessionUserId } from "@/lib/session";

// Dispatcher landed-on after a successful Google/Apple sign-in.
// Reads the NextAuth JWT (stamped with our internal user id by
// the jwt callback in src/lib/auth.ts), sets our own
// yuna_session cookie, and forwards to /home/<id>. Setting
// yuna_session HERE — instead of in the signIn callback — works
// around Auth.js v5 not reliably propagating callback-set
// cookies through the OAuth-callback redirect response.

export const dynamic = "force-dynamic";

export default async function PostLogin() {
  // Already signed in to our cookie? Honour it. This handles the
  // username/password flow and repeat OAuth visits.
  const existing = await getSessionUserId();
  if (existing) {
    console.log(`[post-login] already-signed-in userId=${existing}`);
    redirect(`/home/${existing}`);
  }

  // Otherwise read the NextAuth JWT and bridge it into our cookie.
  const session = await auth();
  const uid = (session as { uid?: string } | null)?.uid
    ?? (session?.user as { uid?: string } | undefined)?.uid;
  if (!uid) {
    console.warn(`[post-login] no NextAuth session — bouncing to /login`);
    redirect("/login");
  }
  await setSession(uid);
  console.log(`[post-login] bridged NextAuth JWT → yuna_session for userId=${uid}`);
  redirect(`/home/${uid}`);
}
