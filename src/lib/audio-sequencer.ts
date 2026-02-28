interface SequencerOptions {
  onWordChange: (wordIndex: number, totalWords: number) => void;
  onComplete: () => void;
  onError: (error: Error) => void;
}

export class AudioSequencer {
  private abortController: AbortController | null = null;
  private paused = false;
  private pauseResolve: (() => void) | null = null;
  private audioContext: AudioContext | null = null;

  async prefetchAudio(
    words: Array<{ text: string; language: "CHINESE" | "ENGLISH" }>
  ): Promise<Map<string, ArrayBuffer>> {
    const cache = new Map<string, ArrayBuffer>();

    for (const w of words) {
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: w.text,
            language: w.language,
            type: "word",
          }),
        });
        if (res.ok) {
          cache.set(w.text, await res.arrayBuffer());
        } else {
          console.warn(`TTS prefetch failed for "${w.text}", will retry during playback`);
        }
      } catch (err) {
        console.warn(`TTS prefetch error for "${w.text}":`, err);
      }
    }

    return cache;
  }

  /**
   * Unlock audio on iOS by creating and resuming the AudioContext
   * from a user gesture context. Call this early (e.g. on button tap).
   */
  unlockAudio() {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    // iOS requires resume() from a user gesture to unlock
    if (this.audioContext.state === "suspended") {
      this.audioContext.resume();
    }
  }

  async runTestSequence(
    words: Array<{ text: string; language: "CHINESE" | "ENGLISH" }>,
    delayMs: number,
    audioCache: Map<string, ArrayBuffer>,
    options: SequencerOptions
  ) {
    this.abortController = new AbortController();

    // Ensure AudioContext exists and is running
    if (!this.audioContext || this.audioContext.state === "closed") {
      this.audioContext = new AudioContext();
    }
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    try {
      for (let i = 0; i < words.length; i++) {
        if (this.abortController.signal.aborted) break;
        await this.waitIfPaused();
        if (this.abortController.signal.aborted) break;

        options.onWordChange(i, words.length);
        const word = words[i];

        let buffer = audioCache.get(word.text);
        if (!buffer) {
          try {
            const res = await fetch("/api/tts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                text: word.text,
                language: word.language,
                type: "word",
              }),
            });
            if (res.ok) {
              buffer = await res.arrayBuffer();
              audioCache.set(word.text, buffer);
            }
          } catch {
            // skip this word if fetch fails
          }
        }

        if (!buffer) continue;
        if (this.abortController.signal.aborted) break;

        // Speak the word (first time)
        await this.playAudio(buffer);
        if (this.abortController.signal.aborted) break;

        // Pause between repeats — longer for longer text
        const textLen = word.text.length;
        const repeatPause = Math.min(2000 + textLen * 300, 6000);
        await this.wait(repeatPause);
        if (this.abortController.signal.aborted) break;

        // Speak the word (second time)
        await this.playAudio(buffer);
        if (this.abortController.signal.aborted) break;

        // Wait for configured delay (writing time) - skip after last word
        if (i < words.length - 1) {
          await this.wait(delayMs);
        }
      }

      if (!this.abortController.signal.aborted) {
        options.onComplete();
      }
    } catch (err) {
      if (!this.abortController.signal.aborted) {
        options.onError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this.closeAudio();
    }
  }

  pause() {
    this.paused = true;
    // Suspend the audio context to free resources while paused
    this.audioContext?.suspend();
  }

  resume() {
    this.paused = false;
    // Resume audio context for playback
    this.audioContext?.resume();
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
  }

  get isPaused() {
    return this.paused;
  }

  stop() {
    this.paused = false;
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
    this.abortController?.abort();
    this.closeAudio();
  }

  private closeAudio() {
    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }

  private waitIfPaused(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pauseResolve = resolve;
      // Also resolve on abort so stop() works while paused
      this.abortController?.signal.addEventListener(
        "abort",
        () => resolve(),
        { once: true }
      );
    });
  }

  private async playAudio(buffer: ArrayBuffer): Promise<void> {
    if (this.abortController?.signal.aborted) return;
    if (!this.audioContext || this.audioContext.state === "closed") return;

    // Ensure context is running (may be suspended after pause/resume)
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    const audioBuffer = await this.audioContext.decodeAudioData(buffer.slice(0));
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);

    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start(0);

      this.abortController?.signal.addEventListener(
        "abort",
        () => {
          try {
            source.stop();
          } catch {
            // already stopped
          }
          resolve();
        },
        { once: true }
      );
    });
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, ms);
      this.abortController?.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );
    });
  }
}
