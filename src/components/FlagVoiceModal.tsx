"use client";

import { useEffect, useRef, useState } from "react";

// Popup that appears when a user flags a question. Two-step:
//   Step 1 — ask if they want to record a voice note. Choices:
//     • "Record" — switches to step 2 and starts recording immediately.
//     • "No, just flag it" — calls onJustFlag() and closes.
//   Step 2 — recording UI with elapsed time + Cancel / End buttons.
//     • Cancel — drop the recording, fall back to plain flag (calls
//       onJustFlag).
//     • End — POST the audio + raise the flag in one shot via the
//       /api/exam/<paperId>/flag/voice endpoint, then close.
//
// The modal is presentational only — flag toggling lives at the
// caller, which passes onJustFlag. Voice path is fully self-contained
// here including the multipart upload.
export function FlagVoiceModal({
  paperId,
  questionId,
  userId,
  open,
  onClose,
  onJustFlag,
  onVoiceFlagged,
}: {
  paperId: string;
  questionId: string;
  userId?: string | null;
  open: boolean;
  onClose: () => void;
  // Called when the user picks "No, just flag it" or cancels mid-record.
  // Caller does the normal toggle-flag round trip.
  onJustFlag: () => void;
  // Called after a successful voice upload — the API has already raised
  // the flag, so the caller usually just updates local UI state.
  onVoiceFlagged: () => void;
}) {
  const [stage, setStage] = useState<"choice" | "recording" | "uploading">("choice");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopTracks() {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }

  // Reset state whenever the modal closes/opens so a re-open starts fresh.
  useEffect(() => {
    if (!open) {
      stopTracks();
      setStage("choice");
      setElapsed(0);
      setError(null);
      chunksRef.current = [];
    }
  }, [open]);

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.start();
      recorderRef.current = rec;
      setStage("recording");
      setElapsed(0);
      tickRef.current = setInterval(() => setElapsed(s => s + 1), 1000);
    } catch (err) {
      console.error("[flag-voice] mic permission denied", err);
      setError("Could not access microphone. Please check browser permissions.");
    }
  }

  // Stop the recorder and resolve to the produced Blob once the final
  // dataavailable event fires.
  function finishRecording(): Promise<Blob> {
    return new Promise((resolve) => {
      const rec = recorderRef.current;
      if (!rec) { resolve(new Blob(chunksRef.current, { type: "audio/webm" })); return; }
      const mime = rec.mimeType || "audio/webm";
      rec.onstop = () => resolve(new Blob(chunksRef.current, { type: mime }));
      try { rec.stop(); } catch { resolve(new Blob(chunksRef.current, { type: mime })); }
    });
  }

  async function endAndUpload() {
    setStage("uploading");
    try {
      const blob = await finishRecording();
      stopTracks();
      const form = new FormData();
      form.append("questionId", questionId);
      if (userId) form.append("userId", userId);
      form.append("audio", blob, `flag-${questionId}.webm`);
      const res = await fetch(`/api/exam/${paperId}/flag/voice`, { method: "POST", body: form });
      if (!res.ok) throw new Error("upload failed");
      onVoiceFlagged();
      onClose();
    } catch (err) {
      console.error("[flag-voice] upload failed", err);
      setError("Could not upload the recording. The question is still flagged without it.");
      // Even if upload fails, the user wanted to flag — fall back.
      onJustFlag();
      setTimeout(onClose, 1500);
    }
  }

  function cancelRecording() {
    stopTracks();
    try { recorderRef.current?.stop(); } catch { /* ignore */ }
    onJustFlag();
    onClose();
  }

  if (!open) return null;

  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4" onClick={() => stage === "choice" && onClose()}>
      <div className="bg-white rounded-3xl w-full max-w-sm p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        {stage === "choice" && (
          <>
            <h3 className="font-headline font-extrabold text-lg text-[#001e40] mb-1">Flag this question</h3>
            <p className="text-sm text-[#43474f] mb-5">Would you like to leave a quick voice note about what's wrong? Otherwise we'll just flag it.</p>
            <div className="flex flex-col gap-2">
              <button
                onClick={startRecording}
                className="w-full py-3 rounded-2xl bg-[#ba1a1a] text-white text-sm font-bold hover:bg-[#93000a] flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>mic</span>
                Record voice note
              </button>
              <button
                onClick={() => { onJustFlag(); onClose(); }}
                className="w-full py-3 rounded-2xl bg-slate-100 text-[#001e40] text-sm font-bold hover:bg-slate-200"
              >
                No, just flag it
              </button>
            </div>
            {error && <p className="text-xs text-[#ba1a1a] mt-3">{error}</p>}
          </>
        )}

        {stage === "recording" && (
          <>
            <div className="flex items-center justify-center mb-4">
              <span className="relative flex w-12 h-12">
                <span className="absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75 animate-ping" />
                <span className="relative inline-flex rounded-full w-12 h-12 bg-[#ba1a1a] items-center justify-center">
                  <span className="material-symbols-outlined text-white" style={{ fontVariationSettings: "'FILL' 1" }}>mic</span>
                </span>
              </span>
            </div>
            <p className="text-center text-sm text-[#43474f] mb-1">Recording…</p>
            <p className="text-center font-headline text-2xl font-extrabold text-[#001e40] tabular-nums mb-5">{mm}:{ss}</p>
            <div className="flex gap-2">
              <button
                onClick={cancelRecording}
                className="flex-1 py-3 rounded-2xl bg-slate-100 text-[#001e40] text-sm font-bold hover:bg-slate-200"
              >Cancel</button>
              <button
                onClick={endAndUpload}
                className="flex-1 py-3 rounded-2xl bg-[#006c49] text-white text-sm font-bold hover:bg-[#005039]"
              >End</button>
            </div>
          </>
        )}

        {stage === "uploading" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-[#003366]" />
            <p className="text-sm text-[#43474f]">Saving your recording…</p>
          </div>
        )}
      </div>
    </div>
  );
}
