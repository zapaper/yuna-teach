import sharp from "sharp";

async function main() {
  for (const f of ["public/Marking/cross.PNG", "public/Marking/ticks.PNG"]) {
    const meta = await sharp(f).metadata();
    console.log(`${f}: ${meta.width}x${meta.height} ${meta.channels} channels`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
