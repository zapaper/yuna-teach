"use client";

import { useEffect, useState } from "react";
import { WHATS_NEW_VERSION, WHATS_NEW_SLIDES, WHATS_NEW_AUDIENCE, WHATS_NEW_ADMIN_ONLY, type WhatsNewSlide, type WhatsNewAudience } from "@/lib/whats-new";

// Shows the What's New carousel exactly once per user, per WHATS_NEW_VERSION.
// State lives in `user.settings.whatsNewSeenVersion` server-side — deliberately
// NOT localStorage, so switching device / clearing cookies doesn't resurface it.
//
// Trigger flow:
//   1. Dashboard mounts and renders <WhatsNewPopup userId=... seenVersion={...} />
//   2. If seenVersion !== WHATS_NEW_VERSION, the modal fades in on next tick.
//   3. User steps through Next / Skip → PATCH /api/users writes the new
//      seen-version. Modal unmounts; component stays inert until a future
//      version bump.

// {{childName}} template substitution in title/body/eyebrow. Kept tiny —
// the slides file only uses this one placeholder and a full templating
// engine would be overkill.
function fillTemplate(text: string | undefined, childName: string): string {
  if (!text) return "";
  return text.split("{{childName}}").join(childName);
}

export default function WhatsNewPopup({
  userId,
  seenVersion,
  viewer,
  childName,
  viewerIsAdmin,
}: {
  userId: string;
  seenVersion: string | null | undefined;
  // Which dashboard is mounting this. Compared against WHATS_NEW_AUDIENCE
  // so a parent-only popup doesn't show up on the student home page.
  viewer: WhatsNewAudience;
  // Substituted in for {{childName}}. Parent dashboards pass the first
  // linked kid's display name; student dashboard passes the student's
  // own first name. Falls back to "your child" so the copy still reads
  // when a parent hasn't linked anyone yet.
  childName?: string | null;
  // Whether the current session user is an admin. When
  // WHATS_NEW_ADMIN_ONLY is true, the popup only fires for admins so
  // the copy / images can be dogfooded on prod before going wide.
  viewerIsAdmin?: boolean;
}) {
  const filledChildName = (childName ?? "").trim() || "your child";
  const audienceMatch =
    WHATS_NEW_AUDIENCE === "all" || WHATS_NEW_AUDIENCE === viewer;
  const adminGate = !WHATS_NEW_ADMIN_ONLY || viewerIsAdmin === true;
  // Preview override: admins can force-show the popup via
  // ?whatsnew=preview on any home URL, ignoring the seen-version
  // check. Handy for testing look-and-feel without touching DB. Kept
  // admin-gated even when the popup goes wide, so parents can't
  // accidentally trigger a re-show by tweaking a URL.
  const previewOverride =
    viewerIsAdmin === true &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("whatsnew") === "preview";
  const shouldShow =
    audienceMatch &&
    adminGate &&
    (previewOverride || seenVersion !== WHATS_NEW_VERSION) &&
    WHATS_NEW_SLIDES.length > 0;
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    if (!shouldShow) return;
    // Small delay so the modal doesn't fight for paint on first load —
    // dashboards do a lot in the first ~200 ms.
    const t = setTimeout(() => setOpen(true), 350);
    return () => clearTimeout(t);
  }, [shouldShow]);

  if (!shouldShow || !open) return null;

  const slide: WhatsNewSlide = WHATS_NEW_SLIDES[idx];
  const isLast = idx === WHATS_NEW_SLIDES.length - 1;

  async function markSeen() {
    // Fire-and-forget — even if the PATCH fails, we still close the modal
    // for the current session so the user isn't blocked. The next login
    // will re-check and re-show if the write really failed.
    try {
      await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          settings: { whatsNewSeenVersion: WHATS_NEW_VERSION },
        }),
      });
    } catch { /* ignore */ }
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
          {WHATS_NEW_SLIDES.length > 1 ? (
            <div className="flex items-center justify-center gap-1.5 mt-6">
              {WHATS_NEW_SLIDES.map((_, i) => (
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
