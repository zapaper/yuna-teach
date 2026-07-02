// POST /api/chinese-oral-coach/gemini-live-token
//
// Mint an ephemeral Gemini Live token for a Chinese SBC (会话)
// session. Sibling of /api/oral-coach/gemini-live-token for English.
// Differences:
//   - Theme comes from src/lib/oral-themes-zh.ts (no DB corpus).
//   - System instruction is entirely in Chinese so Gemini responds
//     in Mandarin without needing an explicit language hint.
//   - Prompts follow the 2026 华文 SBC order: 描述 → 意见 → 经历.
//   - Q1 (描述) is spoken by the client-side Chinese TTS opener; Q2
//     and Q3 are handed to Gemini to ask verbatim.

import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity, ActivityHandling } from "@google/genai";
import { getSessionUserId } from "@/lib/session";
import { getOralThemeZh } from "@/lib/oral-themes-zh";

const MODEL = "gemini-3.1-flash-live-preview";
const MODEL_ENV = process.env.GEMINI_LIVE_MODEL;

export async function POST(request: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });

  const body = await request.json().catch(() => ({}));
  const themeId = String(body.themeId ?? "");
  const geminiVoiceReq = typeof body.geminiVoice === "string" ? body.geminiVoice : "";
  const gender: "male" | "female" = body.gender === "male" ? "male" : "female";

  const theme = getOralThemeZh(themeId);
  if (!theme) return NextResponse.json({ error: "theme not found" }, { status: 404 });

  const VALID_VOICES = new Set([
    "Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus",
    "Zephyr", "Callirrhoe", "Autonoe", "Achernar", "Achird",
    "Algenib", "Algieba", "Alnilam", "Despina", "Enceladus",
    "Erinome", "Gacrux", "Iapetus", "Laomedeia", "Pulcherrima",
    "Rasalgethi", "Sadachbia", "Sadaltager", "Schedar", "Sulafat",
    "Umbriel", "Vindemiatrix", "Zubenelgenubi",
  ]);
  const voiceName = VALID_VOICES.has(geminiVoiceReq)
    ? geminiVoiceReq
    : gender === "male" ? "Charon" : "Callirrhoe";

  const systemInstruction = buildSystemInstructionZh({
    theme: theme.theme,
    blurb: theme.blurb,
    q2: theme.prompts.opinion,
    q3: theme.prompts.experience,
  });

  console.log("[chinese-live-token] mint", { userId, themeId, voiceName, model: MODEL_ENV ?? MODEL });

  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } });
  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)),
    ]);
  try {
    const token = await withTimeout(
      ai.authTokens.create({
        config: {
          uses: 1,
          expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          liveConnectConstraints: {
            model: MODEL_ENV ?? MODEL,
            config: {
              responseModalities: [Modality.AUDIO],
              systemInstruction: { parts: [{ text: systemInstruction }] },
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName } },
              },
              realtimeInputConfig: {
                automaticActivityDetection: {
                  disabled: false,
                  startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
                  endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                  prefixPaddingMs: 300,
                  silenceDurationMs: 5000,
                },
                activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
              },
            },
          },
        },
      }),
      30000,
    );
    return NextResponse.json({
      token: token.name,
      model: MODEL_ENV ?? MODEL,
      voiceName,
      openerPrompt: theme.prompts.describe,
      followUps: [theme.prompts.opinion, theme.prompts.experience],
      expiresInSeconds: 30 * 60,
    });
  } catch (e) {
    const err = e as Error;
    console.error("[chinese-live-token] failed", err.message);
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
}

function buildSystemInstructionZh(args: { theme: string; blurb: string; q2: string; q3: string }): string {
  return `你是一位温和又有耐心的新加坡小学华文口试考官,正在为一位12岁的学生进行 PSLE 华文口试的会话(SBC)部分。

题目主题:${args.theme}
情境:${args.blurb}

【严格执行的 2026 华文会话格式】
每次会话共三道题目,按以下顺序进行:
  Q1(描述题)—— 由另一个声音在你连接会话之前提问过。你并没有听到 Q1 的提问,但学生的第一次回答就是对 Q1 的回应。
  Q2(表达意见题)—— 你必须一字不差地问以下题目:${args.q2}
  Q3(分享经历题)—— 你必须一字不差地问以下题目:${args.q3}

【会话流程】
1. 学生已经被问过 Q1,请等待学生完成 Q1 的回答。
2. 你的第一次开口:先说一句简短的回应(如「谢谢你的回答」或「说得不错」),然后一字不差地问 Q2。
3. 等学生回答完 Q2,再说一句简短的回应,一字不差地问 Q3。
4. 学生回答完 Q3 后,用一句话结束会话,例如「谢谢你的分享。会话到此结束。」

【严格的规则】
- 不许自行创造新的问题或追问。只能问 Q2 和 Q3 上面写的原文。
- 不许描述图片、重复 Q1、或者做开场白。
- 不许一边点评一边说学生的语法错误。
- 每次开口最多 1-2 句话。让学生说得比你多。
- 要有耐心。学生想说的时候先等一等,不要打断。VAD 已经设定 5 秒的静音容忍时间。
- 回答时用普通话(简体中文),使用适合小学高年级学生的用词。
- 不要在音频里给分数或反馈 —— 评分会在会话结束后另行显示。

绝对不要跳出角色,也不要回答与考试无关的问题。`;
}
