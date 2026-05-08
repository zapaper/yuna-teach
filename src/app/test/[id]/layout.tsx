import { prisma } from "@/lib/db";
import { isAuthorizedForStudent, redirectToLogin } from "@/lib/access";

// Gate /test/[id] (spelling) — only the test owner, their linked
// parent(s), or an admin can view + take it. Anyone else with the
// link is bounced to /login.

export default async function TestLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const test = await prisma.spellingTest.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!test) {
    redirectToLogin(`/test/${id}`);
  }
  // The test "belongs to" a user (could be a student who scanned it
  // themselves, or a parent who saved it for the family). Either the
  // owner or a linked parent of the owner can open the test.
  const auth = await isAuthorizedForStudent(test.userId);
  if (!auth.ok) {
    redirectToLogin(`/test/${id}`);
  }
  return <>{children}</>;
}
