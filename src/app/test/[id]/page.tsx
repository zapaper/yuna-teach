"use client";

import { Suspense, useEffect, useState, useCallback, useRef, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SpellingTestDetail } from "@/types";
import BeginTestMode from "@/components/BeginTestMode";

interface WordInfo {
  pinyin?: string;
  reading?: string;
  meaning: string;
  englishMeaning?: string;
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
  const [delaySeconds, setDelaySeconds] = useState(3.5);
  const VOICE_OPTIONS = [
    { key: "female", label: "Female 1" },
    { key: "male", label: "Male 1" },
    { key: "female2", label: "Female 2", neural: true },
    { key: "male2", label: "Male 2", neural: true },
  ] as const;
  const [voice, setVoice] = useState<string>("female");
  const [testMode, setTestMode] = useState(false);
  const [playingWord, setPlayingWord] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [currentWordInfo, setCurrentWordInfo] = useState<{
    word: string;
    info: WordInfo;
  } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const audioCtxRef = useRef<AudioContext | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => {
    return () => { stopWordAudio(); };
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

        if (info) {
          setCurrentWordInfo({ word: wordText, info: info as WordInfo });
        }

        if (wordRes.ok) {
          const wordAudio = await wordRes.arrayBuffer();
          await playWithContext(ctx, wordAudio, sourceRef, abort.signal);
        } else {
          const errBody = await wordRes.text().catch(() => "");
          throw new Error(`TTS failed (${wordRes.status}): ${errBody}`);
        }

        if (abort.signal.aborted) return;

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
        if (!abort.signal.aborted) console.error("TTS error:", err);
      } finally {
        if (abortRef.current === abort) setPlayingWord(null);
      }
    },
    [test, voice]
  );

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

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-[#003366]/20 border-t-[#003366]" />
      </div>
    );
  }

  if (!test) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex flex-col items-center justify-center gap-4">
        <p className="text-[#43474f]">Test not found</p>
        <button
          onClick={() => router.push(userId ? `/home/${userId}` : "/")}
          className="text-[#001e40] font-semibold underline"
        >
          Go Home
        </button>
      </div>
    );
  }

  const enabledWords = test.words.filter((w) => w.enabled);
  const filteredWords = searchQuery
    ? enabledWords.filter((w) => w.text.toLowerCase().includes(searchQuery.toLowerCase()))
    : enabledWords;

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

  const selectedWord = currentWordInfo?.word ?? null;

  const wordLabel =
    test.language === "CHINESE" ? "成语" :
    test.language === "JAPANESE" ? "単語" : "Word";

  return (
    <div className="min-h-screen bg-[#f8f9ff] font-body text-[#0b1c30] antialiased">

      {/* ── Sticky top bar ── */}
      <header className="sticky top-0 z-30 bg-[#f8f9ff]/90 backdrop-blur-xl border-b border-[#e5eeff] px-4 lg:px-10 h-16 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => router.push(userId ? `/home/${userId}` : "/")}
            className="shrink-0 p-2 rounded-full hover:bg-[#eff4ff] transition-colors text-[#43474f]"
          >
            <span className="material-symbols-outlined">arrow_back</span>
          </button>

          {editingTitle ? (
            <div className="flex items-center gap-2 min-w-0">
              <input
                autoFocus
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveTitle();
                  if (e.key === "Escape") setEditingTitle(false);
                }}
                className="font-headline font-extrabold text-xl text-[#001e40] bg-transparent border-b-2 border-[#003366] outline-none w-56 lg:w-80 min-w-0"
              />
              <button onClick={saveTitle} className="text-[#006c49] text-sm font-bold shrink-0">Save</button>
              <button onClick={() => setEditingTitle(false)} className="text-[#43474f] text-sm shrink-0">Cancel</button>
            </div>
          ) : (
            <div
              className="flex items-center gap-2 min-w-0 group cursor-pointer"
              onClick={() => { setTitleInput(test.title); setEditingTitle(true); }}
            >
              <h1 className="font-headline font-extrabold text-xl text-[#001e40] truncate tracking-tight">
                {test.title}
              </h1>
              <span className="material-symbols-outlined text-[#737780] text-lg opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                edit
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Voice toggle */}
          <div className="flex items-center gap-1">
            {VOICE_OPTIONS.map(v => (
              <button
                key={v.key}
                onClick={() => setVoice(v.key)}
                className={`px-2 py-1 rounded-full text-[10px] font-bold transition-colors whitespace-nowrap ${
                  voice === v.key
                    ? "bg-[#003366] text-white"
                    : "text-[#003366] hover:bg-[#eff4ff]"
                }`}
                title={v.neural ? "Neural (higher quality)" : "Standard"}
              >
                {v.label}
              </button>
            ))}
          </div>

          {/* Search — desktop only */}
          <div className="hidden md:flex items-center bg-white rounded-full border border-[#e5eeff] px-3 py-2 gap-2 w-60 focus-within:ring-2 focus-within:ring-[#003366]/10 transition-all">
            <span className="material-symbols-outlined text-[#737780] text-xl">search</span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search words..."
              className="bg-transparent outline-none text-sm text-[#0b1c30] placeholder:text-[#737780] flex-1"
            />
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 lg:px-10 py-8 pb-10">

        {/* ── Section header ── */}
        <div className="mb-8">
          <div className="flex items-center gap-1.5 mb-1">
            <span
              className="material-symbols-outlined text-[#006c49] text-lg"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              auto_awesome
            </span>
            <p className="text-[#006c49] font-bold text-xs tracking-widest uppercase">Spelling Test Overview</p>
          </div>
          <div className="flex items-end justify-between gap-4">
            <p className="text-[#43474f] text-sm leading-relaxed max-w-lg">
              {test.subtitle || "Tap any word to hear it and see its meaning. When you're ready, begin the test."}
            </p>
          </div>
        </div>

        {/* ── Word grid ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-10">
          {filteredWords.map((word) => {
            const isSelected = word.text === selectedWord;
            const isPlaying = word.text === playingWord;
            return (
              <button
                key={word.id}
                onClick={() => playWord(word.text)}
                className={`relative group cursor-pointer p-3 sm:p-5 lg:p-6 rounded-2xl transition-all hover:-translate-y-1 text-center min-w-0 ${
                  isSelected
                    ? "bg-[#d3e4fe] ring-2 ring-[#001e40] shadow-md"
                    : "bg-white shadow-[0_4px_20px_rgba(11,28,48,0.04)] hover:bg-[#eff4ff] hover:shadow-md"
                }`}
              >
                <div className={`absolute top-2.5 right-2.5 transition-opacity ${isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-40"}`}>
                  <span className="material-symbols-outlined text-[#001e40] text-base">edit</span>
                </div>
                <p className="text-xl sm:text-2xl lg:text-3xl font-bold text-[#001e40] mb-1 break-all leading-tight">{word.text}</p>
                <p className={`text-[10px] font-bold tracking-widest uppercase ${
                  isPlaying ? "text-[#006c49]" : isSelected ? "text-[#003366]" : "text-[#737780]"
                }`}>
                  {isPlaying ? "Playing…" : isSelected ? "Selected" : wordLabel}
                </p>
              </button>
            );
          })}

          {filteredWords.length === 0 && (
            <div className="col-span-full py-12 text-center text-[#737780] text-sm">
              No words match your search.
            </div>
          )}
        </div>

        {/* ── Detail panel ── */}
        {currentWordInfo && (
          <div className="bg-[#eff4ff] rounded-[2rem] p-8 lg:p-10 mb-8 border border-white/60 relative overflow-hidden">
            <div className="absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 bg-[#003366]/5 rounded-full blur-3xl pointer-events-none" />
            <div className="relative z-10">
              <div className="flex items-center gap-5 mb-8 flex-wrap">
                <span className="text-5xl lg:text-6xl font-black text-[#001e40]">
                  {currentWordInfo.word}
                </span>
                <div className="h-10 w-px bg-[#c3c6d1] hidden sm:block" />
                <div>
                  {(currentWordInfo.info.pinyin || currentWordInfo.info.reading) && (
                    <p className="text-xl lg:text-2xl font-medium text-[#43474f] italic">
                      {currentWordInfo.info.pinyin || currentWordInfo.info.reading}
                    </p>
                  )}
                  <button
                    onClick={() => playWord(currentWordInfo.word)}
                    className="mt-1 text-[#001e40] hover:text-[#003366] transition-colors"
                    aria-label="Play pronunciation"
                  >
                    <span className="material-symbols-outlined">volume_up</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 lg:gap-12">
                <div>
                  <h4 className="text-xs font-bold text-[#001e40] uppercase tracking-[0.2em] mb-2">
                    Primary Meaning
                  </h4>
                  <p className="text-lg text-[#43474f] leading-relaxed font-medium">
                    {currentWordInfo.info.meaning}
                  </p>
                  {currentWordInfo.info.englishMeaning && (
                    <p className="text-sm text-[#43474f]/70 mt-1 italic">
                      {currentWordInfo.info.englishMeaning}
                    </p>
                  )}
                </div>
                {currentWordInfo.info.example && (
                  <div>
                    <h4 className="text-xs font-bold text-[#001e40] uppercase tracking-[0.2em] mb-2">
                      Example Sentence
                    </h4>
                    <p className="text-base text-[#43474f] bg-white/60 p-4 rounded-xl border border-white/80 leading-relaxed">
                      {currentWordInfo.info.example}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Controls + Begin Test ── */}
        <div className="flex flex-col md:flex-row items-center justify-between gap-8 bg-white/60 backdrop-blur-md p-6 lg:p-8 rounded-[2rem] shadow-[0_20px_40px_rgba(11,28,48,0.04)]">
          <div className="w-full md:w-1/2">
            <div className="flex items-center justify-between mb-3">
              <label className="text-xs font-bold text-[#001e40] uppercase tracking-widest">
                Delay between words/phrases
              </label>
              <span className="text-xs font-black text-[#001e40] px-3 py-1 bg-[#e5eeff] rounded-lg tabular-nums">
                {delaySeconds % 1 === 0 ? `${delaySeconds}s` : `${delaySeconds.toFixed(1)}s`}
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={10}
              step={0.5}
              value={delaySeconds}
              onChange={(e) => setDelaySeconds(Number(e.target.value))}
              className="w-full h-2 bg-[#dce9ff] rounded-lg appearance-none cursor-pointer accent-[#001e40]"
            />
            <div className="flex justify-between mt-2">
              <span className="text-[10px] font-bold text-[#737780]">FASTER</span>
              <span className="text-[10px] font-bold text-[#737780]">SLOWER</span>
            </div>
          </div>

          <button
            onClick={handleBeginTest}
            disabled={enabledWords.length === 0}
            className="group flex items-center justify-center gap-3 bg-gradient-to-br from-[#001e40] to-[#003366] px-10 lg:px-12 py-4 lg:py-5 rounded-2xl text-white shadow-xl hover:shadow-[#001e40]/30 transition-all hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed w-full md:w-auto"
          >
            <span className="text-base lg:text-lg font-extrabold">
              Begin Test ({enabledWords.length} words)
            </span>
            <span
              className="material-symbols-outlined transition-transform group-hover:translate-x-1"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              play_arrow
            </span>
          </button>
        </div>

        <footer className="mt-12 text-center">
          <p className="text-xs text-[#737780] font-medium">
            Ready to focus? Your performance will be logged in your{" "}
            <span className="text-[#001e40] font-bold">Progress Dashboard</span>.
          </p>
        </footer>
      </main>
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
