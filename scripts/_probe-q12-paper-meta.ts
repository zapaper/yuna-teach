import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  const p = await prisma.examPaper.findUnique({
    where: { id: "cmr0oo3ps001jb307o6lcclr0" },
    select: { id: true, paperType: true, title: true, metadata: true, reviewAnnotations: true },
  });
  if (!p) { console.log("no paper"); return; }
  console.log(`title: ${p.title}`);
  console.log(`paperType: ${p.paperType}`);
  const meta = p.metadata as Record<string, unknown> | null;
  if (meta) {
    console.log(`metadata keys: ${Object.keys(meta).join(", ")}`);
    for (const [k, v] of Object.entries(meta)) {
      if (typeof v === "string") console.log(`  ${k}: <${v.length} chars>`);
      else console.log(`  ${k}: ${JSON.stringify(v).slice(0, 200)}`);
    }
  }
  const ann = p.reviewAnnotations as Record<string, unknown> | null;
  if (ann) {
    console.log(`reviewAnnotations keys: ${Object.keys(ann).join(", ")}`);
  } else {
    console.log(`reviewAnnotations: null`);
  }
  // Look for any related "answer canvas" model
  await prisma.$disconnect();
})();
