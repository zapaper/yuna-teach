// One-off test: send the Day-0 welcome email to a parent + their
// linked child. Manual run only — does NOT install the auto-send
// hook on signup. Use to QA rendering / delivery before wiring it up.
//
// Usage:
//   SENDGRID_API_KEY=... npx tsx scripts/send-test-welcome-email.ts
//
// Optional env:
//   PARENT_EMAIL  (defaults to peter.lzy@gmail.com)
//   CHILD_NAME    (defaults to "Mark Lim")
//   DRY_RUN=1     (renders + logs but doesn't actually send)

import { prisma } from "../src/lib/db";
import sgMail from "@sendgrid/mail";
import { promises as fs } from "fs";
import path from "path";
import { renderWelcomeEmail } from "../src/lib/welcome-email";

const PARENT_EMAIL = process.env.PARENT_EMAIL ?? "peter.lzy@gmail.com";
const CHILD_NAME = process.env.CHILD_NAME ?? "Mark Lim";
const FROM_ADDRESS = process.env.SENDGRID_FROM_ADDRESS ?? "hello@markforyou.com";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://www.markforyou.com";
const DRY_RUN = process.env.DRY_RUN === "1";

async function main() {
  const parent = await prisma.user.findFirst({
    where: { email: { equals: PARENT_EMAIL, mode: "insensitive" } },
    select: {
      id: true, email: true, name: true, displayName: true,
      parentLinks: {
        select: {
          student: {
            select: { id: true, name: true, displayName: true, email: true },
          },
        },
      },
    },
  });
  if (!parent) throw new Error(`No user found with email ${PARENT_EMAIL}`);
  if (!parent.email) throw new Error(`Parent ${parent.name} has no email on record`);

  const child = parent.parentLinks
    .map(l => l.student)
    .find(s => {
      const nameMatch = (n: string | null) =>
        n != null && n.toLowerCase().includes(CHILD_NAME.toLowerCase());
      return nameMatch(s.displayName) || nameMatch(s.name);
    });
  if (!child) {
    const linked = parent.parentLinks.map(l => l.student.displayName ?? l.student.name).join(", ");
    throw new Error(
      `No linked child matching "${CHILD_NAME}" for parent ${parent.email}. ` +
      `Linked students: ${linked || "(none)"}`,
    );
  }

  const parentName = parent.displayName ?? parent.name;
  const childName = child.displayName ?? child.name;
  const parentHomepageUrl = `${APP_URL}/home/${parent.id}`;
  const childHomepageUrl = `${APP_URL}/home/${child.id}`;

  const rendered = renderWelcomeEmail({
    parentName,
    childName,
    parentHomepageUrl,
    childHomepageUrl,
  });

  // We send the SAME rendered email (with the same parent/child
  // substitutions) to both recipients — parent gets it as the primary
  // audience, child gets a copy so we can eyeball how it looks in a
  // student inbox too. The child email skips the send entirely if
  // the child account has no email on record (common).
  const recipients: { label: string; to: string }[] = [
    { label: "parent", to: parent.email },
  ];
  if (child.email) recipients.push({ label: "child", to: child.email });

  console.log(`Welcome email QA test`);
  console.log(`  Parent: ${parentName} <${parent.email}> (id=${parent.id})`);
  console.log(`  Child:  ${childName} <${child.email ?? "(no email)"}> (id=${child.id})`);
  console.log(`  Subject: ${rendered.subject}`);
  console.log(`  From:    ${FROM_ADDRESS}`);
  console.log(`  Links:`);
  console.log(`    parentHomepageUrl = ${parentHomepageUrl}`);
  console.log(`    childHomepageUrl  = ${childHomepageUrl}`);
  console.log(`  Recipients: ${recipients.map(r => `${r.label}=${r.to}`).join(", ")}`);

  if (DRY_RUN) {
    console.log(`\nDRY_RUN=1 — skipping send. HTML body length=${rendered.html.length}, text body length=${rendered.text.length}`);
    return;
  }

  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) throw new Error("SENDGRID_API_KEY not set. Re-run with the key in env, or set DRY_RUN=1.");
  sgMail.setApiKey(apiKey);

  // Inline-attach the hero image via CID instead of relying on the
  // absolute https://markforyou.com/email-images/... URL. Real recipient
  // reports show that URL rendering as a broken-link icon (some Gmail
  // accounts proxy images and the proxy 404s the email-images path until
  // the marketing /robots /open-graph caches refresh). Embedding the
  // bytes guarantees the image renders without depending on the prod
  // asset server being reachable at read time.
  const heroImagePath = path.join(__dirname, "..", "public", "email-images", "day00-welcome.png");
  const heroBuffer = await fs.readFile(heroImagePath);
  const heroCid = "day00-welcome";
  const htmlInline = rendered.html.replace(
    /https:\/\/www\.markforyou\.com\/email-images\/day00-welcome\.png/g,
    `cid:${heroCid}`,
  );

  for (const r of recipients) {
    try {
      const [resp] = await sgMail.send({
        to: r.to,
        from: { email: FROM_ADDRESS, name: "MarkForYou" },
        subject: rendered.subject,
        html: htmlInline,
        text: rendered.text,
        // Raw object literal — the SDK passes attachment keys through
        // unchanged, so we MUST use `content_id` snake_case here. (The
        // class-based path would convert camelCase, but setAttachments
        // doesn't wrap object literals.) Without this, SendGrid rejects
        // with: "content_id parameter is required if disposition='inline'".
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        attachments: [{
          content: heroBuffer.toString("base64"),
          filename: "day00-welcome.png",
          type: "image/png",
          disposition: "inline",
          content_id: heroCid,
        } as any],
        trackingSettings: {
          clickTracking: { enable: false, enableText: false },
          openTracking: { enable: false },
          subscriptionTracking: { enable: false },
        },
      });
      console.log(`  → ${r.label} <${r.to}>  status=${resp.statusCode}  messageId=${resp.headers?.["x-message-id"] ?? "n/a"}`);
    } catch (err) {
      const e = err as { response?: { body?: unknown; statusCode?: number } } & Error;
      console.error(`  ✗ ${r.label} <${r.to}>  status=${e.response?.statusCode ?? "?"}  msg=${e.message}  body=${JSON.stringify(e.response?.body ?? null)}`);
    }
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
