interface SequencerOptions {
  onWordChange: (wordIndex: number, totalWords: number) => void;
  onComplete: () => void;
  onError: (error: Error) => void;
}

export class AudioSequencer {
  private abortController: AbortController | null = null;
  private paused = false;
  private pauseResolve: (() => void) | null = null;

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

  async runTestSequence(
    words: Array<{ text: string; language: "CHINESE" | "ENGLISH" }>,
    delayMs: number,
    audioCache: Map<string, ArrayBuffer>,
    options: SequencerOptions
  ) {
    this.abortController = new AbortController();

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

        // 2-second pause
        await this.wait(2000);
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
    }
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
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

    const audioContext = new AudioContext();

    try {
      const audioBuffer = await audioContext.decodeAudioData(buffer.slice(0));
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);

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
    } finally {
      await audioContext.close().catch(() => {});
    }
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
