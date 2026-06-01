"use client";

import { useEffect, useRef, useState } from "react";

export type FeatureItem = {
  src: string;
  alt: string;
  title: string;
  description: string;
};

// Lightweight feature carousel built on native CSS scroll-snap (mobile
// swipe is free) plus a tiny IntersectionObserver to drive the active
// dot. Desktop adds prev/next chevrons; mobile users just swipe.
export default function FeatureCarousel({ items }: { items: FeatureItem[] }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const slides = Array.from(track.children) as HTMLElement[];
    // threshold 0.6 because at the breakpoints below, exactly one slide
    // dominates the viewport — we want the dot to flip cleanly when the
    // user has scrolled most of the way to the next card.
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
      {/* Track. -mx-6 / px-6 on mobile so the first/last card can fully
          extend to the viewport edge while staying inside the section
          padding. */}
      <div
        ref={trackRef}
        className="flex overflow-x-auto snap-x snap-mandatory gap-5 lg:gap-8 scroll-smooth pb-2 -mx-6 px-6 lg:mx-0 lg:px-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        {items.map((it, i) => (
          <article
            key={i}
            className="bg-white border border-surface-container-high rounded-3xl shadow-sm overflow-hidden flex flex-col snap-center shrink-0 w-[88vw] sm:w-[440px] md:w-[560px] lg:w-[760px]"
          >
            <div className="aspect-[4/3] bg-surface-container-low flex items-center justify-center p-3 lg:p-5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt={it.alt} className="max-h-full max-w-full object-contain" src={it.src} />
            </div>
            <div className="p-6 lg:p-8">
              <h3 className="font-headline text-xl lg:text-2xl font-bold text-primary mb-2">{it.title}</h3>
              <p className="text-on-surface-variant text-sm lg:text-base leading-relaxed">{it.description}</p>
            </div>
          </article>
        ))}
      </div>

      {/* Arrows — desktop only */}
      <button
        type="button"
        onClick={() => go(Math.max(0, active - 1))}
        disabled={active === 0}
        aria-label="Previous feature"
        className="hidden lg:flex absolute left-0 top-1/2 -translate-y-1/2 -translate-x-14 w-11 h-11 bg-white rounded-full shadow-md items-center justify-center text-primary hover:bg-tertiary hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span className="material-symbols-outlined">chevron_left</span>
      </button>
      <button
        type="button"
        onClick={() => go(Math.min(items.length - 1, active + 1))}
        disabled={active === items.length - 1}
        aria-label="Next feature"
        className="hidden lg:flex absolute right-0 top-1/2 -translate-y-1/2 translate-x-14 w-11 h-11 bg-white rounded-full shadow-md items-center justify-center text-primary hover:bg-tertiary hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
            aria-label={`Go to feature ${i + 1}`}
            className={`h-2 rounded-full transition-all ${i === active ? "w-8 bg-tertiary" : "w-2 bg-surface-container-high hover:bg-on-surface-variant/40"}`}
          />
        ))}
      </div>
    </div>
  );
}
