import { GoogleGenAI } from "@google/genai";

let _ai: GoogleGenAI | null = null;
function getAI() {
  if (!_ai) {
    _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  }
  return _ai;
}

const EXTRACTION_PROMPT = `You are an expert at reading OCR text from primary school spelling test documents.

The OCR text below was extracted from a photo of a spelling test sheet. These sheets typically contain:
- One or more spelling tests arranged in a grid/table layout
- Each test has a header (e.g. "听写(五)" meaning "Dictation 5", or "Spelling Test 12")
- Each test may have a date line (e.g. "2月6日 2024 星期二")
- Each test has a numbered list of words or short phrases to memorize

Your task:
1. Identify ALL separate spelling tests in the OCR text
2. For each test, extract:
   - The title/header (e.g. "听写(五)")
   - The subtitle/date if present (empty string if none)
   - The language: "CHINESE" if the test words are Chinese characters, "ENGLISH" if English words
   - All the test words/phrases in order
3. IMPORTANT: Only extract actual test words. Do NOT include:
   - Headers, titles, dates as words
   - Numbers that are just list indices
   - Teacher marks, ticks, circles, or other annotations
   - Page numbers or other non-word text
4. Clean each word: remove any stray marks, punctuation artifacts, or OCR errors adjacent to the actual word

Return a JSON object with this exact structure:
{
  "tests": [
    {
      "title": "听写(五)",
      "subtitle": "2月6日 2024 星期二",
      "language": "CHINESE",
      "words": [
        { "text": "种族", "orderIndex": 1 },
        { "text": "华人", "orderIndex": 2 }
      ]
    }
  ]
}

OCR Text:
"""
{ocrText}
"""

Extract all spelling tests and their words from this OCR text. Return ONLY valid JSON.`;

export async function extractWords(ocrText: string) {
  const response = await getAI().models.generateContent({
    model: "gemini-2.5-flash",
    contents: EXTRACTION_PROMPT.replace("{ocrText}", ocrText),
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned empty response");

  return JSON.parse(text) as {
    tests: Array<{
      title: string;
      subtitle: string;
      language: "CHINESE" | "ENGLISH";
      words: Array<{ text: string; orderIndex: number }>;
    }>;
  };
}

const MEANING_PROMPT_ZH = `You are a primary school Chinese teacher in Singapore.
For the Chinese word or phrase "{word}", provide:
1. pinyin: the hanyu pinyin with tone marks (e.g. "zhǒng zú")
2. meaning: a brief meaning in Chinese, under 15 characters (e.g. "人类按肤色、语言等分的类别")
3. example: a simple example sentence in Chinese that a Primary 3-4 student would understand, under 20 characters (e.g. "新加坡有很多种族。")

Return ONLY valid JSON: {"pinyin": "...", "meaning": "...", "example": "..."}`;

const MEANING_PROMPT_EN = `You are a primary school English teacher.
For the word "{word}", provide:
1. meaning: a brief kid-friendly definition, under 10 words (e.g. "to have fun for a special day")
2. example: a simple example sentence a primary school student would understand, under 15 words (e.g. "We celebrate birthdays with cake and songs.")

Return ONLY valid JSON: {"meaning": "...", "example": "..."}`;

export interface WordInfo {
  pinyin?: string;
  meaning: string;
  example: string;
}

const wordInfoCache = new Map<string, WordInfo>();

export async function generateWordInfo(
  word: string,
  language: "CHINESE" | "ENGLISH"
): Promise<WordInfo> {
  const cacheKey = `${language}:${word}`;
  const cached = wordInfoCache.get(cacheKey);
  if (cached) return cached;

  const prompt =
    language === "CHINESE"
      ? MEANING_PROMPT_ZH.replace("{word}", word)
      : MEANING_PROMPT_EN.replace("{word}", word);

  const response = await getAI().models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      temperature: 0.3,
    },
  });

  const text = response.text?.trim();
  if (!text) return { meaning: word, example: "" };

  try {
    const info = JSON.parse(text) as WordInfo;
    wordInfoCache.set(cacheKey, info);
    return info;
  } catch {
    return { meaning: word, example: "" };
  }
}
