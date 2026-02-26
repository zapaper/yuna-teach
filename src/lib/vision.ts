export async function performOCR(imageBase64: string): Promise<string> {
  const response = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_CLOUD_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: imageBase64 },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            imageContext: {
              languageHints: ["zh-Hans", "en"],
            },
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google Cloud Vision API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const text = data.responses?.[0]?.fullTextAnnotation?.text;

  if (!text) {
    throw new Error("No text detected in image");
  }

  return text;
}
