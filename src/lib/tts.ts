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

const PUNCTUATION_MAP_JA: Record<string, string> = {
  "。": " まる",
  "、": " てん",
  "？": " はてな",
  "！": " びっくり",
  "「": " かぎかっこ",
  "」": " かぎかっことじ",
};

// Malay shares Latin punctuation with English — reuse those names but
// localised in Bahasa so the TTS pronounces them naturally.
const PUNCTUATION_MAP_MS: Record<string, string> = {
  ".": " noktah",
  ",": " koma",
  "?": " tanda soal",
  "!": " tanda seru",
  ":": " titik bertindih",
  ";": " koma bertitik",
};

// Tamil punctuation — mostly Latin marks. Keep names in Tamil so the
// Tamil TTS voice doesn't switch to English for the punctuation word.
const PUNCTUATION_MAP_TA: Record<string, string> = {
  ".": " முற்றுப்புள்ளி",
  ",": " காற்புள்ளி",
  "?": " வினாக்குறி",
  "!": " ஆச்சரியக்குறி",
  ":": " குறி",
  ";": " அரைப்புள்ளி",
};

// Korean punctuation — Latin period/comma/etc. spoken in Korean.
const PUNCTUATION_MAP_KO: Record<string, string> = {
  ".": " 마침표",
  ",": " 쉼표",
  "?": " 물음표",
  "!": " 느낌표",
  ":": " 쌍점",
  ";": " 쌍반점",
};

export type TtsLanguage = "CHINESE" | "ENGLISH" | "JAPANESE" | "MALAY" | "TAMIL" | "KOREAN";

function expandPunctuation(text: string, language: TtsLanguage): string {
  const map =
    language === "CHINESE" ? PUNCTUATION_MAP_ZH :
    language === "JAPANESE" ? PUNCTUATION_MAP_JA :
    language === "MALAY" ? PUNCTUATION_MAP_MS :
    language === "TAMIL" ? PUNCTUATION_MAP_TA :
    language === "KOREAN" ? PUNCTUATION_MAP_KO :
    PUNCTUATION_MAP_EN;
  let result = text;
  // Sort by length descending so multi-char punctuation matches first (e.g. …… before …)
  const sorted = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
  for (const [punct, spoken] of sorted) {
    result = result.split(punct).join(spoken);
  }
  return result;
}

// Voice key → Google Cloud TTS voice name mapping
const CHINESE_VOICE_MAP: Record<string, { name: string; ssmlGender: string }> = {
  female:  { name: "cmn-CN-Standard-A", ssmlGender: "FEMALE" },
  male:    { name: "cmn-CN-Standard-C", ssmlGender: "MALE" },
  female2: { name: "cmn-CN-Wavenet-A",  ssmlGender: "FEMALE" },
  male2:   { name: "cmn-CN-Wavenet-B",  ssmlGender: "MALE" },
};

// Tamil — Wavenet voices sound noticeably better than Standard, so
// they're the default. C/D variants are alternative pitches if we
// ever expose them in the picker.
const TAMIL_VOICE_MAP: Record<string, { name: string; ssmlGender: string }> = {
  female: { name: "ta-IN-Wavenet-A", ssmlGender: "FEMALE" },
  male:   { name: "ta-IN-Wavenet-B", ssmlGender: "MALE" },
};

// Malay — only Standard voices available from Google as of 2025.
// Quality is plainer than Tamil/Chinese Wavenet but intelligible.
const MALAY_VOICE_MAP: Record<string, { name: string; ssmlGender: string }> = {
  female: { name: "ms-MY-Standard-A", ssmlGender: "FEMALE" },
  male:   { name: "ms-MY-Standard-B", ssmlGender: "MALE" },
};

// Korean — Wavenet voices available, quality is excellent. A/B = main
// female/male; C/D are alternatives if we ever expose voice picker.
const KOREAN_VOICE_MAP: Record<string, { name: string; ssmlGender: string }> = {
  female: { name: "ko-KR-Wavenet-A", ssmlGender: "FEMALE" },
  male:   { name: "ko-KR-Wavenet-C", ssmlGender: "MALE" },
};

// Google Cloud TTS — used for Chinese, Japanese, Malay, Tamil, Korean.
async function synthesizeSpeechGoogle(
  text: string,
  speed: number,
  language: "CHINESE" | "JAPANESE" | "MALAY" | "TAMIL" | "KOREAN" = "CHINESE",
  voice: string = "female"
): Promise<ArrayBuffer> {
  const apiKey = process.env.GOOGLE_CLOUD_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_CLOUD_API_KEY is not set");

  let voiceConfig: { languageCode: string; name: string; ssmlGender: string };
  if (language === "JAPANESE") {
    const ssmlGender = voice === "male" ? "MALE" : "FEMALE";
    voiceConfig = {
      languageCode: "ja-JP",
      name: voice === "male" ? "ja-JP-Standard-C" : "ja-JP-Standard-B",
      ssmlGender,
    };
  } else if (language === "MALAY") {
    const m = MALAY_VOICE_MAP[voice] ?? MALAY_VOICE_MAP.female;
    voiceConfig = { languageCode: "ms-MY", name: m.name, ssmlGender: m.ssmlGender };
  } else if (language === "TAMIL") {
    const t = TAMIL_VOICE_MAP[voice] ?? TAMIL_VOICE_MAP.female;
    voiceConfig = { languageCode: "ta-IN", name: t.name, ssmlGender: t.ssmlGender };
  } else if (language === "KOREAN") {
    const k = KOREAN_VOICE_MAP[voice] ?? KOREAN_VOICE_MAP.female;
    voiceConfig = { languageCode: "ko-KR", name: k.name, ssmlGender: k.ssmlGender };
  } else {
    const mapped = CHINESE_VOICE_MAP[voice];
    const ssmlGender = mapped?.ssmlGender ?? (voice === "male" ? "MALE" : "FEMALE");
    voiceConfig = {
      languageCode: "cmn-CN",
      name: mapped?.name ?? "cmn-CN-Standard-A",
      ssmlGender,
    };
  }
  // Only log on error, not every call

  const response = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: voiceConfig,
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
  language: "CHINESE" | "ENGLISH" | "JAPANESE",
  speed: number
): Promise<ArrayBuffer> {
  const voiceId =
    language === "CHINESE"
      ? (process.env.FISH_AUDIO_VOICE_ZH ?? FISH_AUDIO_VOICE_ZH_DEFAULT)
      : language === "JAPANESE"
      ? process.env.FISH_AUDIO_VOICE_JA
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
  language: TtsLanguage,
  options?: { expandPunct?: boolean; speed?: number; voice?: string }
): Promise<ArrayBuffer> {
  const speed = options?.speed ?? 0.9;
  const voice = options?.voice ?? "female";
  const speechText = options?.expandPunct ? expandPunctuation(text, language) : text;

  // Chinese / Japanese / Malay / Tamil all go through Google Cloud
  // TTS. Chinese + Japanese fall back to Fish Audio if Google fails;
  // Malay + Tamil have no Fish fallback (no comparable voices), so an
  // outage propagates the error to the caller.
  if (language === "CHINESE") {
    try {
      return await synthesizeSpeechGoogle(speechText, speed, "CHINESE", voice);
    } catch (err) {
      console.warn("Google TTS failed, falling back to Fish Audio:", err instanceof Error ? err.message : err);
      return synthesizeSpeechFish(speechText, language, speed);
    }
  }

  if (language === "JAPANESE") {
    try {
      return await synthesizeSpeechGoogle(speechText, speed, "JAPANESE", voice);
    } catch (err) {
      console.warn("Google TTS failed for Japanese, falling back to Fish Audio:", err instanceof Error ? err.message : err);
      return synthesizeSpeechFish(speechText, language, speed);
    }
  }

  if (language === "MALAY") {
    return synthesizeSpeechGoogle(speechText, speed, "MALAY", voice);
  }
  if (language === "TAMIL") {
    return synthesizeSpeechGoogle(speechText, speed, "TAMIL", voice);
  }
  if (language === "KOREAN") {
    return synthesizeSpeechGoogle(speechText, speed, "KOREAN", voice);
  }

  // English: Fish Audio
  return synthesizeSpeechFish(speechText, language, speed);
}
