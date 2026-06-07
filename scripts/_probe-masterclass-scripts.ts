import { prisma } from "../src/lib/db";

async function main() {
  const slug = process.argv[2] ?? "english-synthesis-tricks";
  const row = await prisma.masterClass.findUnique({ where: { slug } });
  if (!row) { console.log(`(no DB row for ${slug} — pure YAML is being served)`); return; }
  const keyScripts = Array.isArray(row.keyConceptScripts) ? row.keyConceptScripts as string[] : [];
  const mistakeScripts = Array.isArray(row.commonMistakeScripts) ? row.commonMistakeScripts as string[] : [];
  console.log(`slug: ${slug}`);
  console.log(`keyConceptScripts: ${keyScripts.length} entries`);
  keyScripts.forEach((s, i) => {
    const populated = s && s.trim().length > 0;
    console.log(`  [${i}] ${populated ? `${s.trim().length} chars — OVERLAYS YAML slide ${i}` : "(empty — YAML shows through)"}`);
    if (populated) console.log(`      preview: ${s.trim().slice(0, 120).replace(/\n/g, " ⏎ ")}`);
  });
  console.log(`\ncommonMistakeScripts: ${mistakeScripts.length} entries`);
  mistakeScripts.forEach((s, i) => {
    const populated = s && s.trim().length > 0;
    console.log(`  [${i}] ${populated ? `${s.trim().length} chars — OVERLAYS YAML mistake-slide ${i}` : "(empty)"}`);
  });
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
