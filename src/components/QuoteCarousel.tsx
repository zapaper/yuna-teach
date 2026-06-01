"use client";

import { useEffect, useRef, useState } from "react";

export type QuoteItem = {
  text: string;
  name: string;
  attribution: string;
};

// Mirrors FeatureCarousel's mechanics (scroll-snap, IO-driven dot
// indicator, prev/next chevrons) but with quote-card visuals: large
// quote-mark icon at the top, body copy below, attribution at the
// bottom. Quotes are bigger than feature cards because the text IS
// the visual here.
export default function QuoteCarousel({ items }: { items: QuoteItem[] }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const slides = Array.from(track.children) as HTMLElement[];
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio >= 0.6) {
            const idx = slides.indexOf(e.target as HTMLElement);
            if (idx >= 0) setActive(idx);
          }
        }
      },
      { root: track, threshold: [0.6] },
    );
    slides.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [items.length]);

  function go(idx: number) {
    const track = trackRef.current;
    if (!track) return;
    const slides = Array.from(track.children) as HTMLElement[];
    const target = slides[idx];
    if (target) target.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }

  return (
    <div className="relative">
      <div
        ref={trackRef}
        className="flex overflow-x-auto snap-x snap-mandatory gap-5 lg:gap-8 scroll-smooth pb-2 -mx-6 px-6 lg:mx-0 lg:px-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        {items.map((q, i) => (
          <figure
            key={i}
            className="bg-white border border-surface-container-high rounded-3xl shadow-sm overflow-hidden flex flex-col snap-center shrink-0 w-[88vw] sm:w-[440px] md:w-[560px] lg:w-[720px] p-8 lg:p-12"
          >
            <span
              className="material-symbols-outlined text-secondary text-4xl lg:text-5xl mb-4"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              format_quote
            </span>
            <blockquote className="flex-1 flex flex-col">
              <p className="font-quote italic text-lg md:text-xl lg:text-2xl text-on-surface leading-relaxed mb-6 flex-1">
                &ldquo;{q.text}&rdquo;
              </p>
              <figcaption className="text-sm md:text-base font-bold text-primary mt-auto">
                — {q.name}, <span className="text-on-surface-variant font-semibold">{q.attribution}</span>
              </figcaption>
            </blockquote>
          </figure>
        ))}
      </div>

      {/* Arrows — overlay inside the track edges so they're always
          visible regardless of viewport width. Desktop only. */}
      <button
        type="button"
        onClick={() => go(Math.max(0, active - 1))}
        disabled={active === 0}
        aria-label="Previous quote"
        className="hidden lg:flex absolute left-2 top-1/2 -translate-y-1/2 z-20 w-12 h-12 bg-white rounded-full shadow-lg items-center justify-center text-primary hover:bg-secondary hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span className="material-symbols-outlined">chevron_left</span>
      </button>
      <button
        type="button"
        onClick={() => go(Math.min(items.length - 1, active + 1))}
        disabled={active === items.length - 1}
        aria-label="Next quote"
        className="hidden lg:flex absolute right-2 top-1/2 -translate-y-1/2 z-20 w-12 h-12 bg-white rounded-full shadow-lg items-center justify-center text-primary hover:bg-secondary hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span className="material-symbols-outlined">chevron_right</span>
      </button>

      {/* Dot indicators */}
      <div className="flex justify-center gap-2 mt-6">
        {items.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => go(i)}
            aria-label={`Go to quote ${i + 1}`}
            className={`h-2 rounded-full transition-all ${i === active ? "w-8 bg-secondary" : "w-2 bg-surface-container-high hover:bg-on-surface-variant/40"}`}
          />
        ))}
      </div>
    </div>
  );
}
