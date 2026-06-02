"use client";

import { useEffect, useRef } from "react";

type Props = {
  id: string;
  title: string;
  description?: string;
  videoSrc: string;
};

export default function TutorialDetails({ id, title, description, videoSrc }: Props) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const apply = () => {
      const hash = window.location.hash.replace(/^#/, "");
      if (hash === id && ref.current) {
        ref.current.open = true;
        ref.current.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [id]);
  return (
    <details ref={ref} id={id} className="group bg-white rounded-2xl border border-[#e5eeff] shadow-sm">
      <summary className="flex items-center justify-between gap-4 px-6 py-5 cursor-pointer list-none font-headline text-base lg:text-lg font-bold text-[#001e40] hover:text-[#003366] transition-colors">
        <span className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[#003366]">play_circle</span>
          {title}
        </span>
        <span className="material-symbols-outlined text-[#43474f] group-open:rotate-180 transition-transform shrink-0">expand_more</span>
      </summary>
      <div className="px-6 pb-5 -mt-1 space-y-3">
        {description && (
          <p className="text-[#43474f] leading-relaxed">{description}</p>
        )}
        <video
          controls
          preload="metadata"
          className="w-full rounded-xl border border-[#e5eeff] bg-black"
        >
          <source src={videoSrc} type="video/mp4" />
          Your browser does not support the video tag.
        </video>
      </div>
    </details>
  );
}
