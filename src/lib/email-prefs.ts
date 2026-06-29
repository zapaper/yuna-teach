// Email-preferences helpers. Three categories of outbound email a
// parent can opt in/out of:
//
//   - marketing — nurture/onboarding emails (Day-3 activation nudge,
//                 Day-6 follow-up, etc.) sent by the markforyou-mailer.
//   - progress  — child progress updates (subject_3_quizzes_done,
//                 Lumi intro, weekly Lumi delta). Sent by yuna-teach.
//   - features  — product announcements / what's-new emails. Not
//                 yet sending — the category exists so the unsubscribe
//                 page can offer it from day one.
//
// All three default to TRUE (subscribed). A parent has to actively
// flip them off via the /unsubscribe page. Welcome + transactional
// confirmations are NOT in this gate — they are part of the service
// and CAN-SPAM/PDPA allow them regardless of opt-out.
//
// Storage shape (on User.settings JSON):
//   emailPrefs: { marketing: boolean, progress: boolean, features: boolean }
//
// Unsubscribe links use a signed token, not the raw email or userId,
// so leaking the URL only exposes ONE user. Signature is the same
// HMAC-SHA256 scheme used by the session cookie (see lib/session.ts)
// but with a distinct purpose-prefix so a session token can't be
// mistaken for an unsubscribe token and vice-versa.

import crypto from "crypto";
import { prisma } from "./db";

export type EmailCategory = "marketing" | "progress" | "features";

export type EmailPrefs = {
  marketing: boolean;
  progress: boolean;
  features: boolean;
};

const DEFAULT_PREFS: EmailPrefs = {
  marketing: true,
  progress: true,
  features: true,
};

const SECRET = process.env.SESSION_SECRET ?? "dev-only-change-me-in-production";
const TOKEN_PURPOSE = "unsubscribe-v1";

function sign(payload: string): string {
  return crypto
    .createHmac("sha256", SECRET)
    .update(`${TOKEN_PURPOSE}:${payload}`)
    .digest("hex");
}

/** Build the signed unsubscribe token for a user. Stable forever for
 *  the same userId — links in old emails keep working. */
export function makeUnsubscribeToken(userId: string): string {
  return `${userId}.${sign(userId)}`;
}

/** Verify a signed unsubscribe token and return the userId on success.
 *  Returns null on any malformed / unsigned / wrong-signature input. */
export function verifyUnsubscribeToken(token: string | null | undefined): string | null {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const userId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!userId || !sig) return null;
  // Constant-time comparison to defeat timing-based signature probes.
  const expected = sign(userId);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return null;
  return userId;
}

function readPrefs(raw: unknown): EmailPrefs {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFS };
  const obj = raw as Record<string, unknown>;
  return {
    marketing: obj.marketing === false ? false : true,
    progress:  obj.progress  === false ? false : true,
    features:  obj.features  === false ? false : true,
  };
}

/** Read the current preferences for a user. Returns defaults
 *  (all-subscribed) when the user has no emailPrefs entry yet. */
export async function getEmailPrefs(userId: string): Promise<EmailPrefs> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { settings: true },
  });
  if (!user) return { ...DEFAULT_PREFS };
  const settings = (user.settings as Record<string, unknown> | null) ?? {};
  return readPrefs(settings.emailPrefs);
}

/** Persist new preferences. Merges with existing settings so other
 *  per-user flags (progressReportsSent, etc.) are not clobbered. */
export async function setEmailPrefs(userId: string, prefs: EmailPrefs): Promise<EmailPrefs> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { settings: true },
  });
  if (!user) throw new Error("user not found");
  const settings = ((user.settings as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
  settings.emailPrefs = prefs;
  await prisma.user.update({
    where: { id: userId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { settings: settings as any },
  });
  return prefs;
}

/** Single-line check for senders: "is this user OK to receive this
 *  category of email right now?" Returns true if the pref is on (or
 *  the user has no explicit prefs yet — default subscribed). */
export async function canSendEmail(
  userId: string,
  category: EmailCategory,
): Promise<boolean> {
  const prefs = await getEmailPrefs(userId);
  return prefs[category] === true;
}

/** Render the unsubscribe footer for an email. The category lets us
 *  word the footer truthfully — "You're getting this because you've
 *  opted into progress updates" reads differently from a marketing
 *  footer. Returns a tiny HTML block that drops in at the bottom of
 *  any email template. */
export function renderUnsubscribeFooter(
  userId: string,
  category: EmailCategory,
  baseUrl: string,
): string {
  const token = makeUnsubscribeToken(userId);
  const url = `${baseUrl.replace(/\/$/, "")}/unsubscribe?token=${token}`;
  const reason =
    category === "marketing" ? "tips, nudges, and onboarding from MarkForYou"
    : category === "progress" ? "progress updates and weekly coaching for your child"
    : "product news from MarkForYou";
  return `<p style="font-size:11px;color:#9ca3af;text-align:center;margin-top:32px;line-height:1.6">
    You&rsquo;re receiving this email because you signed up to receive ${reason}.
    <br>
    <a href="${url}" style="color:#9ca3af;text-decoration:underline">Manage email preferences or unsubscribe</a>
  </p>`;
}

export { DEFAULT_PREFS };
