import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";
import { isAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

// Server-side gate for /home/[userId] routes.
//
// Allows: the matching user themselves, OR an admin (admin uses the
// "Open home" deeplink on /admin/users for support workflows).
// Anyone else — no cookie, expired cookie, cookie for a different
// non-admin account — is redirected to /login with a ?next= param.

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
    const sessionUser = await prisma.user.findUnique({
      where: { id: sessionId },
      select: { name: true, settings: true },
    });
    if (!isAdmin(sessionUser)) {
      redirect(`/login?next=${encodeURIComponent(`/home/${userId}`)}`);
    }
  }
  return <>{children}</>;
}
