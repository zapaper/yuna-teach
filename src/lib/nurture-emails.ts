/* eslint-disable */
/**
 * MarkForYou nurture / onboarding emails.
 *
 * Generated from webapp/onboarding_emails/ in the markforyou-mailer repo.
 * To regenerate: cd webapp/onboarding_emails && python generate_nurture_ts.py
 *
 * Placeholders use {{camelCase}} so renderNurtureEmail() can substitute them.
 * Trigger metadata describes when each email should fire — Email 01 is
 * event-driven on user signup; the rest are cron-keyed off signup age (or
 * post-upgrade age for Email 10).
 */

export type SendTrigger =
  | { kind: 'signup' }
  | { kind: 'signup_age'; days: number }
  | { kind: 'post_upgrade'; days: number };

export type Variant = 'a' | 'b' | undefined;

export interface NurtureEmail {
  id: string;
  emailNumber: number;
  title: string;
  variant?: Variant;
  trigger: SendTrigger;
  subject: string;
  htmlBody: string;
  textBody: string;
}

export interface NurtureSubstitutions {
  parentName: string;
  childName: string;
  childHomepageUrl: string;
  parentHomepageUrl?: string;
  pricingUrl?: string;
  priceText?: string;
}

export function renderNurtureEmail(
  email: NurtureEmail,
  subs: NurtureSubstitutions,
): { subject: string; html: string; text: string } {
  const map: Record<string, string> = {
    parentName: subs.parentName,
    childName: subs.childName,
    childHomepageUrl: subs.childHomepageUrl,
    parentHomepageUrl: subs.parentHomepageUrl ?? '',
    pricingUrl: subs.pricingUrl ?? '',
    priceText: subs.priceText ?? '',
  };
  const replace = (s: string) =>
    s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) =>
      Object.prototype.hasOwnProperty.call(map, key) ? map[key] : `{{${key}}}`,
    );
  return {
    subject: replace(email.subject),
    html: replace(email.htmlBody),
    text: replace(email.textBody),
  };
}

export const NURTURE_EMAILS: NurtureEmail[] = [
  {
    id: "onboarding-day00",
    emailNumber: 1,
    title: "Email 1 \u00b7 Day 0 \u00b7 Welcome to MarkForYou!",
    variant: undefined,
    trigger: { kind: 'signup' },
    subject: "Welcome to MarkForYou!",
    htmlBody: `<style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, sans-serif;
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
.ps b { font-weight: 700; }</style>
<p>Hi {{parentName}},</p>
<p>Thank you for registering, and welcome onboard MarkForYou! We are excited to have you and {{childName}} with us, and trust that you will find the platform useful.</p>
<div class="todo">📌 <b>Save this email for quick access:</b> <a href="{{parentHomepageUrl}}" style="color:#D96B1F;font-weight:600;">Your parent dashboard</a> and <a href="{{childHomepageUrl}}" style="color:#D96B1F;font-weight:600;">{{childName}}'s homepage</a>. Remember, each of you should log in via your respective accounts, to maximise the benefit.</div>
<p><b><i>MarkForYou was built to make parents' lives easier</i></b>. The platform:</p>
<p style="margin: 0 0 6px 24px;">(i) <u>Marks your child's online and offline quizzes instantly</u>, saving you from 10pm marking;</p>
<p style="margin: 0 0 6px 24px;">(ii) <u>Pinpoints your child's weak areas</u>, saving you from manually studying each wrong question;</p>
<p style="margin: 0 0 14px 24px;">(iii) <u>Compiles their mistakes</u>, accessible with one click, saving you from tearing out each mistake and compiling them.</p>
<p>Bye bye, mindless midnight marking, and hello, quality time!</p>
<p><br></p>
<p><u style="color: rgb(14, 31, 42); font-weight: 700;">Getting Started</u></p>
<p>Over the next 30 days, you'll have <strong>full access to everything</strong> — paper marking, focused practice, spelling, the parent dashboard, weekly auto-revision. We encourage you to make full use of it.</p>
<p><b>To start, we suggest you set one short activity for {{childName}} today or tomorrow</b>. We have mapped out a step-by-step guide below. Both paths feed into the system's analysis of your child's weak areas.</p>
<p><img src="https://www.markforyou.com/email-images/day00-welcome.png" alt="MarkForYou homepage — Daily Quiz and Focused Practice entry points" style="max-width: 100%; height: auto; display: block; margin: 12px auto; border-radius: 6px;"></p>
<p><strong>Path A — Don't know where to start?</strong></p>
<p>Pick a <strong>Daily Quiz</strong> in any subject (Math, Science, or English). This creates a 10-15 minute set of MCQ or open-ended questions for {{childName}}. The quiz will get marked instantly, and the system will start tracking the topics that {{childName}} is strong in, as well as the areas that need more work.</p>
<p><strong>Path B — Already know a weak area?</strong></p>
<p>Go straight to <strong>Focused Practice</strong>, and pick the topic {{childName}} struggles with, e.g., Heat transfer, or Synthesis, or Fractions word problems. You can set a 10-15 question drill on this topic.</p>
<p><br></p>
<p><i>Either way, the loop is the same after this: {{childName}} does the work → our marker scores against MOE scoring rubrics → the weakness picture updates → we recommend what to drill next.</i></p>
<p class="cta"><a href="{{parentHomepageUrl}}" style="color: #0E6B6B; text-decoration: none;"><strong>Set a quiz or focused practice for {{childName}}</strong></a></p>
<p>The links to your respective homepages are in the orange box at the top of this email. Remember to log in to your respective accounts!</p>
<p>Looking forward to seeing how {{childName}} gets on. Feel free to reach out if you have any questions.</p>
<p>Thank you.</p>
<p class="signoff">Warmly,</p>
<p class="signoff-name">Jessica</p>
<p class="signoff-role">Co-Founder, MarkForYou</p>`,
    textBody: `Hi {{parentName}},

Welcome aboard. We're glad you're trying MarkForYou with {{childName}}.

Quick context: parents tell us they sign up for two reasons — they're tired of marking papers at 10pm, and they're not sure where their child is actually losing marks. We built MarkForYou to fix both. Over the next 30 days you'll have full access to everything — paper marking, focused practice, Master Classes, the parent dashboard, weekly auto-revision.

The fastest way to get value in week 1 is to set {{childName}} one short activity tonight. Either path below works — they both feed into the same weakness picture, which is what powers every recommendation the system makes from here on.

[SCREENSHOT TO PASTE: Screenshot: the homepage for {{childName}} showing the two entry points side by side — Daily Quiz button (any subject) and Focused Practice button (pick a topic). Helps make Path A vs Path B concrete.]

Path A — Don't know where to start?

Pick a Daily Quiz in any subject (Math, Science, or English). It's a 10–15 minute set of MCQ + open-ended questions levelled to {{childName}}. The marker scores it within 5 minutes, and the system starts mapping which sub-topics {{childName}} is strong on and which need work. After 2–3 quizzes across a couple of subjects, the weakness picture is real enough to act on.

Path B — Already know a weak area?

Go straight to Focused Practice. Pick the sub-topic you already know {{childName}} struggles with — say, Heat transfer, or Synthesis with "Unless," or fractions word problems — and set a 10-question drill on just that. Same 10–15 minutes, but every question is on the one thing that matters most. The system uses that data point as its starting line and builds outward from there.

Either way, the loop is the same after this: {{childName}} does the work → our marker scores per-subpart → the weakness picture updates → we recommend what to drill next.

👉 Set {{childName}}'s first quiz or focused practice tonight → {{childHomepageUrl}}

It takes 10–15 minutes for {{childName}}. We mark within 5 minutes of submission. You'll get a notification when the result is ready, with the per-question feedback already laid out for you to review.

Looking forward to seeing how {{childName}} gets on.

Warmly,
Jessica
Co-Founder, MarkForYou

P.S. Your 30-day free trial runs from today. Full access to everything — no card needed. We'll be in touch every few days with what to look at next.`,
  },
  {
    id: "onboarding-day03-a",
    emailNumber: 2,
    title: "Email 2A \u00b7 Day 3 \u00b7 Half of every PSLE Science paper is 5 topics. Here's where to point {{childName}} next.",
    variant: 'a',
    trigger: { kind: 'signup_age', days: 3 },
    subject: "Half of every PSLE Science paper is 5 topics. Here's where to point {{childName}} next.",
    htmlBody: `<style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, sans-serif;
       color: #1F2A37; max-width: 640px; margin: 24px auto; padding: 0 16px;
       line-height: 1.55; font-size: 16px; background: #FFFFFF; }
p { margin: 0 0 14px 0; }
strong { font-weight: 700; color: #0E1F2A; }
em { color: #4B5563; }
img { max-width: 100%; height: auto; display: block; margin: 12px auto;
      border-radius: 6px; }
ul { margin: 0 0 14px 24px; padding: 0; }
ul li { margin: 0 0 6px 0; }
.cta { background: #F0F8F7; border-left: 4px solid #0E6B6B; padding: 12px 16px;
       border-radius: 4px; font-size: 18px; font-weight: 600; margin: 16px 0; }
.cta strong { color: #0E6B6B; }
.signoff { margin: 18px 0 4px 0; }
.signoff-name { font-weight: 600; margin: 0; }
.signoff-role { color: #6B7280; font-style: italic; font-size: 14px; margin: 0; }</style>
<p>Hi {{parentName}},</p>
<p>It's been a few days since you joined MarkForYou. How's it going so far? We trust both you and {{childName}} are getting the hang of the platform. If you have any questions or issues, please feel free to reach out to me via this email address.</p>
<p>We notice that {{childName}} has done their first quiz or focused practice with us. Welcome to the loop — the system has officially started building {{childName}}'s personal weakness picture from that signal.</p>
<p>To maximise {{childName}}'s time on the platform, we thought to provide some information on the topic breakdown for PSLE. After all, we're not here just to study <strong>HARD</strong>, we want to study <strong>SMART</strong>.</p>
<p>We broke down every PSLE Science question over the last decade (2016-2025). These are the top 5 topics by share of marks:</p>
<p><img src="https://www.markforyou.com/email-images/day03-psle-science-top5.png" alt="Top 5 PSLE Science topics by share of marks (2016-2025)" style="max-width:100%; height:auto; display:block; margin:12px auto; border-radius:6px;"></p>
<p>These five topics make up <strong>half of every PSLE Science paper</strong>. A few key insights:</p>
<ul>
  <li>These topics are dominated by open-ended questions (OEQ); <strong>keywords are important</strong>.</li>
  <li>"Interactions within the environment" is often one of the last topics taught before PSLE, yet carries one of the heaviest marks.</li>
  <li>Lastly, OEQ also means that <strong>handwriting is important!</strong></li>
</ul>
<p>Another insight: "Interactions" and "Heat" are dominated by OEQs — and students often bleed half-marks for imprecise language here.</p>
<p>Knowing the breakdown of topics is the easy part. <strong>Knowing how {{childName}}'s written answers score against the MOE scoring rubrics is what closes the gap.</strong> This is why we created the Focused Practice function.</p>
<p>From {{childName}}'s homepage, set a 10-question drill on any one of these highly-tested topics. Our marker scores per-subpart against the same examiner rubric used at PSLE. We don't give vague feedback. We give concrete, actionable feedback that highlights missing scientific keywords and concepts.</p>
<p>What next? Let's get {{childName}} started on Focused Practice.</p>
<p class="cta" style="background:#F0F8F7;border-left:4px solid #0E6B6B;padding:12px 16px;border-radius:4px;font-size:18px;font-weight:600;margin:16px 0;">👉 <a href="{{childHomepageUrl}}" style="color:#0E6B6B;text-decoration:none;"><strong style="color:#0E6B6B;">Set a topical Focused Practice via {{childName}}'s homepage</strong></a> → Focused Practice → choose topic.</p>
<p>Have a productive week,</p>
<p class="signoff-name" style="font-weight:600;margin:0;">Jessica</p>
<p class="signoff-role" style="color:#6B7280;font-style:italic;font-size:14px;margin:0;">Co-Founder, MarkForYou</p>`,
    textBody: `Hi {{parentName}},

It's been a few days since you joined MarkForYou. How's it going so far? We trust both you and {{childName}} are getting the hang of the platform. If you have any questions or issues, please feel free to reach out to me via this email address.

We notice that {{childName}} has done their first quiz or focused practice with us. Welcome to the loop — the system has officially started building {{childName}}'s personal weakness picture from that signal.

To maximise {{childName}}'s time on the platform, we thought to provide some information on the topic breakdown for PSLE. After all, we're not here just to study HARD, we want to study SMART.

We broke down every PSLE Science question over the last decade (2016-2025). These are the top 5 topics by share of marks:

[chart: Top 5 PSLE Science topics by share of marks (2016-2025) — see https://www.markforyou.com/email-images/day03-psle-science-top5.png]

These five topics make up half of every PSLE Science paper. A few key insights:

  - These topics are dominated by open-ended questions (OEQ); keywords are important.
  - "Interactions within the environment" is often one of the last topics taught before PSLE, yet carries one of the heaviest marks.
  - Lastly, OEQ also means that handwriting is important!

Another insight: "Interactions" and "Heat" are dominated by OEQs — and students often bleed half-marks for imprecise language here.

Knowing the breakdown of topics is the easy part. Knowing how {{childName}}'s written answers score against the MOE scoring rubrics is what closes the gap. This is why we created the Focused Practice function.

From {{childName}}'s homepage, set a 10-question drill on any one of these highly-tested topics. Our marker scores per-subpart against the same examiner rubric used at PSLE. We don't give vague feedback. We give concrete, actionable feedback that highlights missing scientific keywords and concepts.

What next? Let's get {{childName}} started on Focused Practice.

👉 Set a topical Focused Practice via {{childName}}'s homepage: {{childHomepageUrl}} → Focused Practice → choose topic.

Have a productive week,

Jessica
Co-Founder, MarkForYou`,
  },
  {
    id: "onboarding-day03-b",
    emailNumber: 2,
    title: "Email 2B \u00b7 Day 3 \u00b7 Not sure where to start with {{childName}}? Here's the data that decides for you.",
    variant: 'b',
    trigger: { kind: 'signup_age', days: 3 },
    subject: "Not sure where to start with {{childName}}? Here's the data that decides for you.",
    htmlBody: `<style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, sans-serif;
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
.ps b { font-weight: 700; }</style>
<p>Hi {{parentName}},</p>
<p>Day 3. Life's busy, and we're not going to nag.</p>
<p>If {{childName}} hasn't done their first quiz or focused practice with us yet, the honest reason is usually one of these: you weren't sure where to begin, you forgot, or it didn't feel urgent yet. Whichever — fair.</p>
<p>What we can do is make the <strong>first decision</strong> easier. Here's the data that turns "where do I even start?" into a clear next step.</p>
<p>We broke down every PSLE Science question from 2022, 2023 and 2024 — 122 questions, 297 marks. The top 5 topics by share of marks tested:</p>
<img src="day02-psle-science-top5.png" alt="PSLE Science 2022–2024: top 5 topics by share of total marks.">
<p class="caption">PSLE Science 2022–2024: top 5 topics by share of total marks.</p>
<p>1.  <strong>Interactions within the environment</strong> (e.g. adaptation, food webs) — 13%</p>
<p>2.  <strong>Electrical systems &amp; circuits</strong> — 10%</p>
<p>3.  <strong>Forces</strong> (friction + gravity + spring) — 10%</p>
<p>3.  <strong>Heat energy &amp; uses</strong> — 10%</p>
<p>5.  <strong>Diversity of living &amp; non-living</strong> — 8%</p>
<p>Together these five make up roughly <strong>half</strong> of every PSLE Science paper. That's where to point {{childName}} first — specifically <strong>Interactions</strong> or <strong>Heat</strong>, since both are 10%+ of marks AND OEQ-heavy (where the marks-recovery upside is largest).</p>
<p>Here's the smallest possible step: <strong>10 minutes of Focused Practice tonight on Heat.</strong> The system needs one signal to start from. After that, every recommendation gets sharper.</p>
<p>Our marker scores per-subpart against the same examiner rubric used at PSLE — so {{childName}} gets back specific language feedback ("you said <em>the tile is colder</em> — the expected phrasing is <em>the tile is a better conductor; heat is transferred faster</em>"). Specific. Actionable.</p>
<p class="cta">👉 <strong>Set a 10-min Focused Practice on Heat tonight → {{childHomepageUrl}} → Focused Practice → choose "Heat energy &amp; uses"</strong></p>
<p>If 10 minutes is still too much tonight — that's also fine. Just open {{childName}}'s homepage and pick any Daily Quiz in any subject. 10–15 minutes, any subject, system learns from whatever they do.</p>
<p><strong>Quick brain-stretch for {{childName}} over breakfast — a classic Heat OEQ:</strong></p>
<blockquote>Why does the tiled floor feel colder than the wooden floor, even though both are at room temperature?</blockquote>
<p>Most kids (and most adults) say: "tiles are colder." They're not — they're at the same temperature as the wood. The correct answer names <strong>conduction</strong>: tiles are better conductors of heat, so heat is transferred from the foot to the tile faster. The foot loses heat quicker and feels colder.</p>
<p>The language fix that rescues half-marks across every PSLE Heat OEQ: don't say "X is colder" — say "<strong>X is a better conductor; heat is transferred faster.</strong>" One language swap, a whole sub-topic's worth of marks back.</p>
<p>Have a good week,</p>
<p class="signoff-name">Jessica</p>
<p class="signoff-role">Co-Founder, MarkForYou</p>`,
    textBody: `Hi {{parentName}},

Day 3. Life's busy, and we're not going to nag.

If {{childName}} hasn't done their first quiz or focused practice with us yet, the honest reason is usually one of these: you weren't sure where to begin, you forgot, or it didn't feel urgent yet. Whichever — fair.

What we can do is make the first decision easier. Here's the data that turns "where do I even start?" into a clear next step.

We broke down every PSLE Science question from 2022, 2023 and 2024 — 122 questions, 297 marks. The top 5 topics by share of marks tested:

[Image: day02-psle-science-top5.png — PSLE Science 2022–2024: top 5 topics by share of total marks.]

1.  Interactions within the environment (e.g. adaptation, food webs) — 13%

2.  Electrical systems & circuits — 10%

3.  Forces (friction + gravity + spring) — 10%

3.  Heat energy & uses — 10%

5.  Diversity of living & non-living — 8%

Together these five make up roughly half of every PSLE Science paper. That's where to point {{childName}} first — specifically Interactions or Heat, since both are 10%+ of marks AND OEQ-heavy (where the marks-recovery upside is largest).

Here's the smallest possible step: 10 minutes of Focused Practice tonight on Heat. The system needs one signal to start from. After that, every recommendation gets sharper.

Our marker scores per-subpart against the same examiner rubric used at PSLE — so {{childName}} gets back specific language feedback ("you said the tile is colder — the expected phrasing is the tile is a better conductor; heat is transferred faster"). Specific. Actionable.

👉 Set a 10-min Focused Practice on Heat tonight → {{childHomepageUrl}} → Focused Practice → choose "Heat energy & uses"

If 10 minutes is still too much tonight — that's also fine. Just open {{childName}}'s homepage and pick any Daily Quiz in any subject. 10–15 minutes, any subject, system learns from whatever they do.

Quick brain-stretch for {{childName}} over breakfast — a classic Heat OEQ:

> Why does the tiled floor feel colder than the wooden floor, even though both are at room temperature?

Most kids (and most adults) say: "tiles are colder." They're not — they're at the same temperature as the wood. The correct answer names conduction: tiles are better conductors of heat, so heat is transferred from the foot to the tile faster. The foot loses heat quicker and feels colder.

The language fix that rescues half-marks across every PSLE Heat OEQ: don't say "X is colder" — say "X is a better conductor; heat is transferred faster." One language swap, a whole sub-topic's worth of marks back.

Have a good week,

Jessica
Co-Founder, MarkForYou`,
  },
  {
    id: "onboarding-day07",
    emailNumber: 3,
    title: "Email 3 \u00b7 Day 7 \u00b7 Why our system queues a test for {{childName}} 7 days from today (and the science behind it)",
    variant: undefined,
    trigger: { kind: 'signup_age', days: 7 },
    subject: "Why our system queues a test for {{childName}} 7 days from today (and the science behind it)",
    htmlBody: `<style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, sans-serif;
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
.ps b { font-weight: 700; }</style>
<p>Hi {{parentName}},</p>
<p>Quick thought experiment: think back to something {{childName}} learned in P3 — say, the parts of a flower. Could they label a diagram right now, with no prep?</p>
<p>For most P5/P6 students, the answer is "kind of." They remember roughly half the parts. The other half got dumped somewhere around Week 3 of P4.</p>
<p>This isn't a {{childName}} problem. It's the human brain working as designed.</p>
<p>In 1885, Hermann Ebbinghaus showed that the brain dumps about <strong>70% of new information within 24 hours</strong> unless we revisit it deliberately. By Day 7, retention is down to ~20% — <strong>unless</strong> there's been a forced retrieval somewhere in that window. That retrieval is what shifts learning from short-term to long-term storage.</p>
<img src="day01-forgetting-curve.png" alt="Ebbinghaus's forgetting curve — retention falls to ~30% by Day 1 without deliberate retrieval.">
<p class="caption">Ebbinghaus's forgetting curve — retention falls to ~30% by Day 1 without deliberate retrieval.</p>
<p>This is why we built the <strong>auto-revision queue</strong> the way we did.</p>
<p>Every time {{childName}} gets a question wrong on any paper or quiz, that question goes into a personal revision queue — and the system automatically schedules it back into a follow-up paper roughly <strong>7 days later</strong>. Same question type, same sub-topic, slightly different wording. {{childName}} gets to attempt it again at exactly the moment retention is dropping — which is the moment retrieval is most effective.</p>
<p>You don't have to remember to schedule revision. The system does it. Both you and {{childName}} get a notification when the next revision paper is ready.</p>
<p>There's a sibling feature that pairs with this beautifully: the <strong>"Recent mistakes — last 7 days"</strong> view. One click pulls every wrong question from the past week across every paper, tagged by sub-topic. Pair that with 12 minutes of re-doing on a Sunday evening, and you've got a study habit that beats 2 hours of random worksheets.</p>
<p class="cta">👉 <strong>Open {{childName}}'s 7-day mistake list tonight → {{childHomepageUrl}} → AI Insights → "Recent mistakes (last 7 days)"</strong></p>
<p><strong>One for {{childName}} on the MRT home tomorrow:</strong></p>
<blockquote>Q. <em>Emily, together with her brothers, ____ attending their cousin's wedding tomorrow night.</em></blockquote>
<blockquote>(1) is   (2) are   (3) was   (4) were</blockquote>
<p>Most kids pick (2) "are" — they see "brothers," hear plural, pick the plural verb. The correct answer is <strong>(1) is</strong>. The trick: cover the phrase between the commas with your thumb. "Emily ___ attending the wedding." Now "is" is obvious.</p>
<p>Same trap turns up with "The principal, as well as the teachers, ___" and "The dog, along with its puppies, ___". Free marks once the trick clicks.</p>
<p>Onward,</p>
<p class="signoff-name">Jessica</p>
<p class="signoff-role">Co-Founder, MarkForYou</p>`,
    textBody: `Hi {{parentName}},

Quick thought experiment: think back to something {{childName}} learned in P3 — say, the parts of a flower. Could they label a diagram right now, with no prep?

For most P5/P6 students, the answer is "kind of." They remember roughly half the parts. The other half got dumped somewhere around Week 3 of P4.

This isn't a {{childName}} problem. It's the human brain working as designed.

In 1885, Hermann Ebbinghaus showed that the brain dumps about 70% of new information within 24 hours unless we revisit it deliberately. By Day 7, retention is down to ~20% — unless there's been a forced retrieval somewhere in that window. That retrieval is what shifts learning from short-term to long-term storage.

[Image: day01-forgetting-curve.png — Ebbinghaus's forgetting curve — retention falls to ~30% by Day 1 without deliberate retrieval.]

This is why we built the auto-revision queue the way we did.

Every time {{childName}} gets a question wrong on any paper or quiz, that question goes into a personal revision queue — and the system automatically schedules it back into a follow-up paper roughly 7 days later. Same question type, same sub-topic, slightly different wording. {{childName}} gets to attempt it again at exactly the moment retention is dropping — which is the moment retrieval is most effective.

You don't have to remember to schedule revision. The system does it. Both you and {{childName}} get a notification when the next revision paper is ready.

There's a sibling feature that pairs with this beautifully: the "Recent mistakes — last 7 days" view. One click pulls every wrong question from the past week across every paper, tagged by sub-topic. Pair that with 12 minutes of re-doing on a Sunday evening, and you've got a study habit that beats 2 hours of random worksheets.

👉 Open {{childName}}'s 7-day mistake list tonight → {{childHomepageUrl}} → AI Insights → "Recent mistakes (last 7 days)"

One for {{childName}} on the MRT home tomorrow:

> Q. Emily, together with her brothers, ____ attending their cousin's wedding tomorrow night.

> (1) is   (2) are   (3) was   (4) were

Most kids pick (2) "are" — they see "brothers," hear plural, pick the plural verb. The correct answer is (1) is. The trick: cover the phrase between the commas with your thumb. "Emily ___ attending the wedding." Now "is" is obvious.

Same trap turns up with "The principal, as well as the teachers, ___" and "The dog, along with its puppies, ___". Free marks once the trick clicks.

Onward,

Jessica
Co-Founder, MarkForYou`,
  },
  {
    id: "onboarding-day11",
    emailNumber: 4,
    title: "Email 4 \u00b7 Day 11 \u00b7 PSLE is 1h 45m of handwriting. The marker that actually knows how to read it.",
    variant: undefined,
    trigger: { kind: 'signup_age', days: 11 },
    subject: "PSLE is 1h 45m of handwriting. The marker that actually knows how to read it.",
    htmlBody: `<style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, sans-serif;
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
.ps b { font-weight: 700; }</style>
<p>Hi {{parentName}},</p>
<p>Quick observation. PSLE is <strong>1 hour 45 minutes of handwriting</strong> — long-form, by hand, on paper, with diagrams to label and OEQs to write out. The most useful prep is the kind that mirrors that.</p>
<p>Good news: handwriting practice in MarkForYou works two ways, whichever fits {{childName}}'s evening:</p>
<p>•  <strong>In-app handwriting canvas</strong> — {{childName}} writes directly on the tablet with a stylus. We give Math, Science, and English their own pen-optimised canvases, with a 田字格 grid for Chinese. Per-subpart ink layers are saved separately, so the marker knows exactly which parts were attempted versus left blank.</p>
<p>•  <strong>Print + scan</strong> — for any quiz or paper you've assigned, hit the <strong>Print</strong> button. {{childName}} writes the paper on actual paper, in actual exam conditions (timer, no phone). When done, hit <strong>Scan</strong> in the app, point the camera at each page, done. Marked within 5–10 minutes, per-subpart, with parent-review notes ready to read.</p>
<p>Both paths feed into the same weakness picture. Both produce the same per-subpart feedback. The choice is purely about which fits {{childName}}'s study setup that night.</p>
<div class="todo">📸 <b>SCREENSHOT TO PASTE:</b> Screenshot pair: (1) the in-app handwriting canvas with stylus-written student answer; (2) the Print + Scan buttons on an assigned paper. Side by side if possible, so the two paths read at a glance.</div>
<p><strong>The thing most generalist AI tools can't do:</strong> open-ended, free-form handwritten marking. Typed MCQs are easy. Even clean handwritten MCQ bubbles are doable. But messy P5/P6 handwriting on OEQs — with diagrams, crossed-out workings, arrows in the margin, half-corrected mistakes — is where most markers either refuse to mark it, or worse, hallucinate working that isn't on the page.</p>
<img src="day11-oeq-structure.png" alt="Same Science OEQ, two answers — one gets 1/2, the other 2/2. Our marker scores per-subpart with the language-fix in the parent-review note.">
<p class="caption">Same Science OEQ, two answers — one gets 1/2, the other 2/2. Our marker scores per-subpart with the language-fix in the parent-review note.</p>
<p>We built MarkForYou specifically around this. Per-subpart ink detection, blank-subpart clamps, model retries when ink is detected but text comes back garbled, anti-hallucination guards that strip marks from any part with no ink. Unsexy engineering. Materially better marking — especially on the OEQ types that carry the biggest mark weighting at PSLE.</p>
<p>The result: <strong>{{childName}} can practice in genuine exam conditions</strong> — full timing, full handwriting, full free-form answers — and you can trust that every mark on the report is real.</p>
<p class="cta">👉 <strong>Set {{childName}} a paper this weekend → {{childHomepageUrl}} → Set Papers → "Print" or use the handwriting canvas</strong></p>
<p><strong>For {{childName}} at dinner tonight — a question tag trap:</strong></p>
<blockquote>Q. <em>"Ahmad's cleaned up his room, ____ ?"</em></blockquote>
<blockquote>(1) isn't he   (2) didn't he   (3) hasn't he   (4) doesn't he</blockquote>
<p>Most kids pick (2) "didn't he" — "cleaned" sounds past tense. Correct answer is <strong>(3) hasn't he</strong>.</p>
<p>The trick: expand the apostrophe. "Ahmad's cleaned" can't be "Ahmad IS cleaned" (nonsense). So \`'s\` = HAS. The tag mirrors the helping verb: has → hasn't.</p>
<p>Have a good weekend,</p>
<p class="signoff-name">Jessica</p>
<p class="signoff-role">Co-Founder, MarkForYou</p>`,
    textBody: `Hi {{parentName}},

Quick observation. PSLE is 1 hour 45 minutes of handwriting — long-form, by hand, on paper, with diagrams to label and OEQs to write out. The most useful prep is the kind that mirrors that.

Good news: handwriting practice in MarkForYou works two ways, whichever fits {{childName}}'s evening:

•  In-app handwriting canvas — {{childName}} writes directly on the tablet with a stylus. We give Math, Science, and English their own pen-optimised canvases, with a 田字格 grid for Chinese. Per-subpart ink layers are saved separately, so the marker knows exactly which parts were attempted versus left blank.

•  Print + scan — for any quiz or paper you've assigned, hit the Print button. {{childName}} writes the paper on actual paper, in actual exam conditions (timer, no phone). When done, hit Scan in the app, point the camera at each page, done. Marked within 5–10 minutes, per-subpart, with parent-review notes ready to read.

Both paths feed into the same weakness picture. Both produce the same per-subpart feedback. The choice is purely about which fits {{childName}}'s study setup that night.

[SCREENSHOT TO PASTE: Screenshot pair: (1) the in-app handwriting canvas with stylus-written student answer; (2) the Print + Scan buttons on an assigned paper. Side by side if possible, so the two paths read at a glance.]

The thing most generalist AI tools can't do: open-ended, free-form handwritten marking. Typed MCQs are easy. Even clean handwritten MCQ bubbles are doable. But messy P5/P6 handwriting on OEQs — with diagrams, crossed-out workings, arrows in the margin, half-corrected mistakes — is where most markers either refuse to mark it, or worse, hallucinate working that isn't on the page.

[Image: day11-oeq-structure.png — Same Science OEQ, two answers — one gets 1/2, the other 2/2. Our marker scores per-subpart with the language-fix in the parent-review note.]

We built MarkForYou specifically around this. Per-subpart ink detection, blank-subpart clamps, model retries when ink is detected but text comes back garbled, anti-hallucination guards that strip marks from any part with no ink. Unsexy engineering. Materially better marking — especially on the OEQ types that carry the biggest mark weighting at PSLE.

The result: {{childName}} can practice in genuine exam conditions — full timing, full handwriting, full free-form answers — and you can trust that every mark on the report is real.

👉 Set {{childName}} a paper this weekend → {{childHomepageUrl}} → Set Papers → "Print" or use the handwriting canvas

For {{childName}} at dinner tonight — a question tag trap:

> Q. "Ahmad's cleaned up his room, ____ ?"

> (1) isn't he   (2) didn't he   (3) hasn't he   (4) doesn't he

Most kids pick (2) "didn't he" — "cleaned" sounds past tense. Correct answer is (3) hasn't he.

The trick: expand the apostrophe. "Ahmad's cleaned" can't be "Ahmad IS cleaned" (nonsense). So \`'s\` = HAS. The tag mirrors the helping verb: has → hasn't.

Have a good weekend,

Jessica
Co-Founder, MarkForYou`,
  },
  {
    id: "onboarding-day14",
    emailNumber: 5,
    title: "Email 5 \u00b7 Day 14 \u00b7 and the chart we wish more parents saw.",
    variant: undefined,
    trigger: { kind: 'signup_age', days: 14 },
    subject: "Halfway through your trial \u2014 and the chart we wish more parents saw.",
    htmlBody: `<style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, sans-serif;
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
.ps b { font-weight: 700; }</style>
<p>Hi {{parentName}},</p>
<p>You're halfway through {{childName}}'s 30-day trial. Quick mid-trial reflection — and a chart we wish more parents saw before they picked an AI marking tool.</p>
<p>A few weeks ago we ran an internal benchmark: identical PSLE Science papers, identical answer keys, fed to four different markers including our own. The results were sharper than we expected.</p>
<img src="day06-accuracy-bars.png" alt="MarkForYou internal benchmark — identical PSLE Science papers and answer keys, scored by four different markers.">
<p class="caption">MarkForYou internal benchmark — identical PSLE Science papers and answer keys, scored by four different markers.</p>
<p>•  <strong>Qwen</strong> — 75%</p>
<p>•  <strong>Gemini Pro V3.1</strong> — 82%</p>
<p>•  <strong>ChatGPT V5.5 Pro</strong> — 88%</p>
<p>•  <strong>MarkForYou</strong> — 100%</p>
<p>We're not saying frontier models are bad. They're remarkable for many things. PSLE marking just isn't one of them — because the conventions are extremely specific (per-subpart caps, blank-subpart rules, anti-hallucination guards, no synonyms accepted in Synthesis), and generalist models don't know them out of the box.</p>
<p>We do, because that's literally all we built MarkForYou to do.</p>
<p><strong>Why this matters for {{childName}}, specifically:</strong></p>
<p>A marker at 88% accuracy means roughly <strong>1-in-8 questions tells {{childName}} a correct answer is wrong</strong>, or marks a mistake as right. At 75% it's 1-in-4. That's not just frustrating — it actively builds the wrong habits. {{childName}} writes the correct OEQ structure, gets dinged, learns to write a <em>different</em> structure that "the AI prefers," and walks into PSLE day with a habit that will lose them marks.</p>
<p>100% accuracy isn't a brag. It's the bare minimum for high-stakes prep. The unsexy engineering that gets us there — per-subpart scoring, answer-key clamps, model retries, two-phase marker, blank-subpart clamp — is exactly the work that pays back over the 12 months of P5/P6 practice leading to PSLE.</p>
<div class="todo">📸 <b>SCREENSHOT TO PASTE:</b> Optional — screenshot of one of {{childName}}'s actually-marked questions, showing the per-subpart scoring + parent-review notes. Adds proof that this pipeline ran on their child specifically.</div>
<p>Over your trial so far, <strong>every piece of {{childName}}'s marked work has gone through this same pipeline.</strong> Every weakness picture, every Focused Practice recommendation, every revision queue — built on marking you can trust.</p>
<p>16 days left in the trial. The most useful move this week is to keep feeding the marker — every quiz, every focused practice, every paper sharpens the picture by another notch.</p>
<p class="cta">👉 <strong>Set {{childName}} another Focused Practice tonight → {{childHomepageUrl}}</strong></p>
<p><strong>A small one for {{childName}} tonight — sense verbs:</strong></p>
<blockquote>Q. <em>From her window, Mary could hear her neighbours' children ____ happily in the garden.</em></blockquote>
<blockquote>(1) play   (2) plays   (3) played   (4) playing</blockquote>
<p>Most kids pick (2) "plays." Correct answer is <strong>(4) playing</strong>.</p>
<p>The rule: after sensory verbs (hear, see, watch, feel) + object, use the <strong>-ing form</strong>. "Hear children playing" — the action is ongoing while Mary hears them.</p>
<p>Have a great week,</p>
<p class="signoff-name">Jessica</p>
<p class="signoff-role">Co-Founder, MarkForYou</p>`,
    textBody: `Hi {{parentName}},

You're halfway through {{childName}}'s 30-day trial. Quick mid-trial reflection — and a chart we wish more parents saw before they picked an AI marking tool.

A few weeks ago we ran an internal benchmark: identical PSLE Science papers, identical answer keys, fed to four different markers including our own. The results were sharper than we expected.

[Image: day06-accuracy-bars.png — MarkForYou internal benchmark — identical PSLE Science papers and answer keys, scored by four different markers.]

•  Qwen — 75%

•  Gemini Pro V3.1 — 82%

•  ChatGPT V5.5 Pro — 88%

•  MarkForYou — 100%

We're not saying frontier models are bad. They're remarkable for many things. PSLE marking just isn't one of them — because the conventions are extremely specific (per-subpart caps, blank-subpart rules, anti-hallucination guards, no synonyms accepted in Synthesis), and generalist models don't know them out of the box.

We do, because that's literally all we built MarkForYou to do.

Why this matters for {{childName}}, specifically:

A marker at 88% accuracy means roughly 1-in-8 questions tells {{childName}} a correct answer is wrong, or marks a mistake as right. At 75% it's 1-in-4. That's not just frustrating — it actively builds the wrong habits. {{childName}} writes the correct OEQ structure, gets dinged, learns to write a different structure that "the AI prefers," and walks into PSLE day with a habit that will lose them marks.

100% accuracy isn't a brag. It's the bare minimum for high-stakes prep. The unsexy engineering that gets us there — per-subpart scoring, answer-key clamps, model retries, two-phase marker, blank-subpart clamp — is exactly the work that pays back over the 12 months of P5/P6 practice leading to PSLE.

[SCREENSHOT TO PASTE: Optional — screenshot of one of {{childName}}'s actually-marked questions, showing the per-subpart scoring + parent-review notes. Adds proof that this pipeline ran on their child specifically.]

Over your trial so far, every piece of {{childName}}'s marked work has gone through this same pipeline. Every weakness picture, every Focused Practice recommendation, every revision queue — built on marking you can trust.

16 days left in the trial. The most useful move this week is to keep feeding the marker — every quiz, every focused practice, every paper sharpens the picture by another notch.

👉 Set {{childName}} another Focused Practice tonight → {{childHomepageUrl}}

A small one for {{childName}} tonight — sense verbs:

> Q. From her window, Mary could hear her neighbours' children ____ happily in the garden.

> (1) play   (2) plays   (3) played   (4) playing

Most kids pick (2) "plays." Correct answer is (4) playing.

The rule: after sensory verbs (hear, see, watch, feel) + object, use the -ing form. "Hear children playing" — the action is ongoing while Mary hears them.

Have a great week,

Jessica
Co-Founder, MarkForYou`,
  },
  {
    id: "onboarding-day18-a",
    emailNumber: 6,
    title: "Email 6A \u00b7 Day 18 \u00b7 {{childName}}'s weakness picture is sharp enough to act on. One screen tonight.",
    variant: 'a',
    trigger: { kind: 'signup_age', days: 18 },
    subject: "{{childName}}'s weakness picture is sharp enough to act on. One screen tonight.",
    htmlBody: `<style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, sans-serif;
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
.ps b { font-weight: 700; }</style>
<p>Hi {{parentName}},</p>
<p>Twelve days left in {{childName}}'s trial. Quick reflection — and a screen worth opening tonight.</p>
<p>First — a thank you. The quizzes, focused practices, and papers you've set over the past 18 days have done the most important thing: given our marker a steady stream of signal. {{childName}}'s weakness picture is no longer a guess; it's a real shape, with named sub-topics where we can see specific language patterns slipping.</p>
<p>If you remember from Email 2, half of every PSLE Science paper is just 5 topics — Interactions, Electrical, Forces, Heat, Diversity. About 50% of all marks live there. That's also where we've weighted our recommendation engine most heavily. When the system suggests a Focused Practice for {{childName}}, it isn't picking at random — it's picking the <strong>highest marks-recovered-per-minute</strong> topic, given what we've seen {{childName}} miss so far.</p>
<p>(That same topic-frequency analysis runs in the background across every part of the platform — including a particular feature we'll show you in your last email, where we built our deepest resource set around exactly the highest-frequency PSLE topics. More on that in 10 days.)</p>
<p>For tonight, the one screen worth opening is the <strong>Parent Dashboard's Weekly Summary</strong>. From {{childName}}'s homepage, click "Weekly summary" — single screen, one minute to read:</p>
<p>•  Papers + quizzes completed this week</p>
<p>•  Marks earned vs. last week (the bit that gets parents emotional, in a good way)</p>
<p>•  Top 3 improvements — what {{childName}} has visibly got better at</p>
<p>•  Top 3 weak spots — what's still bleeding marks</p>
<p>•  Revision queue — the questions scheduled to resurface in the next 7 days</p>
<div class="todo">📸 <b>SCREENSHOT TO PASTE:</b> Screenshot: the Weekly Summary view as it appears on {{childName}}'s parent dashboard. Should show the top-3-improvements + top-3-weak-spots side-by-side, with the revision queue at the bottom.</div>
<p>It's the screen that replaces opening 14 different worksheets to figure out how the week went. Most parents we talk to don't touch it in week 1 but check it religiously by week 3.</p>
<p>12 days left, no better use of them than letting the weakness picture get even sharper.</p>
<p class="cta">👉 <strong>Open {{childName}}'s Weekly Summary tonight → {{childHomepageUrl}} → "Weekly summary"</strong></p>
<p><strong>For the weekend, a real PSLE Synthesis trap — try it on {{childName}}:</strong></p>
<blockquote>Combine these into one sentence starting with "Unless":</blockquote>
<blockquote><em>"If we do not leave home now, we will miss the beginning of the movie."</em></blockquote>
<p>Most kids write: <em>"Unless we leave home now, we will miss the beginning of the movie."</em> That feels right. It loses half a mark.</p>
<p>The PSLE marking scheme treats "Unless" as a 1-to-1 substitute and <strong>keeps the original negative</strong>: <em>"Unless we do not leave home now, we will miss the beginning of the movie."</em></p>
<p>Counterintuitive — but it's exactly the kind of trap our Synthesis weakness map catches and drills.</p>
<p>Have a good week,</p>
<p class="signoff-name">Jessica</p>
<p class="signoff-role">Co-Founder, MarkForYou</p>`,
    textBody: `Hi {{parentName}},

Twelve days left in {{childName}}'s trial. Quick reflection — and a screen worth opening tonight.

First — a thank you. The quizzes, focused practices, and papers you've set over the past 18 days have done the most important thing: given our marker a steady stream of signal. {{childName}}'s weakness picture is no longer a guess; it's a real shape, with named sub-topics where we can see specific language patterns slipping.

If you remember from Email 2, half of every PSLE Science paper is just 5 topics — Interactions, Electrical, Forces, Heat, Diversity. About 50% of all marks live there. That's also where we've weighted our recommendation engine most heavily. When the system suggests a Focused Practice for {{childName}}, it isn't picking at random — it's picking the highest marks-recovered-per-minute topic, given what we've seen {{childName}} miss so far.

(That same topic-frequency analysis runs in the background across every part of the platform — including a particular feature we'll show you in your last email, where we built our deepest resource set around exactly the highest-frequency PSLE topics. More on that in 10 days.)

For tonight, the one screen worth opening is the Parent Dashboard's Weekly Summary. From {{childName}}'s homepage, click "Weekly summary" — single screen, one minute to read:

•  Papers + quizzes completed this week

•  Marks earned vs. last week (the bit that gets parents emotional, in a good way)

•  Top 3 improvements — what {{childName}} has visibly got better at

•  Top 3 weak spots — what's still bleeding marks

•  Revision queue — the questions scheduled to resurface in the next 7 days

[SCREENSHOT TO PASTE: Screenshot: the Weekly Summary view as it appears on {{childName}}'s parent dashboard. Should show the top-3-improvements + top-3-weak-spots side-by-side, with the revision queue at the bottom.]

It's the screen that replaces opening 14 different worksheets to figure out how the week went. Most parents we talk to don't touch it in week 1 but check it religiously by week 3.

12 days left, no better use of them than letting the weakness picture get even sharper.

👉 Open {{childName}}'s Weekly Summary tonight → {{childHomepageUrl}} → "Weekly summary"

For the weekend, a real PSLE Synthesis trap — try it on {{childName}}:

> Combine these into one sentence starting with "Unless":

> "If we do not leave home now, we will miss the beginning of the movie."

Most kids write: "Unless we leave home now, we will miss the beginning of the movie." That feels right. It loses half a mark.

The PSLE marking scheme treats "Unless" as a 1-to-1 substitute and keeps the original negative: "Unless we do not leave home now, we will miss the beginning of the movie."

Counterintuitive — but it's exactly the kind of trap our Synthesis weakness map catches and drills.

Have a good week,

Jessica
Co-Founder, MarkForYou`,
  },
  {
    id: "onboarding-day18-b",
    emailNumber: 6,
    title: "Email 6B \u00b7 Day 18 \u00b7 and the smallest viable way to make the trial count.",
    variant: 'b',
    trigger: { kind: 'signup_age', days: 18 },
    subject: "12 days left \u2014 and the smallest viable way to make the trial count.",
    htmlBody: `<style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, sans-serif;
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
.ps b { font-weight: 700; }</style>
<p>Hi {{parentName}},</p>
<p>{{childName}}'s trial has 12 days left. Quick honest check-in.</p>
<p>Whatever the reason — busy term, kids resisting, you signed up to explore and life happened — the first 18 days haven't seen much activity from {{childName}}. Totally fine. The platform doesn't care if you've done 1 activity or 50; it just needs a signal to start from. Right now, it doesn't have enough.</p>
<p>Here's the <strong>lowest-friction way</strong> to make the next 12 days count, without it feeling like a chore for either of you:</p>
<p>•  <strong>Tonight</strong> — one Focused Practice, 10 minutes. Pick any topic from Email 2 (Interactions or Heat are the highest-yield).</p>
<p>•  <strong>Tomorrow</strong> — one Daily Quiz, 10 minutes, different subject. Whichever subject {{childName}} is most resistant to (usually the one hiding the biggest gaps).</p>
<p>•  <strong>Sunday evening</strong> — open the Weekly Summary together. One screen, one minute.</p>
<p>That's it. <strong>3 activities, ~25 minutes total over the week.</strong> By Day 30 that's enough data to see whether MarkForYou earns its place in {{childName}}'s PSLE prep — without making the trial feel like work.</p>
<p>If you remember from Email 2: half of PSLE Science is just 5 topics. So even one focused practice on Heat tonight gets you a meaningful read on a topic worth 10% of every PSLE paper. That's a high return for 10 minutes.</p>
<p>(Our resource library — the deep concept-video set — is tuned to those same high-frequency topics. We'll show you the most useful corner of it in your final email, but only if there's enough activity by then for the recommendations to be personalised.)</p>
<div class="todo">📸 <b>SCREENSHOT TO PASTE:</b> Optional — screenshot of the Focused Practice setup screen, showing how quickly a parent can pick a topic and assign a 10-question drill. Helps lower the perceived friction.</div>
<p>A few parents have asked: <strong>"What happens at the end of my 30 days?"</strong> Honest answer: the system keeps everything you've built. The forward-looking bits — new focused practices, new marking — need a paid plan to continue. We'll send a clearer email about that closer to Day 28. No surprise charges; the trial just ends.</p>
<p>For now: 12 days left. The smallest viable trial we'd suggest is <strong>3 activities, this week</strong>. Pick any one as the starting point.</p>
<p class="cta">👉 <strong>Start with 10 minutes of Focused Practice on Heat tonight → {{childHomepageUrl}} → Focused Practice → "Heat energy &amp; uses"</strong></p>
<p><strong>For the weekend, a real PSLE Synthesis trap — try it on {{childName}}:</strong></p>
<blockquote>Combine these into one sentence starting with "Unless":</blockquote>
<blockquote><em>"If we do not leave home now, we will miss the beginning of the movie."</em></blockquote>
<p>Most kids write: <em>"Unless we leave home now, we will miss the beginning of the movie."</em> That feels right. It loses half a mark.</p>
<p>The PSLE marking scheme treats "Unless" as a 1-to-1 substitute and <strong>keeps the original negative</strong>: <em>"Unless we do not leave home now, we will miss the beginning of the movie."</em></p>
<p>Counterintuitive — and it's exactly the kind of trap that gets clearer the more focused practice {{childName}} does in this category.</p>
<p>Have a good week,</p>
<p class="signoff-name">Jessica</p>
<p class="signoff-role">Co-Founder, MarkForYou</p>`,
    textBody: `Hi {{parentName}},

{{childName}}'s trial has 12 days left. Quick honest check-in.

Whatever the reason — busy term, kids resisting, you signed up to explore and life happened — the first 18 days haven't seen much activity from {{childName}}. Totally fine. The platform doesn't care if you've done 1 activity or 50; it just needs a signal to start from. Right now, it doesn't have enough.

Here's the lowest-friction way to make the next 12 days count, without it feeling like a chore for either of you:

•  Tonight — one Focused Practice, 10 minutes. Pick any topic from Email 2 (Interactions or Heat are the highest-yield).

•  Tomorrow — one Daily Quiz, 10 minutes, different subject. Whichever subject {{childName}} is most resistant to (usually the one hiding the biggest gaps).

•  Sunday evening — open the Weekly Summary together. One screen, one minute.

That's it. 3 activities, ~25 minutes total over the week. By Day 30 that's enough data to see whether MarkForYou earns its place in {{childName}}'s PSLE prep — without making the trial feel like work.

If you remember from Email 2: half of PSLE Science is just 5 topics. So even one focused practice on Heat tonight gets you a meaningful read on a topic worth 10% of every PSLE paper. That's a high return for 10 minutes.

(Our resource library — the deep concept-video set — is tuned to those same high-frequency topics. We'll show you the most useful corner of it in your final email, but only if there's enough activity by then for the recommendations to be personalised.)

[SCREENSHOT TO PASTE: Optional — screenshot of the Focused Practice setup screen, showing how quickly a parent can pick a topic and assign a 10-question drill. Helps lower the perceived friction.]

A few parents have asked: "What happens at the end of my 30 days?" Honest answer: the system keeps everything you've built. The forward-looking bits — new focused practices, new marking — need a paid plan to continue. We'll send a clearer email about that closer to Day 28. No surprise charges; the trial just ends.

For now: 12 days left. The smallest viable trial we'd suggest is 3 activities, this week. Pick any one as the starting point.

👉 Start with 10 minutes of Focused Practice on Heat tonight → {{childHomepageUrl}} → Focused Practice → "Heat energy & uses"

For the weekend, a real PSLE Synthesis trap — try it on {{childName}}:

> Combine these into one sentence starting with "Unless":

> "If we do not leave home now, we will miss the beginning of the movie."

Most kids write: "Unless we leave home now, we will miss the beginning of the movie." That feels right. It loses half a mark.

The PSLE marking scheme treats "Unless" as a 1-to-1 substitute and keeps the original negative: "Unless we do not leave home now, we will miss the beginning of the movie."

Counterintuitive — and it's exactly the kind of trap that gets clearer the more focused practice {{childName}} does in this category.

Have a good week,

Jessica
Co-Founder, MarkForYou`,
  },
  {
    id: "onboarding-day23",
    emailNumber: 7,
    title: "Email 7 \u00b7 Day 23 \u00b7 PSLE English has ~50 rule-traps. {{childName}} is weak on maybe 5. Here's how to know which.",
    variant: undefined,
    trigger: { kind: 'signup_age', days: 23 },
    subject: "PSLE English has ~50 rule-traps. {{childName}} is weak on maybe 5. Here's how to know which.",
    htmlBody: `<style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, sans-serif;
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
.ps b { font-weight: 700; }</style>
<p>Hi {{parentName}},</p>
<p>If you've been following our social posts over the past couple of weeks, you'll have noticed we keep dropping the same kind of PSLE English clickbait — "Emily, together with her brothers, ___ attending the wedding." "Ahmad's cleaned his room, ___ ?" "My teacher has asked Sally and ___ to help."</p>
<p>Each one feels like a one-off. They're not.</p>
<p>There are about <strong>50 of these rule-traps in total</strong> across PSLE Synthesis, Grammar MCQ, and Vocabulary Cloze.</p>
<p>Here's what we see in marking data, again and again: every child is <strong>strong on most of these and weak on a specific handful</strong>. Those weak ones are where they bleed half-marks paper after paper — not because the concept is hard, but because the same rule keeps catching them out.</p>
<p>The hard part is identifying <em>which</em> handful. You'd need to look at 4–6 weeks of {{childName}}'s marked work, tag each mistake by rule, and count. Hours per child per term. Nobody does this manually.</p>
<p><strong>That's exactly what we do in the background, automatically.</strong></p>
<p>Every marked piece of {{childName}}'s English work — quizzes, focused practices, papers — feeds into a rolling <strong>rule-by-rule weakness picture</strong>. Not "P5 grammar in general," but {{childName}}'s actual mistakes, on the rules they personally miss.</p>
<img src="day20-personal-trap-list.png" alt="Sample personal trap list — the actual weakness map for one beta student, anonymised.">
<p class="caption">Sample personal trap list — the actual weakness map for one beta student, anonymised.</p>
<div class="todo">📸 <b>SCREENSHOT TO PASTE:</b> Live screenshot: {{childName}}'s actual AI Insights → English view, with the top weak rules highlighted. Higher-impact than the sample mockup if available.</div>
<p>If you've been nodding through our recent posts thinking "yes, mine does that too" — the value isn't in the individual rules. It's in seeing the personal trap list and drilling those 5 rules with Focused Practice this fortnight, then watching the score gap close on the next paper.</p>
<p class="cta">👉 <strong>Pull up {{childName}}'s English weakness map → {{childHomepageUrl}} → AI Insights → English → "Top weak rules (last 30 days)"</strong></p>
<p><strong>A heads-up on the trial:</strong> you've got 7 days left. The system has been building {{childName}}'s weakness picture across both Science and English the whole time. We'll send one more email before Day 30 with a clear summary of what's included on each plan — no hard sell, just the choice. You'll know whether MarkForYou has earned its keep by then.</p>
<p><strong>Sunday dinner quiz — try this on the whole family:</strong></p>
<p>Three real PSLE traps. Be honest about who in the family gets each one wrong.</p>
<blockquote>Q1. <em>"I wrote it yesterday."</em> In reported speech, "yesterday" becomes ____ ?</blockquote>
<blockquote>Q2. <em>"Neither the principal nor the teachers ____ here today."</em></blockquote>
<blockquote>Q3. <em>"Ahmad's cleaned up his room, ____ ?"</em></blockquote>
<p>Answers:</p>
<p>1.  <strong>the previous day.</strong> Not "the day before" — the PSLE marking scheme rejects synonyms, even when they mean the same thing.</p>
<p>2.  <strong>are.</strong> With "neither A nor B," the verb matches the noun NEAREST to it. "The teachers" is nearest the blank → plural → "are."</p>
<p>3.  <strong>hasn't he.</strong> "Ahmad's cleaned" expands to "Ahmad HAS cleaned" (not "Ahmad IS cleaned"). The tag mirrors the helping verb: has → hasn't.</p>
<p>If you missed any — you're in good company. We see these come up in marked work every single week.</p>
<p>Have a great week,</p>
<p class="signoff-name">Jessica</p>
<p class="signoff-role">Co-Founder, MarkForYou</p>`,
    textBody: `Hi {{parentName}},

If you've been following our social posts over the past couple of weeks, you'll have noticed we keep dropping the same kind of PSLE English clickbait — "Emily, together with her brothers, ___ attending the wedding." "Ahmad's cleaned his room, ___ ?" "My teacher has asked Sally and ___ to help."

Each one feels like a one-off. They're not.

There are about 50 of these rule-traps in total across PSLE Synthesis, Grammar MCQ, and Vocabulary Cloze.

Here's what we see in marking data, again and again: every child is strong on most of these and weak on a specific handful. Those weak ones are where they bleed half-marks paper after paper — not because the concept is hard, but because the same rule keeps catching them out.

The hard part is identifying which handful. You'd need to look at 4–6 weeks of {{childName}}'s marked work, tag each mistake by rule, and count. Hours per child per term. Nobody does this manually.

That's exactly what we do in the background, automatically.

Every marked piece of {{childName}}'s English work — quizzes, focused practices, papers — feeds into a rolling rule-by-rule weakness picture. Not "P5 grammar in general," but {{childName}}'s actual mistakes, on the rules they personally miss.

[Image: day20-personal-trap-list.png — Sample personal trap list — the actual weakness map for one beta student, anonymised.]

[SCREENSHOT TO PASTE: Live screenshot: {{childName}}'s actual AI Insights → English view, with the top weak rules highlighted. Higher-impact than the sample mockup if available.]

If you've been nodding through our recent posts thinking "yes, mine does that too" — the value isn't in the individual rules. It's in seeing the personal trap list and drilling those 5 rules with Focused Practice this fortnight, then watching the score gap close on the next paper.

👉 Pull up {{childName}}'s English weakness map → {{childHomepageUrl}} → AI Insights → English → "Top weak rules (last 30 days)"

A heads-up on the trial: you've got 7 days left. The system has been building {{childName}}'s weakness picture across both Science and English the whole time. We'll send one more email before Day 30 with a clear summary of what's included on each plan — no hard sell, just the choice. You'll know whether MarkForYou has earned its keep by then.

Sunday dinner quiz — try this on the whole family:

Three real PSLE traps. Be honest about who in the family gets each one wrong.

> Q1. "I wrote it yesterday." In reported speech, "yesterday" becomes ____ ?

> Q2. "Neither the principal nor the teachers ____ here today."

> Q3. "Ahmad's cleaned up his room, ____ ?"

Answers:

1.  the previous day. Not "the day before" — the PSLE marking scheme rejects synonyms, even when they mean the same thing.

2.  are. With "neither A nor B," the verb matches the noun NEAREST to it. "The teachers" is nearest the blank → plural → "are."

3.  hasn't he. "Ahmad's cleaned" expands to "Ahmad HAS cleaned" (not "Ahmad IS cleaned"). The tag mirrors the helping verb: has → hasn't.

If you missed any — you're in good company. We see these come up in marked work every single week.

Have a great week,

Jessica
Co-Founder, MarkForYou`,
  },
  {
    id: "onboarding-day28",
    emailNumber: 8,
    title: "Email 8 \u00b7 Day 28 \u00b7 here's what you've built.",
    variant: undefined,
    trigger: { kind: 'signup_age', days: 28 },
    subject: "Two days left on {{childName}}'s trial \u2014 here's what you've built.",
    htmlBody: `<style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, sans-serif;
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
.ps b { font-weight: 700; }</style>
<p>Hi {{parentName}},</p>
<p>You started {{childName}}'s 30-day trial four weeks ago. Quick stocktake of what you've built:</p>
<p>•  A rolling <strong>weakness map</strong> — every quiz, focused practice, and paper {{childName}} has done feeds this. Both Science topics and English rules.</p>
<p>•  A <strong>mistake history</strong> going back 4 weeks, one click to retrieve</p>
<p>•  An <strong>auto-revision queue</strong> — questions from the last 30 days, scheduled to resurface at the right intervals</p>
<p>•  <strong>Marked papers + parent-review notes</strong> for everything you've submitted</p>
<p>•  Access to our <strong>Master Class library</strong> — 4-minute narrated workshops covering every PSLE sub-topic, weighted toward the highest-frequency topics we shared in Email 2. When {{childName}} misses a Mastery Quiz question, the system surfaces the exact concept video that fixes it — micro-learning at the moment of need, on the MRT home from school.</p>
<div class="todo">📸 <b>SCREENSHOT TO PASTE:</b> Screenshot: a Master Class slide in playback view (with TTS-highlighted bullet) + the "Recommended for {{childName}}" list of sub-topic workshops. Master Class is the feature beta parents reported they couldn't live without by week 4 — show it here.</div>
<p>Most of this stays valuable only if it keeps updating. The weakness map is only accurate while new marked work feeds it. The auto-revision queue only works if new practices keep being set. The Focused Practices are only useful if the system can keep generating them. And the Master Class library is most powerful when paired with the live weakness picture pointing {{childName}} to the right 4 minutes of content at the right time.</p>
<p>That's what a paid plan is — it's not "unlocking new things," it's <strong>keeping the things you've already built actually working through to PSLE</strong>.</p>
<p><strong>Two days from now, your trial ends.</strong> If you don't upgrade, the data we've built for {{childName}} stays read-only — you can still look at the past month's marked work, but new assignments, new marking, and new Focused Tests pause.</p>
<p>If MarkForYou has earned its keep this month, here's what we'd suggest:</p>
<p class="cta">👉 <strong>Pick the plan that fits {{childName}}'s year → {{pricingUrl}}</strong></p>
<p>Plans start at <strong>{{priceText}}</strong>, fully refundable in the first 30 days if it doesn't work out. Most of our parents are on the annual plan — one decision, one payment, the system keeps running through PSLE.</p>
<p>If MarkForYou hasn't been useful this month, we genuinely want to know why. The fastest way to help us is to reply to this email with one specific thing that didn't land for {{childName}} or for you. We read every reply.</p>
<p>Either way — thank you for trying us. The PSLE journey is long. We hope we've made it a little less stressful.</p>
<p>Warmly,</p>
<p class="signoff-name">Jessica</p>
<p class="signoff-role">Co-Founder, MarkForYou</p>
<div class="ps"><b>P.S.</b> A final clickbait for {{childName}} before they head off to school tomorrow:<br> <br> Q. <em>My teacher has asked Sally and ____ to help out with the class decoration.</em><br> (1) I   (2) me   (3) mine   (4) myself<br> <br> Most kids pick (1) "I" — sounds more formal. Correct answer is <strong>(2) me</strong>.<br> <br> The trick: hide "Sally and" with your thumb. "My teacher has asked ___ to help." Suddenly it's obvious — "asked me to help," not "asked I." This one move fixes a whole family of pronoun MCQs in PSLE English.<br></div>`,
    textBody: `Hi {{parentName}},

You started {{childName}}'s 30-day trial four weeks ago. Quick stocktake of what you've built:

•  A rolling weakness map — every quiz, focused practice, and paper {{childName}} has done feeds this. Both Science topics and English rules.

•  A mistake history going back 4 weeks, one click to retrieve

•  An auto-revision queue — questions from the last 30 days, scheduled to resurface at the right intervals

•  Marked papers + parent-review notes for everything you've submitted

•  Access to our Master Class library — 4-minute narrated workshops covering every PSLE sub-topic, weighted toward the highest-frequency topics we shared in Email 2. When {{childName}} misses a Mastery Quiz question, the system surfaces the exact concept video that fixes it — micro-learning at the moment of need, on the MRT home from school.

[SCREENSHOT TO PASTE: Screenshot: a Master Class slide in playback view (with TTS-highlighted bullet) + the "Recommended for {{childName}}" list of sub-topic workshops. Master Class is the feature beta parents reported they couldn't live without by week 4 — show it here.]

Most of this stays valuable only if it keeps updating. The weakness map is only accurate while new marked work feeds it. The auto-revision queue only works if new practices keep being set. The Focused Practices are only useful if the system can keep generating them. And the Master Class library is most powerful when paired with the live weakness picture pointing {{childName}} to the right 4 minutes of content at the right time.

That's what a paid plan is — it's not "unlocking new things," it's keeping the things you've already built actually working through to PSLE.

Two days from now, your trial ends. If you don't upgrade, the data we've built for {{childName}} stays read-only — you can still look at the past month's marked work, but new assignments, new marking, and new Focused Tests pause.

If MarkForYou has earned its keep this month, here's what we'd suggest:

👉 Pick the plan that fits {{childName}}'s year → {{pricingUrl}}

Plans start at {{priceText}}, fully refundable in the first 30 days if it doesn't work out. Most of our parents are on the annual plan — one decision, one payment, the system keeps running through PSLE.

If MarkForYou hasn't been useful this month, we genuinely want to know why. The fastest way to help us is to reply to this email with one specific thing that didn't land for {{childName}} or for you. We read every reply.

Either way — thank you for trying us. The PSLE journey is long. We hope we've made it a little less stressful.

Warmly,

Jessica
Co-Founder, MarkForYou

P.S. A final clickbait for {{childName}} before they head off to school tomorrow:

Q. My teacher has asked Sally and ____ to help out with the class decoration.
(1) I   (2) me   (3) mine   (4) myself

Most kids pick (1) "I" — sounds more formal. Correct answer is (2) me.

The trick: hide "Sally and" with your thumb. "My teacher has asked ___ to help." Suddenly it's obvious — "asked me to help," not "asked I." This one move fixes a whole family of pronoun MCQs in PSLE English.`,
  },
  {
    id: "onboarding-day35",
    emailNumber: 9,
    title: "Email 9 \u00b7 Day 35 \u00b7 and an open door for {{childName}} later in the year.",
    variant: undefined,
    trigger: { kind: 'signup_age', days: 35 },
    subject: "No hard feelings \u2014 and an open door for {{childName}} later in the year.",
    htmlBody: `<style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, sans-serif;
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
.ps b { font-weight: 700; }</style>
<p>Hi {{parentName}},</p>
<p>{{childName}}'s 30-day trial ended last week. You didn't upgrade — and that's a totally fair decision. There are a lot of tools fighting for your attention, and not every one fits every family.</p>
<p>Three quick notes before we leave you alone:</p>
<p><strong>1.  The data we built is still there.</strong> {{childName}}'s weakness picture, the marked papers, the mistake history — all of it stays in your account, read-only. If you ever come back, the system picks up exactly where it left off.</p>
<p><strong>2.  PSLE moments where parents often come back.</strong> SA1 (April–May), the mid-year revision push (June–July), prelim season (August–September). Those are the windows where "where is {{childName}} actually losing marks?" suddenly becomes the most important question of the term. We've left the door wide open.</p>
<p><strong>3.  Fresh 7-day re-trial, whenever you want it.</strong> Just reply to this email with when you'd like it switched back on. No conditions, no card needed, no nudging — we'll activate the account for a week around the exam that matters most.</p>
<p>If MarkForYou didn't work for you this time, we'd genuinely value knowing why. The fastest way to improve the next version of the product is parents like you telling us what didn't land — for {{childName}} or for you.</p>
<p class="cta">👉 <strong>Reply with one sentence:</strong> what didn't work, <em>or</em> when you'd like a fresh 7-day trial activated.</p>
<p>Either way — thank you for trying us. The PSLE journey is long, and we hope {{childName}} has a smooth year ahead. With or without MarkForYou.</p>
<p>Warmly,</p>
<p class="signoff-name">Jessica</p>
<p class="signoff-role">Co-Founder, MarkForYou</p>
<div class="ps"><b>P.S.</b> If you happened to land on a paid plan elsewhere and don't need us, ignore this — and good luck with the rest of {{childName}}'s prep. We mean it.<br></div>`,
    textBody: `Hi {{parentName}},

{{childName}}'s 30-day trial ended last week. You didn't upgrade — and that's a totally fair decision. There are a lot of tools fighting for your attention, and not every one fits every family.

Three quick notes before we leave you alone:

1.  The data we built is still there. {{childName}}'s weakness picture, the marked papers, the mistake history — all of it stays in your account, read-only. If you ever come back, the system picks up exactly where it left off.

2.  PSLE moments where parents often come back. SA1 (April–May), the mid-year revision push (June–July), prelim season (August–September). Those are the windows where "where is {{childName}} actually losing marks?" suddenly becomes the most important question of the term. We've left the door wide open.

3.  Fresh 7-day re-trial, whenever you want it. Just reply to this email with when you'd like it switched back on. No conditions, no card needed, no nudging — we'll activate the account for a week around the exam that matters most.

If MarkForYou didn't work for you this time, we'd genuinely value knowing why. The fastest way to improve the next version of the product is parents like you telling us what didn't land — for {{childName}} or for you.

👉 Reply with one sentence: what didn't work, or when you'd like a fresh 7-day trial activated.

Either way — thank you for trying us. The PSLE journey is long, and we hope {{childName}} has a smooth year ahead. With or without MarkForYou.

Warmly,

Jessica
Co-Founder, MarkForYou

P.S. If you happened to land on a paid plan elsewhere and don't need us, ignore this — and good luck with the rest of {{childName}}'s prep. We mean it.`,
  },
  {
    id: "onboarding-pu14-e10",
    emailNumber: 10,
    title: "Email 10 \u00b7 +PU14 \u00b7 and a thank-you tied to it.",
    variant: undefined,
    trigger: { kind: 'post_upgrade', days: 14 },
    subject: "{{parentName}}, a small ask \u2014 and a thank-you tied to it.",
    htmlBody: `<style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, sans-serif;
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
.ps b { font-weight: 700; }</style>
<p>Hi {{parentName}},</p>
<p>Quick check-in: you've been on a paid plan for about two weeks now. Hopefully {{childName}}'s weakness map has sharpened a notch or two, you've explored Master Class, and the per-question feedback has started feeling routine rather than novel.</p>
<p>If any of that's true, we have a small ask. And it comes with a thank-you tied to it.</p>
<p><strong>The most common question we get from happy parents is: "Do you have a referral program? My friend just asked."</strong> Until recently, the answer was "not yet." Now it is.</p>
<p><strong>Here's how it works:</strong></p>
<p>•  Share your unique link with another parent who's in the PSLE prep stretch (P5 or P6).</p>
<p>•  When they sign up and try MarkForYou, they get <strong>1 month free</strong> added to their trial.</p>
<p>•  When they convert to paid, you get <strong>1 month free</strong> on your plan — automatically applied to your next billing cycle.</p>
<p>•  No cap. Refer 3 friends who convert, you get 3 months free.</p>
<p>Why we're asking <em>now</em>, two weeks into your paid usage: this is the window where you've seen enough of how the system works to know whether it's worth telling someone else about — but the experience is still fresh enough that the recommendation lands authentically. Cold recommendations 6 months from now feel forced. Warm ones in week 2 of paid usage land.</p>
<p>And honestly — the only reason MarkForYou exists in its current form is because beta parents told friends. Word of mouth from P5/P6 parent groups is how this product reaches the families that need it most. We'd love your help reaching the next one.</p>
<p class="cta">👉 <strong>Get your referral link → {{childHomepageUrl}} → Account → "Refer a friend"</strong></p>
<p>If MarkForYou isn't your style to recommend yet — that's a useful signal too. Reply and tell us the one thing that's stopping you from recommending it. We read every reply, and we use them to improve the next version.</p>
<p>Either way, thanks for being on the journey with us. {{childName}}'s PSLE year just got 1 paid month into it. The next 10 months are where the system really earns its keep.</p>
<p>Warmly,</p>
<p class="signoff-name">Jessica</p>
<p class="signoff-role">Co-Founder, MarkForYou</p>
<div class="ps"><b>P.S.</b> <strong>Heads-up for whoever sets this up:</strong> the referral program details above (1 month + 1 month, no cap, auto-applied) are a <em>placeholder</em>. Replace with the actual offer once the referral program is finalised — and make sure the unique referral link path works on the {{childHomepageUrl}} → Account page before sending.<br></div>`,
    textBody: `Hi {{parentName}},

Quick check-in: you've been on a paid plan for about two weeks now. Hopefully {{childName}}'s weakness map has sharpened a notch or two, you've explored Master Class, and the per-question feedback has started feeling routine rather than novel.

If any of that's true, we have a small ask. And it comes with a thank-you tied to it.

The most common question we get from happy parents is: "Do you have a referral program? My friend just asked." Until recently, the answer was "not yet." Now it is.

Here's how it works:

•  Share your unique link with another parent who's in the PSLE prep stretch (P5 or P6).

•  When they sign up and try MarkForYou, they get 1 month free added to their trial.

•  When they convert to paid, you get 1 month free on your plan — automatically applied to your next billing cycle.

•  No cap. Refer 3 friends who convert, you get 3 months free.

Why we're asking now, two weeks into your paid usage: this is the window where you've seen enough of how the system works to know whether it's worth telling someone else about — but the experience is still fresh enough that the recommendation lands authentically. Cold recommendations 6 months from now feel forced. Warm ones in week 2 of paid usage land.

And honestly — the only reason MarkForYou exists in its current form is because beta parents told friends. Word of mouth from P5/P6 parent groups is how this product reaches the families that need it most. We'd love your help reaching the next one.

👉 Get your referral link → {{childHomepageUrl}} → Account → "Refer a friend"

If MarkForYou isn't your style to recommend yet — that's a useful signal too. Reply and tell us the one thing that's stopping you from recommending it. We read every reply, and we use them to improve the next version.

Either way, thanks for being on the journey with us. {{childName}}'s PSLE year just got 1 paid month into it. The next 10 months are where the system really earns its keep.

Warmly,

Jessica
Co-Founder, MarkForYou

P.S. Heads-up for whoever sets this up: the referral program details above (1 month + 1 month, no cap, auto-applied) are a placeholder. Replace with the actual offer once the referral program is finalised — and make sure the unique referral link path works on the {{childHomepageUrl}} → Account page before sending.`,
  },
];

export const WELCOME_EMAIL: NurtureEmail =
  NURTURE_EMAILS.find((e) => e.trigger.kind === 'signup') as NurtureEmail;
