const FISH_AUDIO_API_URL = "https://api.fish.audio/v1/tts";

export async function synthesizeSpeech(
  text: string,
  language: "CHINESE" | "ENGLISH"
): Promise<ArrayBuffer> {
  const voiceId =
    language === "CHINESE"
      ? process.env.FISH_AUDIO_VOICE_ZH
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
      prosody: {
        speed: 0.9,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Fish Audio TTS failed: ${response.status} ${errorText}`);
  }

  return response.arrayBuffer();
}
