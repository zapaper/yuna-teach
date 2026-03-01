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

// Google Cloud TTS — used for Chinese (Neural2, high quality Mandarin)
async function synthesizeSpeechGoogle(
  text: string,
  speed: number
): Promise<ArrayBuffer> {
  const apiKey = process.env.GOOGLE_CLOUD_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_CLOUD_API_KEY is not set");

  const response = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: "zh-CN", name: "zh-CN-Neural2-C" },
        audioConfig: { audioEncoding: "MP3", speakingRate: speed },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google TTS failed: ${response.status} ${errorText}`);
  }

  const data = await response.json() as { audioContent: string };
  const buf = Buffer.from(data.audioContent, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// Fish Audio TTS — used for English, and as fallback for Chinese
const FISH_AUDIO_API_URL = "https://api.fish.audio/v1/tts";
// Original hardcoded Chinese voice (fallback when Google TTS is unavailable)
const FISH_AUDIO_VOICE_ZH_DEFAULT = "4f201abba2574feeae11e5ebf737859e";

async function synthesizeSpeechFish(
  text: string,
  language: "CHINESE" | "ENGLISH",
  speed: number
): Promise<ArrayBuffer> {
  const voiceId =
    language === "CHINESE"
      ? (process.env.FISH_AUDIO_VOICE_ZH ?? FISH_AUDIO_VOICE_ZH_DEFAULT)
      : process.env.FISH_AUDIO_VOICE_EN;

  const response = await fetch(FISH_AUDIO_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.FISH_AUDIO_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      reference_id: voiceId,
      format: "mp3",
      mp3_bitrate: 128,
      normalize: true,
      latency: "balanced",
      prosody: { speed },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Fish Audio TTS failed: ${response.status} ${errorText}`);
  }

  return response.arrayBuffer();
}

export async function synthesizeSpeech(
  text: string,
  language: "CHINESE" | "ENGLISH",
  options?: { expandPunct?: boolean; speed?: number }
): Promise<ArrayBuffer> {
  const speed = options?.speed ?? 0.9;
  const speechText = options?.expandPunct ? expandPunctuation(text, language) : text;

  // Chinese: Google Cloud Neural2, with Fish Audio fallback
  if (language === "CHINESE") {
    try {
      return await synthesizeSpeechGoogle(speechText, speed);
    } catch (err) {
      console.warn("Google TTS failed, falling back to Fish Audio:", err instanceof Error ? err.message : err);
      return synthesizeSpeechFish(speechText, language, speed);
    }
  }

  // English: Fish Audio
  return synthesizeSpeechFish(speechText, language, speed);
}
