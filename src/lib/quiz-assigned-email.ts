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

// Full HTML doc with color-scheme locks so Gmail / Outlook / Apple
// Mail don't auto-invert the light-mode palette in dark mode. Without
// these, some Gmail Android + Outlook.com renderers flip the white
// background to dark AND leave inline dark text alone — producing
// black-on-black invisible text. The meta color-scheme + supported-
// color-schemes tags tell the client 'we've already designed for
// dark mode, don't apply forced dark styles.' The [data-ogsc] rules
// override Outlook's dark-mode class, and the @media block belt-and-
// braces the same intent for Apple Mail.
export const QUIZ_ASSIGNED_EMAIL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light">
  <title>{{subject}} Diagnostic</title>
  <style>
    :root { color-scheme: light only; supported-color-schemes: light; }
    body, table, td, p, a, strong { color: #1F2A37; }
    /* Gmail / Apple Mail forced-dark override. Pinning bg to white +
       text to the palette we picked; dark-mode clients respect
       !important. */
    @media (prefers-color-scheme: dark) {
      body, .light-body { background-color: #ffffff !important; color: #1F2A37 !important; }
      .light-card { background: linear-gradient(135deg, #faf5ff 0%, #f5f3ff 100%) !important; }
      .light-title { color: #001e40 !important; }
      .light-kicker { color: #7c3aed !important; }
      .light-secondary { color: #43474f !important; }
      .light-callout { background-color: #f8f9ff !important; color: #43474f !important; }
      .cta-btn { background-color: #001e40 !important; color: #ffffff !important; }
    }
    /* Outlook.com dark-mode selector. */
    [data-ogsc] body, [data-ogsc] .light-body { background-color: #ffffff !important; color: #1F2A37 !important; }
    [data-ogsc] .light-card { background: linear-gradient(135deg, #faf5ff 0%, #f5f3ff 100%) !important; }
    [data-ogsc] .light-title { color: #001e40 !important; }
    [data-ogsc] .light-kicker { color: #7c3aed !important; }
    [data-ogsc] .light-secondary { color: #43474f !important; }
    [data-ogsc] .light-callout { background-color: #f8f9ff !important; color: #43474f !important; }
    [data-ogsc] .cta-btn { background-color: #001e40 !important; color: #ffffff !important; }
  </style>
</head>
<body class="light-body" style="margin: 0; padding: 0; background-color: #ffffff; color: #1F2A37;">
<div class="light-body" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Calibri, sans-serif; color: #1F2A37; max-width: 560px; margin: 24px auto; padding: 0 16px; line-height: 1.55; font-size: 16px; background-color: #FFFFFF;">
  <p style="margin: 0 0 14px 0; color: #1F2A37;">Hi {{parentName}},</p>
  <p style="margin: 0 0 20px 0; color: #1F2A37;">The <strong style="color: #1F2A37;">{{subject}} diagnostic quiz</strong> for <strong style="color: #1F2A37;">{{childName}}</strong> is ready. It takes about <strong style="color: #1F2A37;">20 minutes</strong> and will let Lumi personalise the next practice.</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 22px 0; border-collapse: separate;">
    <tr>
      <td class="light-card" align="center" style="background: linear-gradient(135deg, #faf5ff 0%, #f5f3ff 100%); border: 1px solid #ddd6fe; border-radius: 16px; padding: 24px 20px;">
        <p class="light-kicker" style="margin: 0 0 6px 0; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #7c3aed;">Diagnostic ready</p>
        <p class="light-title" style="margin: 0 0 16px 0; font-family: Georgia, serif; font-size: 22px; font-weight: 700; color: #001e40; line-height: 1.25;">{{childName}}&rsquo;s {{subject}} diagnostic</p>
        <a class="cta-btn" href="{{childHomepageUrl}}" style="display: inline-block; padding: 14px 28px; background-color: #001e40; color: #ffffff; text-decoration: none; font-weight: 700; font-size: 16px; border-radius: 999px;">Start the quiz &rarr;</a>
        <p class="light-secondary" style="margin: 14px 0 0 0; font-size: 13px; color: #43474f;">{{signInSentence}}</p>
      </td>
    </tr>
  </table>

  <p class="light-secondary" style="margin: 0 0 14px 0; font-size: 14px; color: #43474f;">If the button doesn&rsquo;t work, copy this link into a browser:<br><a href="{{childHomepageUrl}}" style="color: #7c3aed; word-break: break-all;">{{childHomepageUrl}}</a></p>

  <p class="light-callout" style="margin: 16px 0; font-size: 13px; color: #43474f; padding: 10px 12px; background-color: #f8f9ff; border-left: 3px solid #001e40; border-radius: 4px;">
    <strong style="color: #001e40;">Want to check on {{childName}}&rsquo;s progress?</strong> Log in to <a href="{{parentHomepageUrl}}" style="color: #001e40; font-weight: 700;">your parent dashboard</a> — the button above is for {{childName}} to sign in as themselves. Your parent login and {{childName}}&rsquo;s login are separate.
  </p>

  <p style="margin: 18px 0 4px 0; color: #1F2A37;">See you inside.</p>
  <p style="margin: 0; font-weight: 600; color: #1F2A37;">Jessica</p>
  <p class="light-secondary" style="margin: 0; color: #6B7280; font-style: italic; font-size: 14px;">Co-Founder, MarkForYou</p>
</div>
</body>
</html>`;

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
