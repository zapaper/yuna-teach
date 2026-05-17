import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const PAPER_ID = process.argv[2] ?? "cmp8452t70001r1hlmmff4zlz";
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { metadata: true },
  });
  if (!paper?.metadata) return console.log("no metadata");
  const meta = paper.metadata as Record<string, unknown>;
  // Print the entire structure dump, redacting the bulkier sectionOcrTexts.
  const printable: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === "sectionOcrTexts" && v && typeof v === "object") {
      printable[k] = Object.fromEntries(
        Object.entries(v as Record<string, { ocrText?: string; passageOcrText?: string; pageIndices?: number[] }>).map(([name, sec]) => [
          name,
          {
            pageIndices: sec.pageIndices,
            ocrTextLen: sec.ocrText?.length ?? 0,
            ocrTextHead: (sec.ocrText ?? "").slice(0, 200),
            passageOcrTextLen: sec.passageOcrText?.length ?? 0,
          },
        ])
      );
    } else {
      printable[k] = v;
    }
  }
  console.log(JSON.stringify(printable, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
