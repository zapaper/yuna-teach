import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { DEFAULT_TRIAL_DAYS } from "@/lib/subscription";
import { requireSelfOrAdmin, requireAdmin, requireSession } from "@/lib/auth-guard";
import { setSession } from "@/lib/session";

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");

  // ?userId=<id> returns a single user under `user`. Caller must
  // be the user themselves OR an admin — was previously open to
  // anyone with an id, leaking email + subscription state + the
  // full parent/student link graph.
  if (userId) {
    const auth = await requireSelfOrAdmin(userId);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const u = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        parentLinks: { include: { student: { select: { id: true, name: true, displayName: true, level: true, settings: true } } } },
        studentLinks: { include: { parent: { select: { id: true, name: true, displayName: true } } } },
      },
    });
    if (!u) return NextResponse.json({ user: null }, { status: 404 });
    return NextResponse.json({
      user: {
        id: u.id,
        name: u.name,
        displayName: u.displayName,
        email: u.email,
        role: u.role,
        level: u.level,
        settings: u.settings,
        createdAt: u.createdAt.toISOString(),
        subscriptionStatus: u.subscriptionStatus,
        trialEndsAt: u.trialEndsAt?.toISOString() ?? null,
        paymentSource: u.paymentSource,
        linkedStudents: u.parentLinks.map((l) => ({ ...l.student, settings: l.student.settings as Record<string, boolean> | null })),
        linkedParents: u.studentLinks.map((l) => l.parent),
      },
    });
  }

  // Listing every user is an admin-only operation — was previously
  // open to any caller (and was used by the now-removed /admin
  // routes anyway).
  const adminGuard = await requireAdmin();
  if (!adminGuard.ok) return NextResponse.json({ error: adminGuard.error }, { status: adminGuard.status });
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      parentLinks: { include: { student: { select: { id: true, name: true, displayName: true, level: true, settings: true } } } },
      studentLinks: { include: { parent: { select: { id: true, name: true, displayName: true } } } },
    },
  });

  return NextResponse.json({
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      displayName: u.displayName,
      email: u.email,
      role: u.role,
      level: u.level,
      settings: u.settings,
      createdAt: u.createdAt.toISOString(),
      linkedStudents: u.parentLinks.map((l) => ({ ...l.student, settings: l.student.settings as Record<string, boolean> | null })),
      linkedParents: u.studentLinks.map((l) => l.parent),
    })),
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  // eslint-disable-next-line prefer-const
  let { name, displayName, role, level, email, password, parentId, promoCode } = body as {
    name?: string; displayName?: string | null; role?: string; level?: number;
    email?: string; password?: string; parentId?: string; promoCode?: string;
  };

  if (!name || !role || !password) {
    return NextResponse.json(
      { error: "Name, role, and password are required" },
      { status: 400 }
    );
  }
  // displayName is optional; trim and reject obvious nonsense, but
  // allow null/empty to mean "fall back to the username".
  let displayNameClean: string | null = null;
  if (typeof displayName === "string" && displayName.trim().length > 0) {
    const trimmed = displayName.trim();
    if (trimmed.length < 2 || trimmed.length > 40) {
      return NextResponse.json({ error: "Full name must be 2–40 characters" }, { status: 400 });
    }
    displayNameClean = trimmed;
  }

  // Students: name must be unique
  if (role === "STUDENT") {
    const existing = await prisma.user.findFirst({
      where: { name: { equals: name, mode: "insensitive" }, role: "STUDENT" },
    });
    if (existing) {
      return NextResponse.json(
        { error: "This username is already taken" },
        { status: 409 }
      );
    }
  }

  // Parents: email required and must be unique
  if (role === "PARENT") {
    if (!email) {
      return NextResponse.json(
        { error: "Email is required for parent accounts" },
        { status: 400 }
      );
    }
    const existing = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
    });
    if (existing) {
      return NextResponse.json(
        { error: "This email is already registered" },
        { status: 409 }
      );
    }

    // Username auto-disambiguation. The signup form no longer asks
    // for a username — frontend derives it from the email local part
    // (e.g. "alice@gmail.com" → "alice"). Collisions are common
    // (multiple parents on gmail with first-name handles) so we
    // append _2, _3, … until we find a free slot. Parents can rename
    // themselves later in /account.
    let candidate = name;
    let suffix = 2;
    while (true) {
      const clash = await prisma.user.findFirst({
        where: { name: { equals: candidate, mode: "insensitive" } },
        select: { id: true },
      });
      if (!clash) break;
      candidate = `${name}_${suffix++}`;
      if (suffix > 99) break; // give up after 99 — extremely unlikely
    }
    name = candidate;
  }

  // ── Free-trial setup ───────────────────────────────────────────
  // Every signup gets DEFAULT_TRIAL_DAYS of full access. A valid
  // "trial_days" promo code extends this; "stripe_coupon" codes do
  // nothing here — they're forwarded at checkout instead. We still
  // record the redemption on the user record so admins can trace it.
  let trialDays = DEFAULT_TRIAL_DAYS;
  let redeemedPromo: { id: string; kind: string } | null = null;
  if (promoCode && typeof promoCode === "string" && promoCode.trim()) {
    const code = promoCode.trim().toUpperCase();
    const promo = await prisma.promoCode.findUnique({ where: { code } });
    if (promo && promo.active &&
        (!promo.expiresAt || promo.expiresAt > new Date()) &&
        (promo.maxRedemptions === null || promo.redeemedCount < promo.maxRedemptions)) {
      redeemedPromo = { id: promo.id, kind: promo.kind };
      if (promo.kind === "trial_days") {
        const extra = parseInt(promo.value, 10);
        if (Number.isFinite(extra) && extra > 0) trialDays += extra;
      }
    }
  }
  const trialEndsAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);

  const user = await prisma.user.create({
    data: {
      name,
      displayName: displayNameClean,
      role: role as "PARENT" | "STUDENT",
      password,
      email: role === "PARENT" ? (email ?? null) : null,
      // Default to P3 if caller omits level (lowest supported primary
      // level — content libraries don't cover P1/P2). Old default was
      // 1, which silently created P1 students that saw no questions.
      level: role === "STUDENT" ? (level ?? 3) : null,
      subscriptionStatus: "trialing",
      trialEndsAt,
      promoCodeId: redeemedPromo?.id ?? null,
    },
  });

  if (redeemedPromo) {
    await prisma.promoCode.update({
      where: { id: redeemedPromo.id },
      data: { redeemedCount: { increment: 1 } },
    }).catch(() => { /* non-fatal — best-effort counter */ });
  }

  // Auto-link student to parent if parentId provided
  if (role === "STUDENT" && parentId) {
    try {
      await prisma.parentStudent.create({
        data: { parentId, studentId: user.id },
      });
    } catch (err) {
      console.error("Failed to auto-link student to parent:", err);
    }

    // Day-0 welcome email — FIRST-TIME ONLY: fires when this student
    // is the parent's FIRST linked child. Adding a second child later
    // doesn't re-trigger. Skipped when the parent has no email on
    // record. Fire-and-forget so a SendGrid hiccup never blocks the
    // signup response.
    try {
      const linkCount = await prisma.parentStudent.count({ where: { parentId } });
      if (linkCount === 1) {
        const parent = await prisma.user.findUnique({
          where: { id: parentId },
          select: { id: true, email: true, name: true, displayName: true },
        });
        if (parent?.email) {
          // Avoid the late require — keep the import at module top once
          // the route file already imports a few server-only helpers.
          const { sendWelcomeEmail } = await import("@/lib/send-welcome-email");
          sendWelcomeEmail({
            parentEmail: parent.email,
            parentId: parent.id,
            parentDisplayName: parent.displayName ?? parent.name,
            childId: user.id,
            childDisplayName: user.displayName ?? user.name,
          }).catch(err => console.error("[welcome-email] async send failed:", err));
        }
      }
    } catch (err) {
      console.error("[welcome-email] trigger check failed:", err);
    }
  }

  // Previously: we cloned every paper owned by the first-created parent
  // (the admin "Papa") to each new parent account on signup. That was
  // redundant — /api/exam already lets non-admin parents see admin's
  // visible master papers directly, no copy needed. The clone also made
  // each new parent appear as the creator of papers they didn't upload,
  // dragged along focused tests and random 'Math practice' uploads the
  // admin had, and ignored the student's level entirely. Removed.

  // Auto-sign-in the newly-created user when there's no existing
  // session being preserved:
  //   - PARENT signup: log them in so the next page can call /api/*.
  //   - STUDENT self-signup (no parentId): same.
  // When a parent creates a STUDENT (parentId set), DON'T swap the
  // session — the parent must stay signed in to continue managing.
  // The 'Open Student Account' button on /register/student handles
  // the parent → student swap explicitly when the parent wants it.
  if (role === "PARENT" || (role === "STUDENT" && !parentId)) {
    try { await setSession(user.id); } catch { /* non-fatal */ }
  }

  return NextResponse.json(
    {
      id: user.id,
      name: user.name,
      displayName: user.displayName,
      email: user.email,
      role: user.role,
      level: user.level,
      createdAt: user.createdAt.toISOString(),
      subscriptionStatus: user.subscriptionStatus,
      trialEndsAt: user.trialEndsAt?.toISOString() ?? null,
      linkedStudents: [],
      linkedParents: [],
    },
    { status: 201 }
  );
}

// Keys inside `user.settings` JSON that NON-admin callers are
// forbidden from setting via this endpoint. Most critically:
// `admin: true` is the admin flag (see lib/admin.ts) — letting
// any caller write that to their own row was a privilege-escalation
// bug. Also block `role` so a STUDENT can't promote themselves.
const PRIVILEGED_SETTINGS_KEYS = new Set(["admin", "role"]);

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  // `name` is the immutable login username — set at signup, never
  // changes here. Renames write to `displayName`, which is mutable
  // and not unique.
  const { userId: bodyUserId, settings, displayName } = body as { userId?: string; settings?: Record<string, unknown>; displayName?: string | null };

  // Three legitimate edit relationships:
  //   - user edits their own profile / settings
  //   - admin view-as another user (uses bodyUserId to target them)
  //   - parent edits a LINKED student's profile / settings (this
  //     covers the dashboard's "Questions difficulty" slider —
  //     the parent passes their student's id as bodyUserId).
  // The parent case was the missing one and was silently 403ing
  // every difficulty change. Symptom: the slider on the dashboard
  // updated locally but reverted on re-login because the DB write
  // never ran.
  const session = await requireSession();
  if (!session.ok) return NextResponse.json({ error: session.error }, { status: session.status });

  const targetId = bodyUserId ?? session.userId;
  // Track whether the CALLER themselves is an admin — the
  // privileged-settings filter below must look at the caller, not
  // the edit target. Admin view-as gets full power; parent editing
  // a child stays as a non-admin so they can't set admin/role.
  const callerIsAdmin = session.isAdmin;
  let allowed = targetId === session.userId || callerIsAdmin;
  if (!allowed) {
    const link = await prisma.parentStudent.findUnique({
      where: { parentId_studentId: { parentId: session.userId, studentId: targetId } },
      select: { id: true },
    });
    allowed = !!link;
  }
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const userId = targetId;

  if (!settings && typeof displayName === "undefined") {
    return NextResponse.json({ error: "settings or displayName required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const data: import("@prisma/client").Prisma.UserUpdateInput = {};
  if (settings) {
    // Strip privileged keys from the incoming settings unless the
    // caller is already an admin. Without this filter, any logged-in
    // user could PATCH their own row with { settings: { admin: true } }
    // and self-promote — same risk applies if a parent could put
    // `admin: true` on their student's row, hence callerIsAdmin
    // (not target's role) gates the filter.
    const filteredIncoming: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(settings)) {
      if (PRIVILEGED_SETTINGS_KEYS.has(k) && !callerIsAdmin) {
        console.warn(`[users] non-admin caller=${session.userId} target=${userId} attempted to set privileged key "${k}" — ignored`);
        continue;
      }
      filteredIncoming[k] = v;
    }
    const merged = { ...((user.settings as Record<string, unknown>) ?? {}), ...filteredIncoming };
    data.settings = merged as import("@prisma/client").Prisma.InputJsonValue;
  }
  if (typeof displayName !== "undefined") {
    if (displayName === null || (typeof displayName === "string" && displayName.trim() === "")) {
      // Explicit null / empty string → clear, fall back to username.
      data.displayName = null;
    } else if (typeof displayName === "string") {
      const trimmed = displayName.trim();
      if (trimmed.length < 2 || trimmed.length > 40) {
        return NextResponse.json({ error: "Name must be 2–40 characters" }, { status: 400 });
      }
      data.displayName = trimmed;
    }
  }

  await prisma.user.update({ where: { id: userId }, data });
  return NextResponse.json({ success: true, ...data });
}
