// Server-side sender for the quiz-assigned notification.
//
// Fire-and-forget from the onboarding "Assign and Email Link" flow.
// Failures are logged but never bubble up — the parent's onboarding
// flow completes regardless of whether SendGrid is healthy.

import sgMail from "@sendgrid/mail";
import { renderQuizAssignedEmail } from "./quiz-assigned-email";
import { tryOrQueue } from "./mail-queue";

const FROM_ADDRESS = process.env.SENDGRID_FROM_ADDRESS ?? "hello@markforyou.com";

export interface QuizAssignedEmailParams {
  parentEmail: string;
  parentDisplayName: string;
  childDisplayName: string;
  childUsername: string;
  subject: string;                    // 'English' | 'Math' | 'Science'
  childHomepageUrl: string;
  parentHomepageUrl: string;
}

export async function sendQuizAssignedEmail(p: QuizAssignedEmailParams): Promise<void> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    console.warn(`[quiz-assigned-email] SENDGRID_API_KEY not set — skipping send to ${p.parentEmail}`);
    return;
  }
  sgMail.setApiKey(apiKey);

  const rendered = renderQuizAssignedEmail({
    parentName: p.parentDisplayName,
    childName: p.childDisplayName,
    childUsername: p.childUsername,
    subject: p.subject,
    childHomepageUrl: p.childHomepageUrl,
    parentHomepageUrl: p.parentHomepageUrl,
  });

  const TEAM_ADDRESS = "jessica@markforyou.com";
  try {
    await tryOrQueue({
      eventType: "quiz_assigned",
      toEmail: p.parentEmail,
      toName: p.parentDisplayName,
      payload: {
        childDisplayName: p.childDisplayName,
        childUsername: p.childUsername,
        subject: p.subject,
        childHomepageUrl: p.childHomepageUrl,
      },
      send: async () => {
        const [resp] = await sgMail.send({
          to: p.parentEmail,
          bcc: TEAM_ADDRESS,
          from: { email: FROM_ADDRESS, name: "MarkForYou" },
          replyTo: TEAM_ADDRESS,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          trackingSettings: {
            clickTracking: { enable: false, enableText: false },
            openTracking: { enable: false },
            subscriptionTracking: { enable: false },
          },
        });
        console.log(
          `[quiz-assigned-email] sent to=${p.parentEmail} child=${p.childDisplayName} subject=${p.subject} status=${resp.statusCode} messageId=${resp.headers?.["x-message-id"] ?? "n/a"}`,
        );
      },
    });
  } catch (err) {
    console.warn(`[quiz-assigned-email] failed to=${p.parentEmail}:`, err);
  }
}
