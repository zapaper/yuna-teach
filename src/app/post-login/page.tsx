import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session";

// Dispatcher landed-on after a successful Google/Apple sign-in.
// The signIn callback in src/lib/auth.ts has already set our
// `yuna_session` cookie; this page reads the verified user id
// from it and forwards to /home/<id>. If the cookie is somehow
// missing, fall through to /login so the user isn't stranded.

export const dynamic = "force-dynamic";

export default async function PostLogin() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  redirect(`/home/${userId}`);
}
