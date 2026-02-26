"use client";

import { useEffect, useState, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import { SpellingTestDetail } from "@/types";
import BeginTestMode from "@/components/BeginTestMode";

interface WordInfo {
  pinyin?: string;
  meaning: string;
  example: string;
}

export default function TestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();

  const [test, setTest] = useState<SpellingTestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [delaySeconds, setDelaySeconds] = useState(12);
  const [testMode, setTestMode] = useState(false);
  const [playingWord, setPlayingWord] = useState<string | null>(null);
  const [currentWordInfo, setCurrentWordInfo] = useState<{
    word: string;
    info: WordInfo;
  } | null>(null);

  useEffect(() => {
    async function fetchTest() {
      try {
        const res = await fetch(`/api/tests/${id}`);
        if (!res.ok) throw new Error("Test not found");
        const data = await res.json();
        setTest(data);
      } catch (err) {
        console.error("Failed to fetch test:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchTest();
  }, [id]);

  const playWord = useCallback(
    async (wordText: string) => {
      if (!test || playingWord) return;

      setPlayingWord(wordText);
      try {
        // Play the word
        const wordRes = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: wordText,
            language: test.language,
            type: "word",
          }),
        });

        if (wordRes.ok) {
          const wordAudio = await wordRes.arrayBuffer();
          await playAudioBuffer(wordAudio);
        }

        // Fetch word info (pinyin, meaning, example) while pausing
        const infoPromise = fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: wordText,
            language: test.language,
            type: "wordinfo",
          }),
        }).then((r) => (r.ok ? r.json() : null));

        // 1.5 second pause
        const [info] = await Promise.all([
          infoPromise,
          new Promise((r) => setTimeout(r, 1500)),
        ]);

        // Show word info text
        if (info) {
          setCurrentWordInfo({ word: wordText, info: info as WordInfo });
        }

        // Play the meaning + example
        const meaningRes = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: wordText,
            language: test.language,
            type: "meaning",
          }),
        });

        if (meaningRes.ok) {
          const meaningAudio = await meaningRes.arrayBuffer();
          await playAudioBuffer(meaningAudio);
        }
      } catch (err) {
        console.error("TTS error:", err);
      } finally {
        setPlayingWord(null);
      }
    },
    [test, playingWord]
  );

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-200 border-t-primary-500" />
      </div>
    );
  }

  if (!test) {
    return (
      <div className="p-6 text-center py-24">
        <p className="text-slate-500">Test not found</p>
        <button
          onClick={() => router.push("/")}
          className="mt-4 text-primary-500 underline"
        >
          Go Home
        </button>
      </div>
    );
  }

  const enabledWords = test.words.filter((w) => w.enabled);

  if (testMode) {
    return (
      <BeginTestMode
        words={test.words}
        language={test.language as "CHINESE" | "ENGLISH"}
        delaySeconds={delaySeconds}
        onStop={() => setTestMode(false)}
      />
    );
  }

  return (
    <div className="p-6 pb-24">
      {/* Header */}
      <button
        onClick={() => router.push("/")}
        className="flex items-center gap-1 text-slate-500 mb-4 hover:text-slate-700"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
        Home
      </button>

      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-800 font-chinese">
          {test.title}
        </h1>
        {test.subtitle && (
          <p className="text-sm text-slate-500 mt-0.5 font-chinese">
            {test.subtitle}
          </p>
        )}
      </div>

      {/* Instructions */}
      <p className="text-sm text-slate-500 mb-4">
        Tap a word to hear it and its meaning
      </p>

      {/* Word grid */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        {enabledWords.map((word) => (
          <button
            key={word.id}
            onClick={() => playWord(word.text)}
            disabled={playingWord !== null}
            className={`rounded-2xl border-2 p-4 text-center font-chinese text-xl transition-all min-h-[72px] flex items-center justify-center ${
              playingWord === word.text
                ? "border-primary-400 bg-primary-50 scale-95"
                : "border-slate-100 bg-white shadow-sm hover:border-primary-200 hover:shadow-md active:scale-95"
            } ${playingWord && playingWord !== word.text ? "opacity-50" : ""}`}
          >
            {word.text}
          </button>
        ))}
      </div>

      {/* Word info display */}
      {currentWordInfo && (
        <div className="bg-primary-50 border border-primary-100 rounded-2xl p-4 mb-4">
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-lg font-bold font-chinese text-primary-700">
              {currentWordInfo.word}
            </span>
            {currentWordInfo.info.pinyin && (
              <span className="text-sm text-primary-500">
                {currentWordInfo.info.pinyin}
              </span>
            )}
          </div>
          <p className="text-sm text-slate-700 font-chinese">
            {currentWordInfo.info.meaning}
          </p>
          {currentWordInfo.info.example && (
            <p className="text-sm text-slate-500 mt-1 font-chinese">
              {currentWordInfo.info.example}
            </p>
          )}
        </div>
      )}

      {/* Delay slider */}
      <div className="bg-slate-50 rounded-2xl p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-slate-600">
            Delay between words
          </span>
          <span className="text-sm font-semibold text-primary-600">
            {delaySeconds}s
          </span>
        </div>
        <input
          type="range"
          min={5}
          max={30}
          value={delaySeconds}
          onChange={(e) => setDelaySeconds(Number(e.target.value))}
          className="w-full accent-primary-500"
        />
        <div className="flex justify-between text-xs text-slate-400 mt-1">
          <span>5s</span>
          <span>30s</span>
        </div>
      </div>

      {/* Begin Test button */}
      <button
        onClick={() => setTestMode(true)}
        disabled={enabledWords.length === 0}
        className="w-full bg-primary-600 text-white rounded-2xl py-4 px-6 text-lg font-semibold shadow-lg active:scale-[0.98] transition-transform disabled:opacity-50"
      >
        Begin Test ({enabledWords.length} words)
      </button>
    </div>
  );
}

function playAudioBuffer(buffer: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const audioContext = new AudioContext();
    audioContext
      .decodeAudioData(buffer.slice(0))
      .then((audioBuffer) => {
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);
        source.onended = () => {
          audioContext.close();
          resolve();
        };
        source.start(0);
      })
      .catch(reject);
  });
}
