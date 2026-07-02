"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Chinese examiner face loops uploaded to Cloudflare R2 under
// oral-coach/ prefix. All four are 5-second silent MP4s.
// still1/still2 = examiner listening; talk1/talk2 = examiner speaking.
// The face is Chinese-oral-examiner footage — used here for the
// English SBC as well because the visual matters (a face + head sway)
// more than perfect language matching. Swap files or rename here when
// dedicated English examiner loops land.
const STILL_LOOPS = ["chinese_still1.mp4", "chinese_still2.mp4"];
const TALK_LOOPS = ["chinese_talk1.mp4", "chinese_talk2.mp4"];
const ALL_LOOPS = [...STILL_LOOPS, ...TALK_LOOPS];

// Base path — served via next.config.ts redirect to R2. Same origin
// hostname on the browser, no CORS gymnastics needed.
const AVATAR_BASE = "/oral-coach";

// Cross-fade duration when switching between videos. 400ms feels
// natural — long enough to hide the swap, short enough that the
// examiner never appears "frozen" during a mode change.
const FADE_MS = 400;

type Props = {
  /** true = play talk loops; false = play still loops */
  speaking: boolean;
  /** Tailwind-ish class for the wrapper size + shape */
  className?: string;
};

/**
 * Stacked-video avatar. All four loops render as absolutely-positioned
 * <video> elements in the same spot; only one is opacity: 1 at a time.
 * Crossfade between loops on state changes; sequential alternation
 * (still1 → still2 → still1 or talk1 → talk2 → talk1) as each loop
 * ends within a mode.
 *
 * Preloading: `preload="auto"` on all four + they start playing on
 * mount so the browser decodes and caches all frames upfront. The
 * inactive ones sit muted with opacity 0 — Chrome/Safari efficiently
 * throttle offscreen video decoding so CPU cost is negligible.
 */
export function ExaminerAvatar({ speaking, className }: Props) {
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const [activeSrc, setActiveSrc] = useState<string>(STILL_LOOPS[0]);
  const speakingRef = useRef(speaking);

  // Kick off playback on mount so the browser caches all four videos.
  // Some browsers (Safari mobile especially) refuse autoplay before a
  // user gesture — that's fine, they'll start as soon as the parent
  // page has any user interaction, which happens immediately when the
  // student clicks "Start Session" / "Start Reading".
  useEffect(() => {
    ALL_LOOPS.forEach((file) => {
      const v = videoRefs.current[file];
      if (v) {
        v.play().catch(() => { /* autoplay blocked — will resume on interaction */ });
      }
    });
  }, []);

  // When speaking flips, swap to the appropriate pool immediately.
  useEffect(() => {
    speakingRef.current = speaking;
    const pool = speaking ? TALK_LOOPS : STILL_LOOPS;
    if (!pool.includes(activeSrc)) {
      const next = pool[0];
      const v = videoRefs.current[next];
      if (v) {
        v.currentTime = 0;
        v.play().catch(() => {});
      }
      setActiveSrc(next);
    }
  }, [speaking, activeSrc]);

  // Sequential alternation within the current pool. When the visible
  // loop ends, cross-fade to the other loop in the same pool. When a
  // background (invisible) loop ends, ignore — it just sits at t=0
  // ready to be swapped in later.
  const handleEnded = useCallback((currentFile: string) => {
    const pool = speakingRef.current ? TALK_LOOPS : STILL_LOOPS;
    const idx = pool.indexOf(currentFile);
    if (idx < 0) return; // ended video is not from the current pool — leave alone
    const next = pool[(idx + 1) % pool.length];
    const nextVideo = videoRefs.current[next];
    if (nextVideo) {
      nextVideo.currentTime = 0;
      nextVideo.play().catch(() => {});
    }
    setActiveSrc(next);
    // Reset the just-ended video so it's ready to play from t=0 when
    // it's picked again on the next rotation.
    const endedVideo = videoRefs.current[currentFile];
    if (endedVideo) endedVideo.currentTime = 0;
  }, []);

  return (
    <div className={`relative overflow-hidden ${className ?? ""}`}>
      {ALL_LOOPS.map((file) => (
        <video
          key={file}
          ref={(el) => {
            videoRefs.current[file] = el;
            // Belt-and-braces: some browsers honour the `muted` attribute
            // for autoplay but still emit the audio track unless we set
            // muted + volume=0 imperatively. The uploaded R2 loops carry
            // an audio track that would otherwise talk over the Gemini
            // Live examiner voice — force silent.
            if (el) {
              el.muted = true;
              el.volume = 0;
            }
          }}
          src={`${AVATAR_BASE}/${file}`}
          muted
          playsInline
          preload="auto"
          onEnded={() => handleEnded(file)}
          disableRemotePlayback
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          style={{
            opacity: file === activeSrc ? 1 : 0,
            transition: `opacity ${FADE_MS}ms ease-in-out`,
          }}
        />
      ))}
    </div>
  );
}
