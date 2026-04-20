// Small client-side SFX helpers. Each function no-ops silently if the audio
// can't play (autoplay block, missing file, browser without AudioContext).

/**
 * Soft coin / power-up chime — tries /sounds/point.mp3 first, then falls back
 * to a synthesized Web Audio tone. Used for each "+N" popup landing in the
 * MCQ score card and each green bubble landing in the XP bar.
 */
export function playPointChime(volume = 0.35): void {
  try {
    const audio = new Audio("/sounds/point.mp3");
    audio.volume = volume;
    audio.play().catch(() => playSynthChime());
  } catch {
    playSynthChime();
  }
}

/**
 * XP bubble landing "whoosh" — plays when each green bubble enters the
 * experience bar on the home page. Tries /sounds/exp.mp3, no synth fallback
 * (bubbles should stay silent if the asset is missing).
 */
export function playExp(volume = 0.25): void {
  try {
    const audio = new Audio("/sounds/exp.mp3");
    audio.volume = volume;
    audio.play().catch(() => { /* no fallback — keep it silent if blocked */ });
  } catch { /* ignore */ }
}

/**
 * Satisfying soft "click" — for buttons like Quiz tile, Back, Submit. Tries
 * /sounds/click.mp3 first, then falls back to a short filtered synth burst.
 */
export function playClick(volume = 0.35): void {
  try {
    const audio = new Audio("/sounds/click.mp3");
    audio.volume = volume;
    audio.play().catch(() => playSynthClick());
  } catch {
    playSynthClick();
  }
}

function playSynthChime(): void {
  try {
    const Ctx = (window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.32);
    setTimeout(() => { try { ctx.close(); } catch { /* ignore */ } }, 500);
  } catch { /* ignore */ }
}

function playSynthClick(): void {
  try {
    const Ctx = (window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!Ctx) return;
    const ctx = new Ctx();
    // Short, slightly-tuned pop: triangle wave with a very fast attack/decay.
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(720, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(520, ctx.currentTime + 0.05);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.09);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
    setTimeout(() => { try { ctx.close(); } catch { /* ignore */ } }, 250);
  } catch { /* ignore */ }
}
