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

export const WHATS_NEW_VERSION = "essay-coach-v1";

// Who sees this popup. "parent" hides it from kids (e.g. Essay Coach is a
// parent-side upload flow); "student" hides it from parents; "all" shows
// it on both dashboards.
export type WhatsNewAudience = "all" | "parent" | "student";
export const WHATS_NEW_AUDIENCE: WhatsNewAudience = "parent";

export type WhatsNewSlide = {
  eyebrow?: string;
  title: string;
  body: string;
  imageSrc?: string;   // /public path — recommended 800x450 PNG (16:9), ≤80 KB
  imageAlt?: string;
};

// Essay Coach launch popup. Structure: what → 3 features → where.
// Screenshots live under /public/whats-new/essay-coach/. Filenames match
// the imageSrc paths below — drop new PNGs at those paths to update.
// Recommended: 800x450 PNG, ≤80 KB.
export const WHATS_NEW_SLIDES: WhatsNewSlide[] = [
  {
    eyebrow: "New",
    title: "27 marks. Then 38.",
    body: "Same story, same voice — but stronger vocabulary, tighter sentences, deeper emotional detail. That's Essay Coach.",
    imageSrc: "/whats-new/essay-coach/1-what.png",
    imageAlt: "Essay Coach: 27 to 38 marks side-by-side",
  },
  {
    eyebrow: "Instant score",
    title: "MOE rubric marks in 3 minutes",
    body: "Upload handwritten or typed. Three minutes later your child gets a full rubric-aligned score — content, language, organisation.",
    imageSrc: "/whats-new/essay-coach/2-rubric.png",
    imageAlt: "Rubric-aligned score breakdown",
  },
  {
    eyebrow: "Clean rewrite",
    title: "Errors fixed. Voice kept.",
    body: "A clean version of the essay with typos corrected and awkward phrasing tightened. Still their essay, still their voice — just without the marks they were quietly losing.",
    imageSrc: "/whats-new/essay-coach/3-rewrite.png",
    imageAlt: "Clean rewrite alongside the original",
  },
  {
    eyebrow: "Enhanced draft",
    title: "See a top-scoring version",
    body: "The additions are in green — a richer opening, varied sentences, deeper detail. If a suggestion doesn't feel natural, tap for an alternative phrase that fits.",
    imageSrc: "/whats-new/essay-coach/4-enhanced.png",
    imageAlt: "Enhanced draft with green additions",
  },
  {
    eyebrow: "Where to find it",
    title: "In your sidebar",
    body: "Look for the Essay Coach entry in the parent dashboard sidebar. English and Chinese, continuous and situational. Free during beta.",
    imageSrc: "/whats-new/essay-coach/5-where.png",
    imageAlt: "Essay Coach sidebar entry",
  },
];
