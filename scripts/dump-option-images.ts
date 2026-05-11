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
    const imgsDesc = Array.isArray(imgs)
      ? `[${(imgs as unknown[]).map(i => {
          if (i === null || i === undefined) return "null";
          if (typeof i !== "string") return `<${typeof i}>`;
          if (i.length === 0) return '""';
          const prefix = i.startsWith("data:image") ? "data-url" : "raw-b64";
          return `${prefix}(${i.length})`;
        }).join(", ")}]`
      : imgs === null ? "null" : `(${typeof imgs}: ${JSON.stringify(imgs).slice(0, 50)})`;
    console.log(`Q${q.questionNum}  answer="${q.answer ?? ""}"`);
    console.log(`  options: ${optsDesc}`);
    console.log(`  images:  ${imgsDesc}`);
  }
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
