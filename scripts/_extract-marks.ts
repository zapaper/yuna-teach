// Extract individual tick + cross glyphs from the two grid sheets at
// public/Marking/{ticks,cross}.PNG into per-glyph PNGs.
//
// ticks.PNG  — 4 columns × 4 rows = 16 ticks
// cross.PNG  — 4 columns × 1 row  =  4 crosses
//
// We scan each cell's raw pixels and compute a tight bounding box around
// the red ink (any pixel where R is much higher than G/B), then crop to
// that box. The saved PNGs are made transparent: every "white" pixel
// (R, G, B all > 240) becomes alpha=0, so the glyph stamps cleanly onto
// the scanned-paper background in the export PDF.

import sharp from "sharp";
import path from "path";
import { promises as fs } from "fs";

const OUT_DIR = path.join("public", "Marking");

// Cell pixel is "ink" if it's distinctly red (the source ink) — drop
// off-white and near-white background.
function isInk(r: number, g: number, b: number): boolean {
  return r > 130 && r > g + 30 && r > b + 30;
}

async function extractGrid(srcPath: string, cols: number, rows: number, namePrefix: string) {
  // Load full source once as raw RGBA so we can slice without re-decoding.
  const { data: src, info } = await sharp(srcPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const cellW = Math.floor(W / cols);
  const cellH = Math.floor(H / rows);

  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      n++;
      const x0 = c * cellW;
      const y0 = r * cellH;

      // First pass: find tight bbox of ink inside this cell.
      let minX = cellW, minY = cellH, maxX = -1, maxY = -1;
      for (let y = 0; y < cellH; y++) {
        for (let x = 0; x < cellW; x++) {
          const i = ((y0 + y) * W + (x0 + x)) * 4;
          const R = src[i], G = src[i + 1], B = src[i + 2];
          if (isInk(R, G, B)) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) {
        console.warn(`  ${namePrefix}-${n}: no ink found — skipping`);
        continue;
      }
      // Skip partial-detection slivers (a thin band of red picked up
      // from antialiasing of a neighbouring cell's glyph). A real
      // tick / cross is always taller than ~80px in our sources.
      const detectedW = maxX - minX + 1;
      const detectedH = maxY - minY + 1;
      if (detectedH < 80 || detectedW < 80) {
        console.warn(`  ${namePrefix}-${n}: sliver (${detectedW}x${detectedH}) — skipping`);
        continue;
      }

      // Add a small padding so antialiased edges aren't clipped.
      const pad = 4;
      const bx = Math.max(0, minX - pad);
      const by = Math.max(0, minY - pad);
      const bw = Math.min(cellW, maxX - minX + 1 + 2 * pad);
      const bh = Math.min(cellH, maxY - minY + 1 + 2 * pad);

      // Second pass: write a transparent-background PNG of the bbox.
      const outBuf = Buffer.alloc(bw * bh * 4);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const srcI = ((y0 + by + y) * W + (x0 + bx + x)) * 4;
          const dstI = (y * bw + x) * 4;
          const R = src[srcI], G = src[srcI + 1], B = src[srcI + 2];
          // White → transparent. Otherwise keep colour, scale alpha so
          // mid-grey antialiased edges fade out instead of haloing.
          const lum = (R + G + B) / 3;
          if (lum > 235) {
            outBuf[dstI] = 255; outBuf[dstI + 1] = 255; outBuf[dstI + 2] = 255; outBuf[dstI + 3] = 0;
          } else {
            outBuf[dstI] = R;
            outBuf[dstI + 1] = G;
            outBuf[dstI + 2] = B;
            // Alpha derived from how "non-white" the pixel is.
            outBuf[dstI + 3] = Math.min(255, Math.round(255 * (1 - Math.max(0, lum - 80) / 175)));
          }
        }
      }

      const pngBuf = await sharp(outBuf, { raw: { width: bw, height: bh, channels: 4 } })
        .png()
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
