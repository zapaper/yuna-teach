"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getOralAvatarKey, type OralAvatarKey } from "@/lib/oral-avatar";

// Examiner face loops uploaded to Cloudflare R2 under oral-coach/
// prefix. Each variant ships four 5-second silent MP4s:
//   <variant>_still1.mp4 / <variant>_still2.mp4 = examiner listening
//   <variant>_talk1.mp4  / <variant>_talk2.mp4  = examiner speaking
// Variants: "chinese" (default), "rchinese", "indian".

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
  /**
   * Which examiner face to render. If omitted, falls back to the
   * user's saved preference in localStorage (see @/lib/oral-avatar).
   */
  avatarKey?: OralAvatarKey;
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
export function ExaminerAvatar({ speaking, className, avatarKey }: Props) {
  // Resolve variant: explicit prop overrides localStorage. Do the
  // localStorage read in an effect so SSR + first paint use the
  // default without a hydration mismatch.
  const [resolvedKey, setResolvedKey] = useState<OralAvatarKey>(avatarKey ?? "chinese");
  useEffect(() => {
    if (avatarKey) { setResolvedKey(avatarKey); return; }
    setResolvedKey(getOralAvatarKey());
  }, [avatarKey]);

  const { stillLoops, talkLoops, allLoops } = useMemo(() => {
    const stillLoops = [`${resolvedKey}_still1.mp4`, `${resolvedKey}_still2.mp4`];
    const talkLoops = [`${resolvedKey}_talk1.mp4`, `${resolvedKey}_talk2.mp4`];
    return { stillLoops, talkLoops, allLoops: [...stillLoops, ...talkLoops] };
  }, [resolvedKey]);

  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const [activeSrc, setActiveSrc] = useState<string>(stillLoops[0]);
  const speakingRef = useRef(speaking);

  // When variant changes, reset to the still1 loop of the new variant
  // and drop refs so stale entries don't fire onEnded across variants.
  useEffect(() => {
    videoRefs.current = {};
    setActiveSrc(stillLoops[0]);
  }, [resolvedKey, stillLoops]);

  // Kick off playback on mount so the browser caches all four videos.
  // Some browsers (Safari mobile especially) refuse autoplay before a
  // user gesture — that's fine, they'll start as soon as the parent
  // page has any user interaction, which happens immediately when the
  // student clicks "Start Session" / "Start Reading".
  useEffect(() => {
    allLoops.forEach((file) => {
      const v = videoRefs.current[file];
      if (v) {
        v.play().catch(() => { /* autoplay blocked — will resume on interaction */ });
      }
    });
  }, [allLoops]);

  // When speaking flips, swap to the appropriate pool immediately.
  useEffect(() => {
    speakingRef.current = speaking;
    const pool = speaking ? talkLoops : stillLoops;
    if (!pool.includes(activeSrc)) {
      const next = pool[0];
      const v = videoRefs.current[next];
      if (v) {
        v.currentTime = 0;
        v.play().catch(() => {});
      }
      setActiveSrc(next);
    }
  }, [speaking, activeSrc, stillLoops, talkLoops]);

  // Sequential alternation within the current pool. When the visible
  // loop ends, cross-fade to the other loop in the same pool. When a
  // background (invisible) loop ends, ignore — it just sits at t=0
  // ready to be swapped in later.
  const handleEnded = useCallback((currentFile: string) => {
    const pool = speakingRef.current ? talkLoops : stillLoops;
    const idx = pool.indexOf(currentFile);
    if (idx < 0) return;
    const next = pool[(idx + 1) % pool.length];
    const nextVideo = videoRefs.current[next];
    if (nextVideo) {
      nextVideo.currentTime = 0;
      nextVideo.play().catch(() => {});
    }
    setActiveSrc(next);
    const endedVideo = videoRefs.current[currentFile];
    if (endedVideo) endedVideo.currentTime = 0;
  }, [stillLoops, talkLoops]);

  return (
    <div className={`relative overflow-hidden ${className ?? ""}`}>
      {allLoops.map((file) => (
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
