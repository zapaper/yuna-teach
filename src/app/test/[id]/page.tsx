"use client";

import { Suspense, useEffect, useState, useCallback, useRef, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SpellingTestDetail } from "@/types";
import BeginTestMode from "@/components/BeginTestMode";

interface WordInfo {
  pinyin?: string;
  reading?: string;
  meaning: string;
  example: string;
}

export default function TestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <Suspense>
      <TestPageContent id={id} />
    </Suspense>
  );
}

function TestPageContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId");

  const [test, setTest] = useState<SpellingTestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [delaySeconds, setDelaySeconds] = useState(12);
  const [voice, setVoice] = useState<"male" | "female">("female");
  const [testMode, setTestMode] = useState(false);
  const [playingWord, setPlayingWord] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [currentWordInfo, setCurrentWordInfo] = useState<{
    word: string;
    info: WordInfo;
  } | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  // Stop any individual word TTS on unmount
  useEffect(() => {
    return () => {
      stopWordAudio();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopWordAudio() {
    if (abortRef.current) abortRef.current.abort();
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch { /* already stopped */ }
      sourceRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setPlayingWord(null);
  }

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
      if (!test) return;

      // Stop any currently playing word
      if (abortRef.current) abortRef.current.abort();
      if (sourceRef.current) {
        try { sourceRef.current.stop(); } catch { /* already stopped */ }
      }

      const abort = new AbortController();
      abortRef.current = abort;

      // Create AudioContext immediately on user tap (iOS requirement)
      if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
        audioCtxRef.current = new AudioContext();
      }
      await audioCtxRef.current.resume();
      const ctx = audioCtxRef.current;

      setPlayingWord(wordText);
      try {
        // Fetch word audio AND word info concurrently
        const [wordRes, info] = await Promise.all([
          fetch("/api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: wordText,
              language: test.language,
              type: "word",
              expandPunct: true,
              voice,
            }),
          }),
          fetch("/api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: wordText,
              language: test.language,
              type: "wordinfo",
            }),
          }).then((r) => (r.ok ? r.json() : null)),
        ]);

        if (abort.signal.aborted) return;

        // Show word info immediately
        if (info) {
          setCurrentWordInfo({ word: wordText, info: info as WordInfo });
        }

        // Play the word audio
        if (wordRes.ok) {
          const wordAudio = await wordRes.arrayBuffer();
          await playWithContext(ctx, wordAudio, sourceRef, abort.signal);
        } else {
          const errBody = await wordRes.text().catch(() => "");
          console.error(`TTS API error ${wordRes.status}:`, errBody);
          throw new Error(`TTS failed (${wordRes.status}): ${errBody}`);
        }

        if (abort.signal.aborted) return;

        // After word finishes, read the meaning + example
        if (info) {
          const speechText =
            test.language === "CHINESE" || test.language === "JAPANESE"
              ? `${info.meaning}。${info.example}`
              : `${info.meaning}. ${info.example}`;

          const meaningRes = await fetch("/api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: speechText,
              language: test.language,
              type: "word",
              voice,
            }),
          });

          if (abort.signal.aborted) return;

          if (meaningRes.ok) {
            const meaningAudio = await meaningRes.arrayBuffer();
            await playWithContext(ctx, meaningAudio, sourceRef, abort.signal);
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          console.error("TTS error:", err);
        }
      } finally {
        // Only clear if this is still the active word
        if (abortRef.current === abort) {
          setPlayingWord(null);
        }
      }
    },
    [test, voice]
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
          onClick={() => router.push(userId ? `/home/${userId}` : "/")}
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
        language={test.language as "CHINESE" | "ENGLISH" | "JAPANESE"}
        delaySeconds={delaySeconds}
        voice={voice}
        onStop={() => setTestMode(false)}
      />
    );
  }

  function handleBeginTest() {
    stopWordAudio();
    setTestMode(true);
  }

  async function saveTitle() {
    if (!test || !titleInput.trim()) { setEditingTitle(false); return; }
    try {
      const res = await fetch(`/api/tests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: titleInput.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setTest((prev) => prev ? { ...prev, title: data.title } : prev);
      }
    } catch (err) {
      console.error("Failed to update title:", err);
    } finally {
      setEditingTitle(false);
    }
  }

  return (
    <div className="p-6 pb-24">
      {/* Header */}
      <button
        onClick={() => router.push(userId ? `/home/${userId}` : "/")}
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

      <div className="mb-6 flex items-start justify-between">
        <div className="flex-1 min-w-0">
          {editingTitle ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") setEditingTitle(false); }}
                className="flex-1 text-xl font-bold text-slate-800 font-chinese border-b-2 border-primary-400 outline-none bg-transparent min-w-0"
              />
              <button onClick={saveTitle} className="text-primary-500 text-sm font-semibold shrink-0">Save</button>
              <button onClick={() => setEditingTitle(false)} className="text-slate-400 text-sm shrink-0">Cancel</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-800 font-chinese truncate">
                {test.title}
              </h1>
              <button
                onClick={() => { setTitleInput(test.title); setEditingTitle(true); }}
                className="text-slate-300 hover:text-slate-500 transition-colors shrink-0"
                aria-label="Edit title"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
            </div>
          )}
          {test.subtitle ? (
            <p className="text-sm text-slate-500 mt-0.5 font-chinese">
              {test.subtitle}
            </p>
          ) : null}
        </div>
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
            className={`rounded-2xl border-2 p-4 text-center font-chinese text-xl transition-all min-h-[72px] flex items-center justify-center ${
              playingWord === word.text
                ? "border-primary-400 bg-primary-50 scale-95"
                : "border-slate-100 bg-white shadow-sm hover:border-primary-200 hover:shadow-md active:scale-95"
            }`}
          >
            {word.text}
          </button>
        ))}
      </div>

      {/* Word info display */}
      {currentWordInfo ? (
        <div className="bg-primary-50 border border-primary-100 rounded-2xl p-4 mb-4">
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-lg font-bold font-chinese text-primary-700">
              {currentWordInfo.word}
            </span>
            {currentWordInfo.info.pinyin ? (
              <span className="text-sm text-primary-500">
                {currentWordInfo.info.pinyin}
              </span>
            ) : null}
            {currentWordInfo.info.reading ? (
              <span className="text-sm text-primary-500">
                {currentWordInfo.info.reading}
              </span>
            ) : null}
          </div>
          <p className="text-sm text-slate-700 font-chinese">
            {currentWordInfo.info.meaning}
          </p>
          {currentWordInfo.info.example ? (
            <p className="text-sm text-slate-500 mt-1 font-chinese">
              {currentWordInfo.info.example}
            </p>
          ) : null}
        </div>
      ) : null}

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
        onClick={handleBeginTest}
        disabled={enabledWords.length === 0}
        className="w-full bg-primary-600 text-white rounded-2xl py-4 px-6 text-lg font-semibold shadow-lg active:scale-[0.98] transition-transform disabled:opacity-50"
      >
        Begin Test ({enabledWords.length} words)
      </button>
    </div>
  );
}

function playWithContext(
  ctx: AudioContext,
  buffer: ArrayBuffer,
  sourceRef?: React.MutableRefObject<AudioBufferSourceNode | null>,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve, reject) => {
    ctx
      .decodeAudioData(buffer.slice(0))
      .then((audioBuffer) => {
        if (signal?.aborted) { resolve(); return; }

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        if (sourceRef) sourceRef.current = source;

        source.onended = () => {
          if (sourceRef?.current === source) sourceRef.current = null;
          resolve();
        };
        source.start(0);

        signal?.addEventListener("abort", () => {
          try { source.stop(); } catch { /* already stopped */ }
          resolve();
        }, { once: true });
      })
      .catch(reject);
  });
}
