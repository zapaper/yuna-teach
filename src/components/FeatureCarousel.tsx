"use client";

import { useEffect, useRef, useState } from "react";

export type FeatureItem = {
  src: string;
  alt: string;
  title: string;
  description: string;
};

// Lightweight feature carousel built on native CSS scroll-snap. Each
// card is image-as-backdrop with a navy header strip on top — the
// header position is consistent across all cards so the eye finds
// the next title in the same place after a swipe.
export default function FeatureCarousel({ items }: { items: FeatureItem[] }) {
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
        {items.map((it, i) => (
          <article
            key={i}
            className="relative bg-surface-container-low rounded-3xl shadow-lg overflow-hidden snap-center shrink-0 w-[88vw] sm:w-[440px] md:w-[560px] lg:w-[760px] aspect-[4/3]"
          >
            {/* Image as backdrop — fills the card, object-contain so
                screenshots aren't cropped. Padding-top makes room for
                the header overlay so the image content doesn't sit
                under the title. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt={it.alt}
              className="absolute inset-0 w-full h-full object-contain p-4 pt-32 lg:pt-36"
              src={it.src}
            />

            {/* Header strip on top — consistent position across all cards.
                Navy panel with white title + description for high contrast. */}
            <div className="absolute top-0 left-0 right-0 bg-primary text-white px-6 py-5 lg:px-8 lg:py-6 z-10">
              <h3 className="font-headline text-lg md:text-xl lg:text-2xl font-bold mb-1 leading-tight">{it.title}</h3>
              <p className="text-white/85 text-sm lg:text-base leading-snug">{it.description}</p>
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
        className="hidden lg:flex absolute left-0 top-1/2 -translate-y-1/2 -translate-x-14 w-11 h-11 bg-white rounded-full shadow-md items-center justify-center text-primary hover:bg-secondary hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span className="material-symbols-outlined">chevron_left</span>
      </button>
      <button
        type="button"
        onClick={() => go(Math.min(items.length - 1, active + 1))}
        disabled={active === items.length - 1}
        aria-label="Next feature"
        className="hidden lg:flex absolute right-0 top-1/2 -translate-y-1/2 translate-x-14 w-11 h-11 bg-white rounded-full shadow-md items-center justify-center text-primary hover:bg-secondary hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
            className={`h-2 rounded-full transition-all ${i === active ? "w-8 bg-secondary" : "w-2 bg-surface-container-high hover:bg-on-surface-variant/40"}`}
          />
        ))}
      </div>
    </div>
  );
}
