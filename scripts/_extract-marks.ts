// Extract individual tick + cross glyphs from the two grid sheets at
// public/Marking/{ticks,cross}.PNG into per-glyph PNGs.
//
// ticks.PNG  — 4 columns × 4 rows = 16 ticks
// cross.PNG  — 4 columns × 1 row  =  4 crosses
//
// In the source ticks.PNG the row-1 ticks reach BELOW their grid line
// and the row-2 ticks reach ABOVE theirs, so a naive per-cell bbox
// captures the bottom of one tick AND the top of the next. We fix
// this by finding the LARGEST connected red blob inside each cell —
// the bleed is always a smaller fragment than the cell's real tick,
// so the largest component wins.
//
// Alpha is keyed off REDNESS (R minus average of G+B), so anti-aliased
// grey edges don't survive as a dirty halo.

import sharp from "sharp";
import path from "path";
import { promises as fs } from "fs";

const OUT_DIR = path.join("public", "Marking");

function isInk(R: number, G: number, B: number): boolean {
  return R > 100 && R - (G + B) / 2 > 30;
}

// Iterative DFS — find the largest 4-connected red component inside
// (x0,y0)..(x0+cellW,y0+cellH). Returns the bbox in cell-local
// coordinates plus a Uint8Array mask flagging which pixels belong to
// it (so the second pass keeps only those, not stray noise inside the
// same bbox).
function largestComponent(
  src: Buffer,
  W: number,
  x0: number,
  y0: number,
  cellW: number,
  cellH: number,
): { minX: number; minY: number; maxX: number; maxY: number; mask: Uint8Array } | null {
  const visited = new Uint8Array(cellW * cellH);
  let best: { minX: number; minY: number; maxX: number; maxY: number; mask: Uint8Array } | null = null;
  let bestSize = 0;

  for (let sy = 0; sy < cellH; sy++) {
    for (let sx = 0; sx < cellW; sx++) {
      const startIdx = sy * cellW + sx;
      if (visited[startIdx]) continue;
      const srcI0 = ((y0 + sy) * W + (x0 + sx)) * 4;
      if (!isInk(src[srcI0], src[srcI0 + 1], src[srcI0 + 2])) continue;

      // DFS / flood
      const mask = new Uint8Array(cellW * cellH);
      const stack: number[] = [startIdx];
      visited[startIdx] = 1;
      mask[startIdx] = 1;
      let count = 0;
      let minX = sx, maxX = sx, minY = sy, maxY = sy;
      while (stack.length) {
        const idx = stack.pop()!;
        count++;
        const py = (idx / cellW) | 0;
        const px = idx - py * cellW;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        const neighbours = [
          py + 1 < cellH ? idx + cellW : -1,
          py - 1 >= 0 ? idx - cellW : -1,
          px + 1 < cellW ? idx + 1 : -1,
          px - 1 >= 0 ? idx - 1 : -1,
        ];
        for (const ni of neighbours) {
          if (ni < 0 || visited[ni]) continue;
          const nrIdx = (ni / cellW) | 0;
          const ncIdx = ni - nrIdx * cellW;
          const srcJ = ((y0 + nrIdx) * W + (x0 + ncIdx)) * 4;
          if (!isInk(src[srcJ], src[srcJ + 1], src[srcJ + 2])) continue;
          visited[ni] = 1;
          mask[ni] = 1;
          stack.push(ni);
        }
      }

      if (count > bestSize) {
        bestSize = count;
        best = { minX, minY, maxX, maxY, mask };
      }
    }
  }
  return best;
}

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
      const x0 = c * cellW;
      const y0 = r * cellH;

      const blob = largestComponent(src as Buffer, W, x0, y0, cellW, cellH);
      if (!blob) {
        console.warn(`  ${namePrefix}-${n}: no ink — skip`);
        continue;
      }
      const detW = blob.maxX - blob.minX + 1;
      const detH = blob.maxY - blob.minY + 1;
      if (detW < 80 || detH < 80) {
        console.warn(`  ${namePrefix}-${n}: sliver (${detW}x${detH}) — skip`);
        continue;
      }

      const pad = 4;
      const bx = Math.max(0, blob.minX - pad);
      const by = Math.max(0, blob.minY - pad);
      const bw = Math.min(cellW - bx, detW + 2 * pad);
      const bh = Math.min(cellH - by, detH + 2 * pad);

      // Build RGBA output. Only pixels inside the connected component
      // contribute ink colour; everything else (including bleed from a
      // neighbouring cell that happens to share the bbox rectangle) is
      // forced transparent.
      const out = Buffer.alloc(bw * bh * 4);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const cellIdx = (by + y) * cellW + (bx + x);
          const dstI = (y * bw + x) * 4;
          if (!blob.mask[cellIdx]) {
            out[dstI] = 0; out[dstI + 1] = 0; out[dstI + 2] = 0; out[dstI + 3] = 0;
            continue;
          }
          const srcI = ((y0 + by + y) * W + (x0 + bx + x)) * 4;
          const R = src[srcI], G = src[srcI + 1], B = src[srcI + 2];
          const redness = R - (G + B) / 2;
          if (redness >= 30) {
            out[dstI] = R; out[dstI + 1] = G; out[dstI + 2] = B; out[dstI + 3] = 255;
          } else if (redness > 10) {
            out[dstI] = R; out[dstI + 1] = G; out[dstI + 2] = B;
            out[dstI + 3] = Math.round(255 * (redness - 10) / 20);
          } else {
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
