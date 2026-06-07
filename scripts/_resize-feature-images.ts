import sharp from "sharp";
import path from "path";

const FILES = ["marking_combined.png", "explanation.png", "weaktopics.png", "accuracy.png"];
const TARGET = { width: 1600, height: 1200 };

async function main() {
  for (const f of FILES) {
    const p = path.join("public", f);
    const meta = await sharp(p).metadata();
    console.log(`${f}: was ${meta.width}x${meta.height}`);
    const buf = await sharp(p)
      .resize({
        width: TARGET.width,
        height: TARGET.height,
        fit: "contain",
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .png()
      .toBuffer();
    await sharp(buf).toFile(p);
    const m2 = await sharp(p).metadata();
    console.log(`  → ${m2.width}x${m2.height}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
