const FISH_AUDIO_API_URL = "https://api.fish.audio/v1/tts";

// Convert punctuation marks into spoken words so TTS reads them aloud
const PUNCTUATION_MAP_ZH: Record<string, string> = {
  "。": " 句号",
  "，": " 逗号",
  "、": " 顿号",
  "？": " 问号",
  "！": " 感叹号",
  "：": " 冒号",
  "；": " 分号",
  "……": " 省略号",
  "——": " 破折号",
  "《": " 左书名号",
  "》": " 右书名号",
  "\u201C": " 左引号",
  "\u201D": " 右引号",
  "（": " 左括号",
  "）": " 右括号",
};

const PUNCTUATION_MAP_EN: Record<string, string> = {
  ".": " full stop",
  ",": " comma",
  "?": " question mark",
  "!": " exclamation mark",
  ":": " colon",
  ";": " semicolon",
  "'": " apostrophe",
  '"': " quotation mark",
};

function expandPunctuation(text: string, language: "CHINESE" | "ENGLISH"): string {
  const map = language === "CHINESE" ? PUNCTUATION_MAP_ZH : PUNCTUATION_MAP_EN;
  let result = text;
  // Sort by length descending so multi-char punctuation matches first (e.g. …… before …)
  const sorted = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
  for (const [punct, spoken] of sorted) {
    result = result.split(punct).join(spoken);
  }
  return result;
}

export async function synthesizeSpeech(
  text: string,
  language: "CHINESE" | "ENGLISH",
  options?: { expandPunct?: boolean; speed?: number }
): Promise<ArrayBuffer> {
  // Use the same voice for both languages (bilingual voice)
  const voiceId = process.env.FISH_AUDIO_VOICE_EN;

  const speechText = options?.expandPunct ? expandPunctuation(text, language) : text;
  const speed = options?.speed ?? 0.9;

  const response = await fetch(FISH_AUDIO_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.FISH_AUDIO_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: speechText,
      reference_id: voiceId,
      format: "mp3",
      mp3_bitrate: 128,
      normalize: true,
      latency: "balanced",
      prosody: {
        speed,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Fish Audio TTS failed: ${response.status} ${errorText}`);
  }

  return response.arrayBuffer();
}
