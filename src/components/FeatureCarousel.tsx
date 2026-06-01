"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export type FeatureItem = {
  src: string;
  alt: string;
  title: string;
  description: string;
};

// Infinite-loop carousel. Items are rendered 3 times in a row — the
// middle copy is the "real" one; the flanks let the user scroll past
// either end. After a settled scroll, if the user has crossed into
// a flank we silently snap them to the equivalent slide in the
// middle copy. From the user's perspective the carousel just keeps
// going forever in either direction.
export default function FeatureCarousel({ items }: { items: FeatureItem[] }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const len = items.length;
  const tripled = useMemo(() => [...items, ...items, ...items], [items]);

  // Distance from track scroll-center to a slide's center.
  function distFromCenter(slide: HTMLElement, track: HTMLDivElement): number {
    const slideCenter = slide.offsetLeft + slide.offsetWidth / 2;
    const trackCenter = track.scrollLeft + track.clientWidth / 2;
    return Math.abs(slideCenter - trackCenter);
  }

  // Rendered index closest to the current scroll-center.
  const findClosest = useCallback((): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const slides = Array.from(track.children) as HTMLElement[];
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < slides.length; i++) {
      const d = distFromCenter(slides[i], track);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }, []);

  // Scroll the track horizontally to centre a given slide. No page
  // scroll — only the track's scrollLeft moves.
  function scrollToIdx(idx: number, smooth: boolean) {
    const track = trackRef.current;
    if (!track) return;
    const slides = Array.from(track.children) as HTMLElement[];
    const target = slides[idx];
    if (!target) return;
    const left = target.offsetLeft - (track.clientWidth - target.offsetWidth) / 2;
    track.scrollTo({ left, behavior: smooth ? "smooth" : "auto" });
  }

  // Initial mount: position the scroll at the start of the middle copy
  // BEFORE first paint so the user never sees the left-flank clones.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track || len === 0) return;
    const slides = Array.from(track.children) as HTMLElement[];
    const startOfMiddle = slides[len];
    if (startOfMiddle) {
      track.scrollLeft = startOfMiddle.offsetLeft - (track.clientWidth - startOfMiddle.offsetWidth) / 2;
    }
  }, [len]);

  // Update the active dot in real time during scroll, AND silently snap
  // to the middle copy as soon as scroll fully stops if we've crossed
  // into a flank. Uses the scrollend event on modern browsers (fires
  // exactly when the user's swipe finishes) with a 200ms timer fallback
  // for older browsers that don't support scrollend.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let fallbackTimer: number | undefined;
    let snapping = false;

    function settleIfFlank() {
      if (!track) return;
      if (snapping) { snapping = false; return; }
      const c = findClosest();
      if (c < len || c >= 2 * len) {
        const realIdx = ((c % len) + len) % len;
        snapping = true;
        scrollToIdx(realIdx + len, false);
      }
    }

    function onScroll() {
      const closest = findClosest();
      setActive(((closest % len) + len) % len);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      fallbackTimer = window.setTimeout(settleIfFlank, 200);
    }

    function onScrollEnd() {
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = undefined; }
      settleIfFlank();
    }

    track.addEventListener("scroll", onScroll, { passive: true });
    track.addEventListener("scrollend", onScrollEnd, { passive: true });
    return () => {
      track.removeEventListener("scroll", onScroll);
      track.removeEventListener("scrollend", onScrollEnd);
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
  }, [findClosest, len]);

  // Arrow click: step by ±1 slides relative to the user's current
  // visible position (not relative to `active` — they may have swiped
  // mid-update).
  function step(delta: number) {
    scrollToIdx(findClosest() + delta, true);
  }

  // Dot click: jump to the nearest rendered copy of the chosen real
  // index so the animation distance is short.
  function jumpToReal(realIdx: number) {
    const closest = findClosest();
    const candidates = [realIdx, realIdx + len, realIdx + 2 * len];
    let bestIdx = candidates[1], bestDist = Infinity;
    for (const c of candidates) {
      const d = Math.abs(c - closest);
      if (d < bestDist) { bestDist = d; bestIdx = c; }
    }
    scrollToIdx(bestIdx, true);
  }

  return (
    <div className="relative">
      <div
        ref={trackRef}
        className="flex overflow-x-auto snap-x snap-mandatory gap-5 lg:gap-8 scroll-smooth pb-2 -mx-6 px-6 lg:mx-0 lg:px-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        {tripled.map((it, i) => {
          const isClone = i < len || i >= 2 * len;
          return (
            <article
              key={i}
              aria-hidden={isClone}
              className="relative bg-surface-container-low rounded-3xl shadow-lg overflow-hidden snap-center shrink-0 w-[80vw] sm:w-[320px] md:w-[400px] lg:w-[520px] aspect-square"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt={it.alt}
                className="absolute inset-0 w-full h-full object-contain p-2 pt-20 lg:pt-28"
                src={it.src}
              />
              {/* Compact, uniform-height header. line-clamp keeps over-
                  flow silent so longer copy doesn't bleed past the strip. */}
              <div className="absolute top-0 left-0 right-0 bg-primary text-white px-4 py-2 lg:px-6 lg:py-3 z-10 h-20 lg:h-28 overflow-hidden flex flex-col justify-start">
                <h3 className="font-headline text-sm md:text-base lg:text-lg font-bold mb-0.5 leading-tight line-clamp-1">{it.title}</h3>
                <p className="text-white/85 text-xs lg:text-sm leading-snug line-clamp-2">{it.description}</p>
              </div>
            </article>
          );
        })}
      </div>

      {/* Arrows */}
      <button
        type="button"
        onClick={() => step(-1)}
        aria-label="Previous feature"
        className="hidden lg:flex absolute left-2 top-1/2 -translate-y-1/2 z-20 w-12 h-12 bg-white rounded-full shadow-lg items-center justify-center text-primary hover:bg-secondary hover:text-white transition-colors"
      >
        <span className="material-symbols-outlined">chevron_left</span>
      </button>
      <button
        type="button"
        onClick={() => step(1)}
        aria-label="Next feature"
        className="hidden lg:flex absolute right-2 top-1/2 -translate-y-1/2 z-20 w-12 h-12 bg-white rounded-full shadow-lg items-center justify-center text-primary hover:bg-secondary hover:text-white transition-colors"
      >
        <span className="material-symbols-outlined">chevron_right</span>
      </button>

      {/* Dots — one per real item */}
      <div className="flex justify-center gap-2 mt-6">
        {items.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => jumpToReal(i)}
            aria-label={`Go to feature ${i + 1}`}
            className={`h-2 rounded-full transition-all ${i === active ? "w-8 bg-secondary" : "w-2 bg-surface-container-high hover:bg-on-surface-variant/40"}`}
          />
        ))}
      </div>
    </div>
  );
}
