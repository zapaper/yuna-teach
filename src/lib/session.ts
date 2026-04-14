import { cookies } from "next/headers";
import crypto from "crypto";
import { prisma } from "./db";

const COOKIE_NAME = "yuna_session";
const SECRET = process.env.SESSION_SECRET ?? "dev-only-change-me-in-production";

function sign(value: string): string {
  return crypto.createHmac("sha256", SECRET).update(value).digest("hex");
}

export async function setSession(userId: string): Promise<void> {
  const sig = sign(userId);
  const value = `${userId}.${sig}`;
  const c = await cookies();
  c.set(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
}

export async function clearSession(): Promise<void> {
  const c = await cookies();
  c.delete(COOKIE_NAME);
}

/**
 * Returns the verified user id from the signed session cookie, or null.
 * Use this for routes/pages that must trust the caller's identity (admin, payments, etc.)
 * — do NOT trust ?userId= query params for those.
 */
/** Returns true if the signed session belongs to the admin user. */
export async function isSessionAdmin(): Promise<boolean> {
  const id = await getSessionUserId();
  if (!id) return false;
  const user = await prisma.user.findUnique({ where: { id }, select: { name: true } });
  return user?.name?.toLowerCase() === "admin";
}

export async function getSessionUserId(): Promise<string | null> {
  const c = await cookies();
  const cookie = c.get(COOKIE_NAME);
  if (!cookie?.value) return null;
  const [id, sig] = cookie.value.split(".");
  if (!id || !sig) return null;
  if (sign(id) !== sig) return null;
  return id;
}
