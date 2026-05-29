// Server-side sender for the Day-0 welcome email.
//
// Fire-and-forget: callers should NOT await this in the signup-response
// critical path. Send failures are logged but do not bubble up — a
// missing welcome email must never block a successful registration.
//
// The hero image is read from public/email-images/day00-welcome.png and
// embedded inline via SendGrid CID so the email renders without
// depending on the prod asset URL (which was flaking in Gmail's image
// proxy during QA).
//
// Idempotency / "first time" is the CALLER's responsibility — see the
// invocation in src/app/api/users/route.ts where we check that this is
// the parent's first linked child.

import sgMail from "@sendgrid/mail";
import { promises as fs } from "fs";
import path from "path";
import { renderWelcomeEmail } from "./welcome-email";

const FROM_ADDRESS = process.env.SENDGRID_FROM_ADDRESS ?? "hello@markforyou.com";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://www.markforyou.com";
const HERO_CID = "day00-welcome";

// Cached hero PNG bytes — read once on first send. Reads from disk
// rather than bundling so an admin can swap the asset without a code
// deploy (drop a new PNG into public/email-images/).
let heroCache: Buffer | null = null;
async function loadHero(): Promise<Buffer | null> {
  if (heroCache) return heroCache;
  // Try a couple of candidate paths so this works in both Next.js dev
  // (cwd = repo root) and standalone production (cwd = .next/standalone).
  const candidates = [
    path.join(process.cwd(), "public", "email-images", "day00-welcome.png"),
    path.join(process.cwd(), ".next", "standalone", "public", "email-images", "day00-welcome.png"),
  ];
  for (const p of candidates) {
    try {
      const buf = await fs.readFile(p);
      heroCache = buf;
      return buf;
    } catch { /* try next */ }
  }
  return null;
}

export interface WelcomeEmailParams {
  parentEmail: string;
  parentId: string;
  parentDisplayName: string;
  childId: string;
  childDisplayName: string;
}

export async function sendWelcomeEmail(p: WelcomeEmailParams): Promise<void> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    console.warn(`[welcome-email] SENDGRID_API_KEY not set — skipping welcome to ${p.parentEmail}`);
    return;
  }
  sgMail.setApiKey(apiKey);

  const parentHomepageUrl = `${APP_URL}/home/${p.parentId}`;
  const childHomepageUrl = `${APP_URL}/home/${p.childId}`;
  const rendered = renderWelcomeEmail({
    parentName: p.parentDisplayName,
    childName: p.childDisplayName,
    parentHomepageUrl,
    childHomepageUrl,
  });

  // Swap the absolute URL for a CID reference so the attached PNG
  // renders instead of the (sometimes-flaky) hosted URL.
  const heroBuffer = await loadHero();
  let html = rendered.html;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attachments: any[] = [];
  if (heroBuffer) {
    html = html.replace(
      /https:\/\/www\.markforyou\.com\/email-images\/day00-welcome\.png/g,
      `cid:${HERO_CID}`,
    );
    attachments.push({
      content: heroBuffer.toString("base64"),
      filename: "day00-welcome.png",
      type: "image/png",
      disposition: "inline",
      content_id: HERO_CID,
    });
  } else {
    console.warn(`[welcome-email] hero PNG not found on disk — email will fall back to the hosted URL`);
  }

  try {
    const [resp] = await sgMail.send({
      to: p.parentEmail,
      from: { email: FROM_ADDRESS, name: "MarkForYou" },
      subject: rendered.subject,
      html,
      text: rendered.text,
      attachments,
      trackingSettings: {
        clickTracking: { enable: false, enableText: false },
        openTracking: { enable: false },
        subscriptionTracking: { enable: false },
      },
    });
    console.log(
      `[welcome-email] sent to=${p.parentEmail} parentId=${p.parentId} childId=${p.childId} status=${resp.statusCode} messageId=${resp.headers?.["x-message-id"] ?? "n/a"}`,
    );
  } catch (err) {
    const e = err as { response?: { body?: unknown; statusCode?: number } } & Error;
    console.error(
      `[welcome-email] send failed to=${p.parentEmail} status=${e.response?.statusCode ?? "?"} msg=${e.message} body=${JSON.stringify(e.response?.body ?? null)}`,
    );
  }
}
