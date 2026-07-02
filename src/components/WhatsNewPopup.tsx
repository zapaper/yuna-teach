"use client";

import { useEffect, useMemo, useState } from "react";
import {
  WHATS_NEW_POPUPS,
  WHATS_NEW_PREVIEW_QUERY_KEY,
  WHATS_NEW_PREVIEW_QUERY_VALUE,
  pickNextWhatsNewPopup,
  type WhatsNewAudience,
  type WhatsNewSlide,
} from "@/lib/whats-new";

// Shows the oldest unseen What's New popup for the current user, at most
// one per 24 h. State lives server-side in `user.settings`:
//   • whatsNewSeenIds:      string[]  — every popup id the user has dismissed
//   • whatsNewLastShownAt:  ISO string — 24 h throttle anchor
// Persisted through the existing PATCH /api/users endpoint, so switching
// device / clearing cookies doesn't resurface popups they already saw.

function fillTemplate(text: string | undefined, childName: string): string {
  if (!text) return "";
  return text.split("{{childName}}").join(childName);
}

export default function WhatsNewPopup({
  userId,
  seenIds,
  lastShownAt,
  viewer,
  childName,
  viewerIsAdmin,
}: {
  userId: string;
  seenIds?: string[] | null;
  lastShownAt?: string | null;
  // Which dashboard is mounting this. Compared against each popup's
  // `audience` (parent / student / all) so a parent-only popup doesn't
  // fire on the student home page.
  viewer: WhatsNewAudience;
  // Substituted in for {{childName}}. Parent dashboards pass the first
  // linked kid's display name; student dashboard passes the student's
  // own first name. Falls back to "your child" so the copy still reads
  // when a parent hasn't linked anyone yet.
  childName?: string | null;
  // Whether the current session user is admin. Popups with
  // adminOnly=true only fire when this is true.
  viewerIsAdmin?: boolean;
}) {
  const filledChildName = (childName ?? "").trim() || "your child";

  // Preview override: admin can add ?whatsnew=preview to any home URL to
  // force-render the FIRST matching popup, ignoring seenIds + throttle.
  // Handy for iterating on copy / images without touching DB. Kept
  // admin-gated so parents can't accidentally trigger a re-show.
  const preview = useMemo(() => {
    if (typeof window === "undefined") return false;
    if (viewerIsAdmin !== true) return false;
    return new URLSearchParams(window.location.search).get(WHATS_NEW_PREVIEW_QUERY_KEY) === WHATS_NEW_PREVIEW_QUERY_VALUE;
  }, [viewerIsAdmin]);

  // Resolve the popup to show ONCE at mount so seenIds updating (after
  // dismissal) doesn't yank the modal mid-render. Everything after this
  // point either uses `popup` or is a no-op.
  const popup = useMemo(() => {
    const lastShownAtMs = lastShownAt ? Date.parse(lastShownAt) || 0 : 0;
    return pickNextWhatsNewPopup({
      viewer,
      viewerIsAdmin: viewerIsAdmin === true,
      seenIds: seenIds ?? [],
      lastShownAtMs,
      now: Date.now(),
      preview,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    if (!popup) return;
    // Small delay so the modal doesn't fight for paint on first load —
    // dashboards do a lot in the first ~200 ms.
    const t = setTimeout(() => setOpen(true), 350);
    return () => clearTimeout(t);
  }, [popup]);

  if (!popup || !open) return null;

  const slide: WhatsNewSlide = popup.slides[idx];
  const isLast = idx === popup.slides.length - 1;

  async function markSeen() {
    if (!popup) return;
    // In preview mode we DO NOT persist — the whole point is to iterate
    // without touching the seen list.
    if (preview) return;
    // Merge new id + timestamp into the existing seenIds array so we
    // don't clobber older popups the user has already dismissed. The
    // PATCH endpoint deep-merges settings for us, but the array itself
    // is replaced (JSON merge is shallow), so we compute the full new
    // array client-side.
    const merged = Array.from(new Set([...(seenIds ?? []), popup.id]));
    try {
      await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          settings: {
            whatsNewSeenIds: merged,
            whatsNewLastShownAt: new Date().toISOString(),
          },
        }),
      });
    } catch { /* ignore — next login will re-check */ }
  }

  function close() {
    if (dismissing) return;
    setDismissing(true);
    void markSeen();
    // Fade out for 180 ms so the dismiss doesn't feel abrupt.
    setTimeout(() => setOpen(false), 180);
  }

  function next() {
    if (isLast) { close(); return; }
    setIdx(i => i + 1);
  }

  return (
    <div
      className={`fixed inset-0 z-[70] flex items-center justify-center p-4 transition-opacity duration-200 ${dismissing ? "opacity-0" : "opacity-100"}`}
      style={{ background: "rgba(2, 6, 23, 0.55)", backdropFilter: "blur(4px)" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="whats-new-title"
    >
      <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header band. Slide 1 shows "What's New" with a sparkle so the
            popup reads like a magazine cover. Slides 2+ swap to the
            feature name (e.g. "Essay Coach") so the whole popup stays
            branded to the feature we're pushing. Always rendered when
            we have a label — that also gives the card top-spacing so
            the image never sits flush against the rounded corner. */}
        {(() => {
          const isFirst = idx === 0;
          const label = isFirst ? "What's New" : (popup.featureName ?? "");
          const iconName = isFirst ? "auto_awesome" : (popup.featureIcon ?? "");
          if (!label) return null;
          return (
            <div className="px-7 pt-5 pb-3 flex items-center gap-2 border-b border-slate-100">
              {iconName ? (
                <span
                  className="material-symbols-outlined text-[18px] text-[#0EA371]"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  {iconName}
                </span>
              ) : null}
              <span className="text-[13px] font-extrabold uppercase tracking-widest text-[#001e40]">
                {label}
              </span>
            </div>
          );
        })()}
        {/* Optional image band */}
        {slide.imageSrc ? (
          <div className="w-full aspect-[16/9] bg-slate-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={slide.imageSrc}
              alt={slide.imageAlt ?? ""}
              className="w-full h-full object-cover"
            />
          </div>
        ) : null}

        <div className="p-7">
          {slide.eyebrow ? (
            <p className="text-[11px] font-extrabold uppercase tracking-widest text-[#0EA371] mb-2">
              {fillTemplate(slide.eyebrow, filledChildName)}
            </p>
          ) : null}
          <h2
            id="whats-new-title"
            className="text-2xl font-headline font-extrabold text-[#001e40] mb-3 leading-tight"
          >
            {fillTemplate(slide.title, filledChildName)}
          </h2>
          <p className="text-[15px] text-[#43474f] leading-relaxed">
            {fillTemplate(slide.body, filledChildName)}
          </p>

          {/* Progress dots */}
          {popup.slides.length > 1 ? (
            <div className="flex items-center justify-center gap-1.5 mt-6">
              {popup.slides.map((_, i) => (
                <span
                  key={i}
                  className={`h-1.5 rounded-full transition-all ${
                    i === idx ? "w-6 bg-[#003366]" : "w-1.5 bg-slate-300"
                  }`}
                />
              ))}
            </div>
          ) : null}

          <div className="flex items-center justify-between mt-6">
            <button
              type="button"
              onClick={close}
              className="text-sm font-semibold text-slate-500 hover:text-slate-700 px-2 py-1"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={next}
              className="px-5 py-2.5 rounded-full bg-[#003366] text-white font-bold text-sm hover:bg-[#001e40] transition-colors"
            >
              {isLast ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
