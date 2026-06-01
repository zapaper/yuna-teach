"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export type QuoteItem = {
  text: string;        // supports **bold** markers — rendered as <strong>
  name: string;
  attribution: string;
};

// Split a quote string on **bold** spans and return an array of React
// nodes. Keep it inline-only; no nested markdown. Bold spans pick up
// text-primary so the key phrases stand out against the body grey.
function renderWithBold(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return (
        <strong key={i} className="font-bold text-primary">
          {p.slice(2, -2)}
        </strong>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

// Infinite-loop carousel — same approach as FeatureCarousel. Items
// render 3× and the user gets silently snapped to the middle copy
// when they cross into a flank, so the carousel feels endless in
// either direction.
export default function QuoteCarousel({ items }: { items: QuoteItem[] }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const len = items.length;
  const tripled = useMemo(() => [...items, ...items, ...items], [items]);

  function distFromCenter(slide: HTMLElement, track: HTMLDivElement): number {
    const slideCenter = slide.offsetLeft + slide.offsetWidth / 2;
    const trackCenter = track.scrollLeft + track.clientWidth / 2;
    return Math.abs(slideCenter - trackCenter);
  }

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

  function scrollToIdx(idx: number, smooth: boolean) {
    const track = trackRef.current;
    if (!track) return;
    const slides = Array.from(track.children) as HTMLElement[];
    const target = slides[idx];
    if (!target) return;
    const left = target.offsetLeft - (track.clientWidth - target.offsetWidth) / 2;
    track.scrollTo({ left, behavior: smooth ? "smooth" : "auto" });
  }

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track || len === 0) return;
    const slides = Array.from(track.children) as HTMLElement[];
    const startOfMiddle = slides[len];
    if (startOfMiddle) {
      track.scrollLeft = startOfMiddle.offsetLeft - (track.clientWidth - startOfMiddle.offsetWidth) / 2;
    }
  }, [len]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let settleTimer: number | undefined;
    function onScroll() {
      const closest = findClosest();
      setActive(((closest % len) + len) % len);
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        const c = findClosest();
        if (c < len || c >= 2 * len) {
          const realIdx = ((c % len) + len) % len;
          scrollToIdx(realIdx + len, false);
        }
      }, 180);
    }
    track.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      track.removeEventListener("scroll", onScroll);
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, [findClosest, len]);

  function step(delta: number) {
    scrollToIdx(findClosest() + delta, true);
  }

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
        {tripled.map((q, i) => {
          const isClone = i < len || i >= 2 * len;
          return (
            <figure
              key={i}
              aria-hidden={isClone}
              className="bg-white border border-surface-container-high rounded-3xl shadow-sm overflow-hidden flex flex-col snap-center shrink-0 w-[88vw] sm:w-[440px] md:w-[560px] lg:w-[720px] p-8 lg:p-12"
            >
              <span
                className="material-symbols-outlined text-secondary text-4xl lg:text-5xl mb-4"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                format_quote
              </span>
              <blockquote className="flex-1 flex flex-col">
                <p className="font-quote text-lg md:text-xl lg:text-2xl text-on-surface leading-relaxed mb-6 flex-1">
                  &ldquo;{renderWithBold(q.text)}&rdquo;
                </p>
                <figcaption className="text-sm md:text-base font-bold text-primary mt-auto">
                  &mdash; {q.name}, <span className="text-on-surface-variant font-semibold">{q.attribution}</span>
                </figcaption>
              </blockquote>
            </figure>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => step(-1)}
        aria-label="Previous quote"
        className="hidden lg:flex absolute left-2 top-1/2 -translate-y-1/2 z-20 w-12 h-12 bg-white rounded-full shadow-lg items-center justify-center text-primary hover:bg-secondary hover:text-white transition-colors"
      >
        <span className="material-symbols-outlined">chevron_left</span>
      </button>
      <button
        type="button"
        onClick={() => step(1)}
        aria-label="Next quote"
        className="hidden lg:flex absolute right-2 top-1/2 -translate-y-1/2 z-20 w-12 h-12 bg-white rounded-full shadow-lg items-center justify-center text-primary hover:bg-secondary hover:text-white transition-colors"
      >
        <span className="material-symbols-outlined">chevron_right</span>
      </button>

      <div className="flex justify-center gap-2 mt-6">
        {items.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => jumpToReal(i)}
            aria-label={`Go to quote ${i + 1}`}
            className={`h-2 rounded-full transition-all ${i === active ? "w-8 bg-secondary" : "w-2 bg-surface-container-high hover:bg-on-surface-variant/40"}`}
          />
        ))}
      </div>
    </div>
  );
}
