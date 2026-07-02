// Shared helper for the oral-coach avatar selection. The three
// examiner variants correspond to R2 video prefixes:
//   chinese_still1.mp4 / chinese_still2.mp4 / chinese_talk1.mp4 / ...
//   rchinese_*.mp4 (chinese variant 2)
//   indian_*.mp4
// Thumbnails live in /public/oral-thumbs/{key}.png — served locally.
// NB: we intentionally do NOT put them under /public/avatars/ because
// next.config.ts 308-redirects /avatars/:path* to Cloudflare R2, and
// the thumbnails haven't been uploaded there. Selection is stored in
// localStorage so Reading + SBC pages both pick it up.

export type OralAvatarKey = "chinese" | "rchinese" | "indian" | "malay";
export type OralAvatarGender = "female" | "male";

export type OralAvatar = {
  key: OralAvatarKey;
  label: string;
  thumb: string;
  gender: OralAvatarGender;
  /**
   * Gemini Live prebuilt voice name. See
   * https://ai.google.dev/gemini-api/docs/live-guide#voices
   * Options include: Puck (male, clean), Charon (male, deep),
   * Kore (female, warm), Fenrir, Aoede (female, breathy young),
   * Leda (female, warm young), Orus, Zephyr (female, bright young),
   * Callirrhoe (female, calm), Autonoe (female, upbeat).
   */
  geminiVoice: string;
  /**
   * Comma-separated hints for the browser TTS opener voice picker.
   * The picker tries these name patterns in order before falling
   * back to gender defaults.
   */
  ttsHints: string[];
};

// Voice picks per persona:
// - Ms Tan / Ms Lim (Chinese-Singaporean female, young): Zephyr /
//   Aoede — brighter and younger than the default Kore.
// - Mrs Kumar (Indian-Singaporean female, warm): Leda.
// - Mr Ismail (Malay-Singaporean male): Puck.
// TTS opener has no accent match on desktop browsers, but younger-
// sounding en-US voices (Aria, Jenny, Ana, Samantha) read better
// than the somewhat matronly Google/MS UK Female for a school
// examiner persona. Male picks kept British — closer to a Malay-
// Singaporean examiner register.
export const ORAL_AVATARS: OralAvatar[] = [
  {
    key: "chinese",
    label: "Ms Tan",
    thumb: "/oral-thumbs/chinese.png",
    gender: "female",
    geminiVoice: "Callirrhoe",
    ttsHints: [
      "Microsoft Aria",
      "Microsoft Jenny",
      "Microsoft Ana",
      "Google US English",
      "Samantha",
    ],
  },
  {
    key: "rchinese",
    label: "Ms Lim",
    thumb: "/oral-thumbs/rchinese.png",
    gender: "female",
    geminiVoice: "Laomedeia",
    ttsHints: [
      "Microsoft Aria",
      "Microsoft Jenny",
      "Google US English",
      "Samantha",
    ],
  },
  {
    key: "indian",
    label: "Mrs Kumar",
    thumb: "/oral-thumbs/indian.png",
    gender: "female",
    geminiVoice: "Leda",
    ttsHints: [
      "Google हिन्दी",
      "Microsoft Heera",
      "Microsoft Priya",
      "Rishi",
      "Veena",
    ],
  },
  {
    key: "malay",
    label: "Mr Ismail",
    thumb: "/oral-thumbs/malay.png",
    gender: "male",
    geminiVoice: "Puck",
    ttsHints: [
      "Google UK English Male",
      "Microsoft George",
      "Microsoft Ryan",
      "Daniel",
    ],
  },
];

export function getOralAvatar(key: OralAvatarKey): OralAvatar {
  return ORAL_AVATARS.find((a) => a.key === key) ?? ORAL_AVATARS[0];
}

const STORAGE_KEY = "oral-coach-avatar";
const DEFAULT_KEY: OralAvatarKey = "chinese";

export function getOralAvatarKey(): OralAvatarKey {
  if (typeof window === "undefined") return DEFAULT_KEY;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === "chinese" || raw === "rchinese" || raw === "indian" || raw === "malay") return raw;
  return DEFAULT_KEY;
}

export function setOralAvatarKey(key: OralAvatarKey) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, key);
}
