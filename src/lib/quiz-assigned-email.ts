// "Your [subject] diagnostic for [child] is ready" email — sent
// when the parent picks "Assign and Email Link" in onboarding Step 3.
// Minimal by design: subject line + one-paragraph hi + a big CTA
// button styled like a modal card, wrapping the child's homepage
// login URL.

export interface QuizAssignedEmailSubstitutions {
  parentName: string;
  childName: string;
  childUsername: string;
  subject: string;              // 'English' | 'Math' | 'Science' (display case)
  childHomepageUrl: string;     // e.g. https://www.markforyou.com/home/<childId>
  parentHomepageUrl: string;    // e.g. https://www.markforyou.com/home/<parentId>
}

export const QUIZ_ASSIGNED_EMAIL_SUBJECT =
  "Your {{subject}} Diagnostic for {{childName}} is ready";

// When the child's display name and username are the same (parent
// didn't set a separate display name) we skip the "as {{username}}"
// clause so the sign-in sentence doesn't read
// 'Have studentsixseven sign in as studentsixseven...'.

// A single card-style CTA — reads as a modal panel in the email.
// Uses tables + inline styles so Gmail / Outlook render correctly.
export const QUIZ_ASSIGNED_EMAIL_HTML = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Calibri, sans-serif; color: #1F2A37; max-width: 560px; margin: 24px auto; padding: 0 16px; line-height: 1.55; font-size: 16px; background: #FFFFFF;">
  <p style="margin: 0 0 14px 0;">Hi {{parentName}},</p>
  <p style="margin: 0 0 20px 0;">The <strong>{{subject}} diagnostic quiz</strong> for <strong>{{childName}}</strong> is ready. It takes about <strong>20 minutes</strong> and will let Lumi personalise the next practice.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 22px 0; border-collapse: separate;">
    <tr>
      <td align="center" style="background: linear-gradient(135deg, #faf5ff 0%, #f5f3ff 100%); border: 1px solid #ddd6fe; border-radius: 16px; padding: 24px 20px;">
        <p style="margin: 0 0 6px 0; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #7c3aed;">Diagnostic ready</p>
        <p style="margin: 0 0 16px 0; font-family: Georgia, serif; font-size: 22px; font-weight: 700; color: #001e40; line-height: 1.25;">{{childName}}&rsquo;s {{subject}} diagnostic</p>
        <a href="{{childHomepageUrl}}" style="display: inline-block; padding: 14px 28px; background: #001e40; color: #ffffff; text-decoration: none; font-weight: 700; font-size: 16px; border-radius: 999px;">Start the quiz &rarr;</a>
        <p style="margin: 14px 0 0 0; font-size: 13px; color: #43474f;">{{signInSentence}}</p>
      </td>
    </tr>
  </table>

  <p style="margin: 0 0 14px 0; font-size: 14px; color: #43474f;">If the button doesn&rsquo;t work, copy this link into a browser:<br><a href="{{childHomepageUrl}}" style="color: #7c3aed; word-break: break-all;">{{childHomepageUrl}}</a></p>

  <p style="margin: 16px 0; font-size: 13px; color: #43474f; padding: 10px 12px; background: #f8f9ff; border-left: 3px solid #001e40; border-radius: 4px;">
    <strong>Want to check on {{childName}}&rsquo;s progress?</strong> Log in to <a href="{{parentHomepageUrl}}" style="color: #001e40; font-weight: 700;">your parent dashboard</a> — the button above is for {{childName}} to sign in as themselves. Your parent login and {{childName}}&rsquo;s login are separate.
  </p>

  <p style="margin: 18px 0 4px 0;">See you inside.</p>
  <p style="margin: 0; font-weight: 600;">Jessica</p>
  <p style="margin: 0; color: #6B7280; font-style: italic; font-size: 14px;">Co-Founder, MarkForYou</p>
</div>`;

export const QUIZ_ASSIGNED_EMAIL_TEXT = `Hi {{parentName}},

The {{subject}} diagnostic quiz for {{childName}} is ready. It takes about 20 minutes.

Start the quiz: {{childHomepageUrl}}

{{signInSentence}}

Want to check on {{childName}}'s progress? Log in to YOUR parent dashboard at {{parentHomepageUrl}} — the link above is for {{childName}} to sign in as themselves. Your parent login and {{childName}}'s login are separate.

See you inside.

Jessica
Co-Founder, MarkForYou`;

export function renderQuizAssignedEmail(subs: QuizAssignedEmailSubstitutions): {
  subject: string;
  html: string;
  text: string;
} {
  // If displayName == username, drop the "as <username>" clause so
  // we don't say "have studentsixseven sign in as studentsixseven".
  const sameName = subs.childName.trim().toLowerCase() === subs.childUsername.trim().toLowerCase();
  const signInSentence = sameName
    ? `Have <strong>${subs.childName}</strong> sign in with the password you gave and the quiz appears on their homepage.`
    : `Have <strong>${subs.childName}</strong> sign in as <strong>${subs.childUsername}</strong> with the password you gave and the quiz appears on their homepage.`;
  const signInSentenceText = sameName
    ? `Have ${subs.childName} sign in with the password you gave — the quiz appears on their homepage.`
    : `Have ${subs.childName} sign in as ${subs.childUsername} with the password you gave — the quiz appears on their homepage.`;
  const replace = (s: string, textVariant = false) =>
    s
      .replace(/\{\{\s*parentName\s*\}\}/g, subs.parentName)
      .replace(/\{\{\s*childName\s*\}\}/g, subs.childName)
      .replace(/\{\{\s*childUsername\s*\}\}/g, subs.childUsername)
      .replace(/\{\{\s*subject\s*\}\}/g, subs.subject)
      .replace(/\{\{\s*childHomepageUrl\s*\}\}/g, subs.childHomepageUrl)
      .replace(/\{\{\s*parentHomepageUrl\s*\}\}/g, subs.parentHomepageUrl)
      .replace(/\{\{\s*signInSentence\s*\}\}/g, textVariant ? signInSentenceText : signInSentence);
  return {
    subject: replace(QUIZ_ASSIGNED_EMAIL_SUBJECT),
    html: replace(QUIZ_ASSIGNED_EMAIL_HTML),
    text: replace(QUIZ_ASSIGNED_EMAIL_TEXT, true),
  };
}
