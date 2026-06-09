// Dump imageData + diagramImageData for a question to JPG files so
// you can eyeball what the elaborate route was seeing vs. what it
// could see if we sent the full question image too.
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/_dump-question-images.ts <paperId> <questionNum>
//   → writes tmp/q<num>-image.jpg and tmp/q<num>-diagram.jpg

import { promises as fs } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";

(async () => {
  const PAPER = process.argv[2];
  const QNUM = process.argv[3];
  if (!PAPER || !QNUM) {
    console.error("usage: _dump-question-images.ts <paperId> <questionNum>");
    process.exit(1);
  }
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: PAPER, questionNum: QNUM },
    select: { id: true, imageData: true, diagramImageData: true },
  });
  if (!q) {
    console.error(`Q${QNUM} not found on paper ${PAPER}`);
    process.exit(1);
  }

  const outDir = path.join(process.cwd(), "tmp");
  await fs.mkdir(outDir, { recursive: true });

  for (const [field, label] of [
    ["imageData", "image"],
    ["diagramImageData", "diagram"],
  ] as const) {
    const raw = (q as Record<string, string | null>)[field];
    if (!raw) {
      console.log(`${field}: (null)`);
      continue;
    }
    // Two encodings show up in this column:
    //   data:image/jpeg;base64,<...>   — written by older extraction
    //   /9j/<...>                       — written by newer paths (raw base64 JPEG)
    let mime: string;
    let b64: string;
    const m = raw.match(/^data:image\/(\w+);base64,(.+)$/);
    if (m) {
      mime = m[1];
      b64 = m[2];
    } else if (raw.startsWith("/9j/") || raw.startsWith("iVBORw0KGgo") || raw.startsWith("R0lGOD")) {
      // /9j → JPEG magic; iVBORw0KGgo → PNG; R0lGOD → GIF.
      mime = raw.startsWith("/9j/") ? "jpeg" : raw.startsWith("iVBORw0KGgo") ? "png" : "gif";
      b64 = raw;
    } else {
      console.log(`${field}: unknown encoding (first 80 chars: ${raw.slice(0, 80)})`);
      continue;
    }
    const ext = mime === "jpeg" ? "jpg" : mime;
    const out = path.join(outDir, `q${QNUM}-${label}.${ext}`);
    await fs.writeFile(out, Buffer.from(b64, "base64"));
    console.log(`${field}: wrote ${out} (${Math.round(b64.length * 0.75 / 1024)} KB)`);
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
