import { cookies } from "next/headers";
import crypto from "crypto";
import { prisma } from "./db";
import { isAdmin } from "./admin";

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
  // Explicit deletion: set the cookie to an empty value with maxAge 0
  // and a past Expires date. cookies().delete() sometimes doesn't
  // emit the right Set-Cookie header for the browser to actually
  // clear the cookie, depending on Next.js version. Explicit set
  // is reliable.
  const c = await cookies();
  c.set(COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });
}

/**
 * Returns the verified user id from the signed session cookie, or null.
 * Use this for routes/pages that must trust the caller's identity (admin, payments, etc.)
 * — do NOT trust ?userId= query params for those.
 */
/** Returns true if the signed session belongs to an admin user. */
export async function isSessionAdmin(): Promise<boolean> {
  const id = await getSessionUserId();
  if (!id) return false;
  const user = await prisma.user.findUnique({ where: { id }, select: { name: true, settings: true } });
  return isAdmin(user);
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
