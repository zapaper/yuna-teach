// POST /api/oral-coach/azure-token
//
// Short-lived token broker for Azure Speech Pronunciation Assessment.
// The browser SDK needs a token to authenticate — we never ship the
// raw AZURE_SPEECH_KEY to the client. Backend exchanges the key for
// a 10-minute token via Azure's issueToken endpoint and returns
// { token, region } to the caller.
//
// Client usage (browser):
//   const { token, region } = await fetch('/api/oral-coach/azure-token', { method: 'POST' }).then(r => r.json());
//   const cfg = SpeechConfig.fromAuthorizationToken(token, region);
//   const audio = AudioConfig.fromDefaultMicrophoneInput();
//   const rec = new SpeechRecognizer(cfg, audio);
//   rec.pronunciationAssessment = new PronunciationAssessmentConfig(
//     referenceText,
//     "HundredMark",       // grading system (100-point scale)
//     "Phoneme",           // granularity — 'Phoneme' gives per-sound scores
//   );
//   rec.recognizeOnceAsync(result => {
//     const detail = PronunciationAssessmentResult.fromResult(result);
//     // detail.pronunciationScore / accuracyScore / fluencyScore /
//     // completenessScore / prosodyScore + detail.detailResult.Words[]
//   });
//
// The token expires after 10 minutes. Client should re-request before
// each recognition session (or on 401 during recognition).
//
// Auth: same session-cookie gate as every other /api/* route. This is
// a student-facing route — students will hit it during their oral
// practice sessions — so we accept any authenticated user, not just
// admins. Rate-limiting is up to the caller for now (Azure's per-key
// throttling is the backstop).

import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";

export async function POST() {
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    return NextResponse.json(
      { error: "Azure Speech not configured — set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION env vars" },
      { status: 500 },
    );
  }

  try {
    const resp = await fetch(
      `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Length": "0",
        },
      },
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return NextResponse.json(
        { error: `Azure issueToken returned ${resp.status}: ${body.slice(0, 200)}` },
        { status: 502 },
      );
    }
    const token = await resp.text();
    return NextResponse.json({
      token,
      region,
      // Token expires ~10 min after issue; client re-requests when
      // recognition returns 401 or before starting a new session.
      expiresInSeconds: 600,
    });
  } catch (e) {
    const err = e as Error;
    return NextResponse.json(
      { error: `Azure issueToken failed: ${err.message}` },
      { status: 502 },
    );
  }
}
