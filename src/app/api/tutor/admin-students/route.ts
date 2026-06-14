import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guard";
import { TUTOR_CACHE } from "@/lib/tutor-cache";

// Returns every student we have a workshop diagnosis cached for, so an
// admin can browse the Tutor view across all the kids that have been
// onboarded — even ones not linked to the admin's own parent account.
// Used to populate the Tutor page's student selector when the caller
// is an admin.
//
// Cache keys are `<safeName>:<subject>` lowercased with dashes — see
// the safeName helper in src/lib/tutor.ts. We extract the unique safe
// names from the bundled cache map, then look up the matching User
// rows by case-insensitive name (after re-spacing the dashes).
export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const safeNames = new Set<string>();
  for (const key of Object.keys(TUTOR_CACHE)) {
    const [safe] = key.split(":");
    if (safe) safeNames.add(safe);
  }
  // safe name → candidate user-name patterns. The safeName helper
  // lowercased and dash-joined non-alphanumerics, so "Mark Lim" became
  // "mark-lim" and "JeremiahSy" became "jeremiahsy". We match against
  // the User table by stripping dashes/spaces and lower-casing for a
  // fuzzy compare — no need to be exact since name collisions among
  // P5/P6 students in this app are rare.
  const allUsers = await prisma.user.findMany({
    where: { role: "STUDENT" },
    select: { id: true, name: true, level: true },
  });
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const students: Array<{ id: string; name: string; level: number | null }> = [];
  const seen = new Set<string>();
  for (const safe of safeNames) {
    const target = norm(safe);
    const hit = allUsers.find(u => u.name && norm(u.name) === target);
    if (hit && !seen.has(hit.id)) {
      students.push({ id: hit.id, name: hit.name!, level: hit.level });
      seen.add(hit.id);
    }
  }
  students.sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ students });
}
