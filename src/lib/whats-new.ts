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

// Staged rollout: when true, the popup ONLY fires for admin users, even
// if the audience matches. Flip to false to release to all matching users.
// Keeps a new popup safely dogfoodable on prod before it goes wide.
export const WHATS_NEW_ADMIN_ONLY = true;

export type WhatsNewSlide = {
  eyebrow?: string;
  title: string;
  body: string;
  imageSrc?: string;   // /public path — recommended 800x450 PNG (16:9), ≤80 KB
  imageAlt?: string;
};

// Essay Coach launch popup. 4 slides: hook → three feature panels.
// {{childName}} in title/body is substituted by the popup component at
// render time using the parent's selected student. If no child is
// linked yet, it falls back to "your child" so the copy still reads.
// Screenshots live under /public/whats-new/essay-coach/. Recommended:
// 800x450 PNG, ≤80 KB each.
export const WHATS_NEW_SLIDES: WhatsNewSlide[] = [
  {
    eyebrow: "New",
    title: "Essay / 作文 Coach",
    body: "Upgrade {{childName}}'s essays to model-essay level. Same story, same voice — with the vocabulary, structure, and detail that PSLE markers are looking for.",
    imageSrc: "/whats-new/essay-coach/1-what.png",
    imageAlt: "Essay Coach welcome — 27 to 38 marks",
  },
  {
    eyebrow: "Upload / scan",
    title: "Rubric score in 3 minutes",
    body: "Upload or scan an existing essay. Within three minutes Lumi gives a full rubric-aligned score AND two versions: tracked mistakes and an enhanced version.",
    imageSrc: "/whats-new/essay-coach/2-upload.png",
    imageAlt: "Rubric score + tracked + enhanced versions side-by-side",
  },
  {
    eyebrow: "In-line suggestions",
    title: "Surgical edits, not a rewrite",
    body: "Lumi suggests targeted edits to structure, vocabulary, sentence variety, connectors, opening and closing — the things PSLE markers are looking for.",
    imageSrc: "/whats-new/essay-coach/3-inline.png",
    imageAlt: "In-line coloured suggestions on the enhanced draft",
  },
  {
    eyebrow: "Choose your own enhancement",
    title: "Keep it sounding like {{childName}}",
    body: "Don't like a suggestion? Tap to pick an alternative that fits {{childName}}'s voice. Print or export the final version to practise on.",
    imageSrc: "/whats-new/essay-coach/4-choose.png",
    imageAlt: "Alternative phrasing picker with print / export controls",
  },
  {
    eyebrow: "Where to find it",
    title: "In your sidebar",
    body: "Look for the Essay Coach — a model essay in {{childName}}'s voice.",
    imageSrc: "/whats-new/essay-coach/5-where.png",
    imageAlt: "Essay Coach sidebar entry highlighted",
  },
];
