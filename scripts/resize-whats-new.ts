// Resize every PNG in a What's New popup folder to the popup's target
// display size (800x450, 16:9). Pads to fit — never crops — so a
// portrait screenshot ends up centred with white bars on either side
// rather than clipped. Writes back in place; run again after re-
// uploading a new source screenshot.
//
// Usage:
//   npx tsx scripts/resize-whats-new.ts                    (essay-coach folder)
//   npx tsx scripts/resize-whats-new.ts <folder-name>      (any subfolder of public/whats-new)
//
// Requires: sharp (already a dependency).

import sharp from "sharp";
import { readdir, readFile, writeFile, stat } from "fs/promises";
import path from "path";

const TARGET_W = 800;
const TARGET_H = 450;
const BG = { r: 255, g: 255, b: 255, alpha: 1 } as const;

async function main() {
  const folder = process.argv[2] ?? "essay-coach";
  const dir = path.resolve("public/whats-new", folder);
  const entries = await readdir(dir);
  const pngs = entries.filter(f => /\.png$/i.test(f));
  if (pngs.length === 0) {
    console.log(`No PNGs found in ${dir}`);
    return;
  }
  console.log(`Resizing ${pngs.length} PNG(s) in ${dir} → ${TARGET_W}x${TARGET_H}\n`);
  for (const name of pngs) {
    const file = path.join(dir, name);
    const before = await stat(file);
    const original = await readFile(file);
    const meta = await sharp(original).metadata();
    // Skip if already exactly the target size — script is idempotent.
    if (meta.width === TARGET_W && meta.height === TARGET_H) {
      console.log(`  = ${name.padEnd(24)} already ${TARGET_W}x${TARGET_H} (${(before.size / 1024).toFixed(1)} KB) — skipped`);
      continue;
    }
    // `fit: contain` scales to fit inside the box preserving aspect,
    // padding the remaining space with the background colour. `withoutEnlargement:false` so a small
    // source still fills the frame. Palette+quality tuning lands the
    // output at ~30-90 KB for a typical UI screenshot.
    const buf = await sharp(original)
      .resize(TARGET_W, TARGET_H, { fit: "contain", background: BG })
      .png({ compressionLevel: 9, palette: true, quality: 82 })
      .toBuffer();
    await writeFile(file, buf);
    const after = await stat(file);
    const delta = (after.size - before.size) / 1024;
    const arrow = delta >= 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
    console.log(`  ✓ ${name.padEnd(24)} ${meta.width}x${meta.height} → ${TARGET_W}x${TARGET_H}   ${(before.size / 1024).toFixed(1)} KB → ${(after.size / 1024).toFixed(1)} KB (${arrow} KB)`);
  }
  console.log("\nDone.");
}
main().catch(e => { console.error(e); process.exit(1); });
