"use client";

import { useEffect, useRef, useState } from "react";
import { AudioSequencer } from "@/lib/audio-sequencer";
import { WordItem } from "@/types";

interface BeginTestModeProps {
  words: WordItem[];
  language: "CHINESE" | "ENGLISH";
  delaySeconds: number;
  onStop: () => void;
}

export default function BeginTestMode({
  words,
  language,
  delaySeconds,
  onStop,
}: BeginTestModeProps) {
  const [status, setStatus] = useState<"loading" | "playing" | "paused">(
    "loading"
  );
  const [currentWord, setCurrentWord] = useState(0);
  const [totalWords, setTotalWords] = useState(words.length);
  const sequencerRef = useRef<AudioSequencer | null>(null);
  const onStopRef = useRef(onStop);
  const hasStarted = useRef(false);

  onStopRef.current = onStop;

  useEffect(() => {
    if (hasStarted.current) return;
    hasStarted.current = true;

    const sequencer = new AudioSequencer();
    sequencerRef.current = sequencer;

    const enabledWords = words
      .filter((w) => w.enabled)
      .map((w) => ({ text: w.text, language }));

    setTotalWords(enabledWords.length);

    async function run() {
      try {
        const cache = await sequencer.prefetchAudio(enabledWords);
        setStatus("playing");

        await sequencer.runTestSequence(
          enabledWords,
          delaySeconds * 1000,
          cache,
          {
            onWordChange: (idx, total) => {
              setCurrentWord(idx + 1);
              setTotalWords(total);
            },
            onComplete: () => {
              onStopRef.current();
            },
            onError: (err) => {
              console.error("Sequencer error:", err);
              onStopRef.current();
            },
          }
        );
      } catch (err) {
        console.error("Test run error:", err);
        onStopRef.current();
      }
    }

    run();

    return () => {
      sequencer.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handlePauseResume() {
    const sequencer = sequencerRef.current;
    if (!sequencer) return;

    if (sequencer.isPaused) {
      sequencer.resume();
      setStatus("playing");
    } else {
      sequencer.pause();
      setStatus("paused");
    }
  }

  function handleStop() {
    sequencerRef.current?.stop();
    onStopRef.current();
  }

  return (
    <div className="fixed inset-0 bg-slate-900 text-white flex flex-col items-center justify-center z-50">
      {status === "loading" && (
        <>
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-white/20 border-t-white mb-4" />
          <p className="text-slate-400 text-lg">Preparing audio...</p>
        </>
      )}

      {(status === "playing" || status === "paused") && (
        <>
          <p className="text-slate-600 text-sm mb-2">
            {currentWord} / {totalWords}
          </p>
          <div className="w-48 bg-slate-700 rounded-full h-1.5 mb-8">
            <div
              className="bg-primary-400 h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${(currentWord / totalWords) * 100}%` }}
            />
          </div>
          {status === "paused" && (
            <p className="text-amber-400 text-sm mb-6">Paused</p>
          )}
        </>
      )}

      <div className="flex gap-4">
        {(status === "playing" || status === "paused") && (
          <button
            onClick={handlePauseResume}
            className="bg-white/10 text-white rounded-full w-14 h-14 flex items-center justify-center hover:bg-white/20 transition-colors"
          >
            {status === "paused" ? (
              /* Play icon */
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <polygon points="6 3 20 12 6 21 6 3" />
              </svg>
            ) : (
              /* Pause icon */
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
            )}
          </button>
        )}

        <button
          onClick={handleStop}
          className="bg-red-500/80 text-white rounded-full px-8 py-3 text-lg font-semibold hover:bg-red-600 transition-colors"
        >
          Stop
        </button>
      </div>
    </div>
  );
}
