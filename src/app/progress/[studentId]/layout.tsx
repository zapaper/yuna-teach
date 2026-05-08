import { isAuthorizedForStudent, redirectToLogin } from "@/lib/access";

export const dynamic = "force-dynamic";

// Gate /progress/[studentId] — only the student themselves, their
// linked parent(s), or an admin can view the progress dashboard.
// Anyone else with the link is bounced to /login.

export default async function ProgressLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ studentId: string }>;
}) {
  const { studentId } = await params;
  const auth = await isAuthorizedForStudent(studentId);
  if (!auth.ok) {
    redirectToLogin(`/progress/${studentId}`);
  }
  return <>{children}</>;
}
