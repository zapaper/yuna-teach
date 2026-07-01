/**
 * Day 0 welcome email — sent immediately on user signup.
 *
 * Self-contained: copy the rendered output into your SendGrid call and you're
 * done. The HTML carries an embedded <style> block so the formatting carries
 * through in Gmail / Outlook without the recipient needing your site stylesheet.
 *
 * Image is served from /public/email-images/day00-welcome.png at
 * https://www.markforyou.com/email-images/day00-welcome.png so it survives any
 * redeploy / volume reset.
 *
 * Other onboarding emails (Day 3, 7, 11, ...) live in the markforyou-mailer
 * Flask app and are cron-sent from there — see webapp/onboarding_emails/.
 */

export interface WelcomeEmailSubstitutions {
  parentName: string;
  childName: string;
  parentHomepageUrl: string;
  childHomepageUrl: string;
}

export const WELCOME_EMAIL_SUBJECT = 'Welcome to MarkForYou!';

export const WELCOME_EMAIL_HTML = `<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, sans-serif;
       color: #1F2A37; max-width: 640px; margin: 24px auto; padding: 0 16px;
       line-height: 1.55; font-size: 16px; background: #FFFFFF; }
p { margin: 0 0 14px 0; }
strong { font-weight: 700; color: #0E1F2A; }
em { color: #4B5563; }
img { max-width: 100%; height: auto; display: block; margin: 12px auto;
      border-radius: 6px; }
.caption { text-align: center; color: #6B7280; font-size: 13px;
           font-style: italic; margin: -6px auto 18px auto; }
.cta { background: #F0F8F7; border-left: 4px solid #0E6B6B; padding: 12px 16px;
       border-radius: 4px; font-size: 18px; font-weight: 600; margin: 16px 0; }
.cta strong { color: #0E6B6B; }
blockquote { margin: 14px 0; padding: 10px 16px; background: #FAF7F0;
             border-left: 3px solid #C9C5BC; color: #1F2A37; font-style: italic; }
.todo { background: #FFF4EC; border: 2px dashed #D96B1F; padding: 12px 16px;
        border-radius: 6px; color: #D96B1F; margin: 16px 0; font-size: 18px; }
.todo b { font-weight: 700; }
.signoff { margin: 18px 0 4px 0; }
.signoff-name { font-weight: 600; margin: 0; }
.signoff-role { color: #6B7280; font-style: italic; font-size: 14px; margin: 0; }
.ps { margin-top: 18px; padding-top: 14px; border-top: 1px solid #E5E7EB;
      font-size: 14px; color: #374151; }
.ps b { font-weight: 700; }
</style>
<p>Hi {{parentName}},</p>
<p>Thank you for registering, and welcome onboard MarkForYou! We are excited to have you and {{childName}} with us, and trust that you will find the platform useful.</p>
<div class="todo" style="background:#FFF4EC;border:2px dashed #D96B1F;padding:12px 16px;border-radius:6px;color:#D96B1F;margin:16px 0;font-size:18px;">📌 <b style="font-weight:700;">Save this email for quick access:</b> <a href="{{parentHomepageUrl}}" style="color:#D96B1F;font-weight:600;">Your parent dashboard</a> and <a href="{{childHomepageUrl}}" style="color:#D96B1F;font-weight:600;">{{childName}}'s homepage</a>. From <b>your parent dashboard</b> you assign daily quizzes and focused practice to {{childName}}; they appear on {{childName}}'s homepage for {{childName}} to complete. Remember, each of you should log in via your respective accounts, to maximise the benefit.</div>
<p><b><i>MarkForYou was built to make parents' lives easier</i></b>. The platform:</p>
<p style="margin: 0 0 6px 24px;">(i) <u>Marks your child's online and offline quizzes instantly</u>, saving you from 10pm marking;</p>
<p style="margin: 0 0 6px 24px;">(ii) <u>Pinpoints your child's weak areas</u>, saving you from manually studying each wrong question;</p>
<p style="margin: 0 0 14px 24px;">(iii) <u>Compiles their mistakes</u>, accessible with one click, saving you from tearing out each mistake and compiling them.</p>
<p>Bye bye, mindless midnight marking, and hello, quality time!</p>
<p><br></p>
<p><u style="color: rgb(14, 31, 42); font-weight: 700;">Getting Started</u></p>
<p>Over the next 30 days, you'll have <strong>full access to everything</strong> — paper marking, focused practice, spelling, the parent dashboard, weekly auto-revision. We encourage you to make full use of it.</p>
<p><b>To start, log in to <a href="{{parentHomepageUrl}}" style="color:#0E6B6B;font-weight:700;">your parent dashboard</a> and set one short activity for {{childName}} today or tomorrow</b>. We have mapped out a step-by-step guide below — both paths are assigned by <b>you (the parent)</b> from your dashboard, and both feed into the system's analysis of {{childName}}'s weak areas.</p>
<p><img src="https://www.markforyou.com/email-images/day00-welcome.png" style="max-width: 100%; height: auto; display: block; margin: 12px auto; border-radius: 6px;" alt="MarkForYou homepage — Daily Quiz and Focused Practice entry points"></p>
<p><strong>Path A — Don't know where to start?</strong></p>
<p>From your parent dashboard, assign a <strong>Daily Quiz</strong> in any subject (Math, Science, or English). This creates a 10-15 minute set of MCQ or open-ended questions on {{childName}}'s homepage. The quiz will get marked instantly, and the system will start tracking the topics that {{childName}} is strong in, as well as the areas that need more work.</p>
<p><strong>Path B — Already know a weak area?</strong></p>
<p>From your parent dashboard, go straight to <strong>Focused Practice</strong> and pick the topic {{childName}} struggles with, e.g., Heat transfer, or Synthesis, or Fractions word problems. You can set a 10-15 question drill and it lands on {{childName}}'s homepage.</p>
<p><br></p>
<p><i>Either way, the loop is the same after this: {{childName}} does the work → our marker scores against MOE scoring rubrics → the weakness picture updates → we recommend what to drill next.</i></p>
<p>The links to your respective homepages are in the orange box at the top of this email. Remember to log in to your respective accounts!</p>
<p>Looking forward to seeing how {{childName}} gets on. Feel free to reach out if you have any questions.</p>
<p>Thank you.</p>
<p class="signoff" style="margin:18px 0 4px 0;">Warmly,</p>
<p class="signoff-name" style="font-weight:600;margin:0;">Jessica</p>
<p class="signoff-role" style="color:#6B7280;font-style:italic;font-size:14px;margin:0;">Co-Founder, MarkForYou</p>`;

export const WELCOME_EMAIL_TEXT = `Hi {{parentName}},

Thank you for registering, and welcome onboard MarkForYou! We are excited to have you and {{childName}} with us, and trust that you will find the platform useful.

📌 Save this email for quick access:
  - Your parent dashboard: {{parentHomepageUrl}}
  - {{childName}}'s homepage: {{childHomepageUrl}}
From YOUR parent dashboard you assign daily quizzes and focused practice to {{childName}}; they appear on {{childName}}'s homepage for {{childName}} to complete. Remember, each of you should log in via your respective accounts to maximise the benefit.

MarkForYou was built to make parents' lives easier. The platform:
  (i) Marks your child's online and offline quizzes instantly, saving you from 10pm marking;
  (ii) Pinpoints your child's weak areas, saving you from manually studying each wrong question;
  (iii) Compiles their mistakes, accessible with one click, saving you from tearing out each mistake and compiling them.

Bye bye, mindless midnight marking, and hello, quality time!

Getting Started

Over the next 30 days, you'll have full access to everything — paper marking, focused practice, spelling, the parent dashboard, weekly auto-revision. We encourage you to make full use of it.

To start, log in to your parent dashboard ({{parentHomepageUrl}}) and set one short activity for {{childName}} today or tomorrow. Both paths below are assigned by YOU (the parent) from your dashboard, and both feed into the system's analysis of {{childName}}'s weak areas.

Path A — Don't know where to start?

From your parent dashboard, assign a Daily Quiz in any subject (Math, Science, or English). This creates a 10-15 minute set of MCQ or open-ended questions on {{childName}}'s homepage. The quiz will get marked instantly, and the system will start tracking the topics that {{childName}} is strong in, as well as the areas that need more work.

Path B — Already know a weak area?

From your parent dashboard, go straight to Focused Practice and pick the topic {{childName}} struggles with, e.g., Heat transfer, or Synthesis, or Fractions word problems. You can set a 10-15 question drill and it lands on {{childName}}'s homepage.

Either way, the loop is the same after this: {{childName}} does the work → our marker scores against MOE scoring rubrics → the weakness picture updates → we recommend what to drill next.

The links to your respective homepages are in the orange box at the top of this email. Remember to log in to your respective accounts!

Looking forward to seeing how {{childName}} gets on. Feel free to reach out if you have any questions.

Thank you.

Warmly,
Jessica
Co-Founder, MarkForYou`;

export function renderWelcomeEmail(subs: WelcomeEmailSubstitutions): {
  subject: string;
  html: string;
  text: string;
} {
  const replace = (s: string) =>
    s
      .replace(/\{\{\s*parentName\s*\}\}/g, subs.parentName)
      .replace(/\{\{\s*childName\s*\}\}/g, subs.childName)
      .replace(/\{\{\s*parentHomepageUrl\s*\}\}/g, subs.parentHomepageUrl)
      .replace(/\{\{\s*childHomepageUrl\s*\}\}/g, subs.childHomepageUrl);
  return {
    subject: replace(WELCOME_EMAIL_SUBJECT),
    html: replace(WELCOME_EMAIL_HTML),
    text: replace(WELCOME_EMAIL_TEXT),
  };
}
