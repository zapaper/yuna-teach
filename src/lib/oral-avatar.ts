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
};

export const ORAL_AVATARS: OralAvatar[] = [
  { key: "chinese", label: "Ms Tan", thumb: "/oral-thumbs/chinese.png", gender: "female" },
  { key: "rchinese", label: "Ms Lim", thumb: "/oral-thumbs/rchinese.png", gender: "female" },
  { key: "indian", label: "Mrs Kumar", thumb: "/oral-thumbs/indian.png", gender: "female" },
  { key: "malay", label: "Mr Ismail", thumb: "/oral-thumbs/malay.png", gender: "male" },
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
