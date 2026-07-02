// What's New popup queue. Each popup has a unique id that gets appended
// to `user.settings.whatsNewSeenIds` when the user dismisses it — so
// shipping a NEW popup does not overwrite an OLD one: users who signed
// up before you shipped popup B still walk through popup A first.
//
// Cadence rules the component enforces (see WhatsNewPopup.tsx):
//   • Oldest unseen popup fires first (sorted by shipDate ascending).
//   • Max one popup per user per 24 h — tracked via
//     `user.settings.whatsNewLastShownAt`. On day 1 a fresh user sees
//     the oldest; on day 2 they see the next; etc.
//   • `audience` gates by dashboard (parent / student / all).
//   • `adminOnly` gates to admins during dogfood — flip false to open.
//
// When shipping a new popup:
//   1. Append a new entry to WHATS_NEW_POPUPS with a fresh id + today's
//      shipDate (YYYY-MM-DD).
//   2. Do NOT edit or remove existing entries — that's the whole point
//      of the queue.
//   3. Set adminOnly=true first to dogfood; flip false when ready.

export type WhatsNewAudience = "all" | "parent" | "student";

export type WhatsNewSlide = {
  eyebrow?: string;
  title: string;
  body: string;
  imageSrc?: string;   // /public path — recommended 800x450 PNG (16:9), ≤80 KB
  imageAlt?: string;
};

export type WhatsNewPopupConfig = {
  // Unique id — never reuse or rename. Written to
  // user.settings.whatsNewSeenIds on dismiss.
  id: string;
  // ISO date (YYYY-MM-DD) — used to sort the queue. Oldest first.
  shipDate: string;
  audience: WhatsNewAudience;
  adminOnly: boolean;
  // Short branding shown as the header on slides 2+ (e.g. "Essay
  // Coach"). Slide 1 always shows "What's New". Falls back to
  // nothing on slides 2+ if unset.
  featureName?: string;
  // Optional Google Material Symbol name for the header on slides
  // 2+. Uses the same colour tokens as the "What's New" wordmark.
  featureIcon?: string;
  slides: WhatsNewSlide[];
};

// Preview override: admin can add ?whatsnew=preview to any home URL to
// force-render the FIRST matching popup, ignoring seenIds + throttle.
// Handy for iterating on copy / images without touching the DB.
export const WHATS_NEW_PREVIEW_QUERY_KEY = "whatsnew";
export const WHATS_NEW_PREVIEW_QUERY_VALUE = "preview";

// 24h between popups per user, matching the "max one What's New per day"
// rule. Preview URL bypasses this.
export const WHATS_NEW_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

// {{childName}} in title/body/eyebrow is substituted by the popup
// component at render time. Falls back to "your child" when no student
// is available (e.g. a parent who hasn't linked anyone yet).

export const WHATS_NEW_POPUPS: WhatsNewPopupConfig[] = [
  {
    id: "essay-coach-v1",
    shipDate: "2026-07-02",
    audience: "all",
    adminOnly: false,
    featureName: "Essay Coach",
    featureIcon: "edit_document",
    slides: [
      {
        eyebrow: "New",
        title: "Essay / 作文 Coach",
        body: "Upgrade {{childName}}'s essays to model-essay level. Same story, same voice — with the vocabulary, structure, and detail that PSLE markers are looking for.",
        imageSrc: "/whats-new/essay-coach/essay_intro.png",
        imageAlt: "Essay Coach welcome — 27 to 38 marks",
      },
      {
        eyebrow: "Upload / scan",
        title: "Rubric score in 3 minutes",
        body: "Upload or scan an existing essay. Within three minutes Lumi gives a full rubric-aligned score AND two versions: tracked mistakes and an enhanced version.",
        imageSrc: "/whats-new/essay-coach/essay_upload.png",
        imageAlt: "Rubric score + tracked + enhanced versions side-by-side",
      },
      {
        eyebrow: "In-line suggestions",
        title: "Surgical edits, not a rewrite",
        body: "Lumi suggests targeted edits to structure, vocabulary, sentence variety, connectors, opening and closing — the things PSLE markers are looking for.",
        imageSrc: "/whats-new/essay-coach/essay_inline.png",
        imageAlt: "In-line coloured suggestions on the enhanced draft",
      },
      {
        eyebrow: "Choose your own enhancement",
        title: "Keep it sounding like {{childName}}",
        body: "Don't like a suggestion? Tap to pick an alternative that fits {{childName}}'s voice. Print or export the final version to practise on.",
        imageSrc: "/whats-new/essay-coach/essay_choose.png",
        imageAlt: "Alternative phrasing picker with print / export controls",
      },
      {
        eyebrow: "Where to find it",
        title: "In your sidebar",
        body: "Look for the Essay Coach — a model essay in {{childName}}'s voice.",
        imageSrc: "/whats-new/essay-coach/essay_where.png",
        imageAlt: "Essay Coach sidebar entry highlighted",
      },
    ],
  },
];

// Given a viewer's dashboard + admin flag + persisted state, return the
// first popup they should see right now — or null if none apply.
// Preview-URL callers can pass `preview: true` to bypass seenIds + the
// 24h throttle.
export function pickNextWhatsNewPopup(args: {
  viewer: WhatsNewAudience;
  viewerIsAdmin: boolean;
  seenIds: string[];
  lastShownAtMs: number;   // 0 if never
  now: number;
  preview: boolean;
}): WhatsNewPopupConfig | null {
  const { viewer, viewerIsAdmin, seenIds, lastShownAtMs, now, preview } = args;
  const seen = new Set(seenIds);
  const throttled = !preview && (now - lastShownAtMs < WHATS_NEW_MIN_INTERVAL_MS);
  if (throttled) return null;
  const eligible = WHATS_NEW_POPUPS
    .filter(p => p.audience === "all" || p.audience === viewer)
    .filter(p => !p.adminOnly || viewerIsAdmin)
    .filter(p => preview || !seen.has(p.id))
    .sort((a, b) => a.shipDate.localeCompare(b.shipDate));
  return eligible[0] ?? null;
}
