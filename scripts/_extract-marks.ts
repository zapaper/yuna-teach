// Extract individual tick + cross glyphs from the two grid sheets at
// public/Marking/{ticks,cross}.PNG into per-glyph PNGs.
//
// ticks.PNG  — 4 columns × 4 rows = 16 ticks
// cross.PNG  — 4 columns × 1 row  =  4 crosses
//
// Alpha is keyed off REDNESS (R minus average of G+B) rather than
// luminance, so anti-aliased grey edges don't survive as a dirty halo
// the way they did with a simple white-background trim. Anything that
// isn't visibly red becomes fully transparent; partial-red edges fade.

import sharp from "sharp";
import path from "path";
import { promises as fs } from "fs";

const OUT_DIR = path.join("public", "Marking");

async function extractGrid(srcPath: string, cols: number, rows: number, namePrefix: string) {
  const { data: src, info } = await sharp(srcPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const cellW = Math.floor(W / cols);
  const cellH = Math.floor(H / rows);

  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      n++;
      // First pass: find bounding box of ink (red) pixels in this cell.
      let minX = cellW, minY = cellH, maxX = -1, maxY = -1;
      for (let y = 0; y < cellH; y++) {
        for (let x = 0; x < cellW; x++) {
          const i = ((r * cellH + y) * W + (c * cellW + x)) * 4;
          const R = src[i], G = src[i + 1], B = src[i + 2];
          const redness = R - (G + B) / 2;
          if (redness > 30 && R > 100) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) {
        console.warn(`  ${namePrefix}-${n}: no ink — skip`);
        continue;
      }
      const detW = maxX - minX + 1;
      const detH = maxY - minY + 1;
      if (detW < 80 || detH < 80) {
        console.warn(`  ${namePrefix}-${n}: sliver (${detW}x${detH}) — skip`);
        continue;
      }
      const pad = 4;
      const bx = Math.max(0, minX - pad);
      const by = Math.max(0, minY - pad);
      const bw = Math.min(cellW - (minX - bx), detW + 2 * pad);
      const bh = Math.min(cellH - (minY - by), detH + 2 * pad);

      // Second pass: build a clean RGBA buffer where redness drives alpha.
      // - redness > 30 → fully opaque (ink)
      // - redness 10..30 → graded alpha (anti-aliased ink edges)
      // - redness ≤ 10 → fully transparent (paper, jpeg noise)
      const out = Buffer.alloc(bw * bh * 4);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const srcI = ((r * cellH + by + y) * W + (c * cellW + bx + x)) * 4;
          const dstI = (y * bw + x) * 4;
          const R = src[srcI], G = src[srcI + 1], B = src[srcI + 2];
          const redness = R - (G + B) / 2;
          if (redness >= 30) {
            out[dstI] = R; out[dstI + 1] = G; out[dstI + 2] = B; out[dstI + 3] = 255;
          } else if (redness > 10) {
            out[dstI] = R; out[dstI + 1] = G; out[dstI + 2] = B;
            out[dstI + 3] = Math.round(255 * (redness - 10) / 20);
          } else {
            // Fully transparent — RGB doesn't matter but keep 0,0,0 so
            // any viewer that ignores alpha shows a clean black rather
            // than dirty grey (cleaner debug signal).
            out[dstI] = 0; out[dstI + 1] = 0; out[dstI + 2] = 0; out[dstI + 3] = 0;
          }
        }
      }

      const pngBuf = await sharp(out, { raw: { width: bw, height: bh, channels: 4 } })
        .png({ compressionLevel: 6, force: true })
        .toBuffer();

      const outPath = path.join(OUT_DIR, `${namePrefix}-${String(n).padStart(2, "0")}.png`);
      await fs.writeFile(outPath, pngBuf);
      console.log(`  ${namePrefix}-${String(n).padStart(2, "0")}.png  ${bw}x${bh}`);
    }
  }
}

async function main() {
  console.log("ticks.PNG (4×4):");
  await extractGrid(path.join(OUT_DIR, "ticks.PNG"), 4, 4, "tick");
  console.log("\ncross.PNG (4×1):");
  await extractGrid(path.join(OUT_DIR, "cross.PNG"), 4, 1, "cross");
}

main().catch((e) => { console.error(e); process.exit(1); });
