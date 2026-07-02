// Shared helper for the oral-coach avatar selection. The three
// examiner variants correspond to R2 video prefixes:
//   chinese_still1.mp4 / chinese_still2.mp4 / chinese_talk1.mp4 / ...
//   rchinese_*.mp4 (chinese variant 2)
//   indian_*.mp4
// Thumbnails live in /public/avatars/oral/{key}.png. Selection is
// stored in localStorage so Reading + SBC pages both pick it up.

export type OralAvatarKey = "chinese" | "rchinese" | "indian";

export const ORAL_AVATARS: { key: OralAvatarKey; label: string; thumb: string }[] = [
  { key: "chinese", label: "Ms Tan", thumb: "/avatars/oral/chinese.png" },
  { key: "rchinese", label: "Ms Lim", thumb: "/avatars/oral/rchinese.png" },
  { key: "indian", label: "Mrs Kumar", thumb: "/avatars/oral/indian.png" },
];

const STORAGE_KEY = "oral-coach-avatar";
const DEFAULT_KEY: OralAvatarKey = "chinese";

export function getOralAvatarKey(): OralAvatarKey {
  if (typeof window === "undefined") return DEFAULT_KEY;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === "chinese" || raw === "rchinese" || raw === "indian") return raw;
  return DEFAULT_KEY;
}

export function setOralAvatarKey(key: OralAvatarKey) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, key);
}
