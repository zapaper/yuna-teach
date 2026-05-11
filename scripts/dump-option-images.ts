// Diagnostic: dump the shape of transcribedOptionImages on every
// question of a quiz so we can see what the printable route is
// actually being asked to render.
//
// Usage: npx tsx scripts/dump-option-images.ts <paperId>

import { prisma } from "../src/lib/db";

(async () => {
  const id = process.argv[2];
  if (!id) { console.error("usage: dump-option-images.ts <paperId>"); process.exit(1); }

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: id },
    orderBy: { orderIndex: "asc" },
    select: {
      id: true, questionNum: true,
      transcribedOptions: true, transcribedOptionImages: true, answer: true,
    },
  });
  for (const q of qs) {
    const opts = q.transcribedOptions;
    const imgs = q.transcribedOptionImages;
    const optsDesc = Array.isArray(opts)
      ? `[${(opts as unknown[]).map(o => typeof o === "string" ? JSON.stringify(o.slice(0, 30)) : String(o)).join(", ")}]`
      : opts === null ? "null" : `(${typeof opts}: ${JSON.stringify(opts).slice(0, 50)})`;
    const describeImg = (i: unknown): string => {
      if (i === null || i === undefined) return "null";
      if (typeof i !== "string") return `<${typeof i}>`;
      if (i.length === 0) return '""';
      const prefix = i.startsWith("data:image") ? "data-url" : "raw-b64";
      // Decode first 12 base64 chars (= 9 bytes) and show as hex
      // so we can spot the file signature without dumping 50KB.
      const b64 = i.startsWith("data:image") ? i.replace(/^data:image\/\w+;base64,/, "") : i;
      let header = "";
      try {
        const buf = Buffer.from(b64.slice(0, 12), "base64");
        header = Array.from(buf.slice(0, 8)).map(b => b.toString(16).padStart(2, "0")).join(" ");
      } catch { header = "decode-failed"; }
      // Classify based on bytes (matches embedDataUrlScaled's sniff).
      const sig = header.startsWith("89 50 4e 47") ? "PNG"
        : header.startsWith("ff d8 ff") ? "JPEG"
        : header.startsWith("47 49 46") ? "GIF"
        : header.startsWith("52 49 46 46") ? "WEBP/RIFF"
        : header.startsWith("3c") ? "SVG/XML?"
        : "UNKNOWN";
      return `${prefix}(${i.length}, ${sig}, header=${header})`;
    };
    const imgsDesc = Array.isArray(imgs)
      ? `[\n    ${(imgs as unknown[]).map(describeImg).join(",\n    ")}\n  ]`
      : imgs === null ? "null" : `(${typeof imgs}: ${JSON.stringify(imgs).slice(0, 50)})`;
    console.log(`Q${q.questionNum}  answer="${q.answer ?? ""}"`);
    console.log(`  options: ${optsDesc}`);
    console.log(`  images:  ${imgsDesc}`);
  }
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
