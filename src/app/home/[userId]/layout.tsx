import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session";

// force-dynamic — never cache the layout response. The session
// cookie read should already opt this layout out of static
// rendering, but being explicit prevents any edge-cache layer from
// serving a previous "allow" decision after the user has signed out.
export const dynamic = "force-dynamic";

// Server-side gate for /home/[userId] routes.
//
// Previously the home page trusted the URL's userId blindly — anyone
// with the link could open someone else's dashboard. Now the signed
// session cookie must resolve to the same user. If it doesn't (no
// cookie, expired cookie, or the cookie belongs to a different
// account), we redirect to /login with a `next` param so the user
// lands back on the intended page after authenticating.
//
// Note: the cookie is httpOnly + signed — clients can't forge it.
// Browser-tab handoff (e.g. parent passing the device to the child)
// works correctly: the new logged-in user gets a fresh session
// cookie, which matches the URL on subsequent requests.

export default async function HomeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  const sessionId = await getSessionUserId();
  if (!sessionId) {
    redirect(`/login?next=${encodeURIComponent(`/home/${userId}`)}`);
  }
  if (sessionId !== userId) {
    // Cookie is for a different account. Forcing a fresh login is
    // the safest path — the user lands on /login, signs in as the
    // right account, and gets redirected back to /home/<sessionId>.
    redirect(`/login?next=${encodeURIComponent(`/home/${userId}`)}`);
  }
  return <>{children}</>;
}
