// What's New popup content. Bumping WHATS_NEW_VERSION re-shows the popup
// once for every user (parent + student) on their next home-page load.
// The seen-version is persisted per user in `user.settings.whatsNewSeenVersion`
// so switching device / clearing cookies does NOT resurface it.
//
// Style: title short, body 1-2 short sentences, PSLE-parent voice. Keep
// 2-4 slides — more than that reads as a changelog and gets skipped.
//
// When shipping a new popup:
//   1. Bump WHATS_NEW_VERSION (ISO date + suffix)
//   2. Replace the slides below
//   3. That's it — no migration, no back-compat code

export const WHATS_NEW_VERSION = "2026-07-02-v1";

export type WhatsNewSlide = {
  eyebrow?: string;
  title: string;
  body: string;
  imageSrc?: string;   // optional /public path
  imageAlt?: string;
};

export const WHATS_NEW_SLIDES: WhatsNewSlide[] = [
  {
    eyebrow: "New",
    title: "Diagnostic quiz + Lumi report",
    body: "Your child's first quiz now unlocks a preliminary diagnosis — topic strengths, weak areas, and a personalised study plan from Lumi, our owl assistant.",
  },
  {
    eyebrow: "New",
    title: "Grammar fluency for English",
    body: "English quizzes now show which grammar rules your child has mastered and which need more practice, broken down by sub-topic.",
  },
  {
    eyebrow: "Improved",
    title: "Highlight text in quizzes",
    body: "Students can now highlight questions with their finger or mouse — the marks stay when they move on, then clear when the paper is submitted.",
  },
];
