// Render essay1 + essay2 as a single overlapping PNG to serve on
// mobile. Desktop already shows them as two overlapping HTML cards
// via .essay-card.back / .essay-card.front (in preview-v2/index.html);
// on phones the cards stack instead, which loses the "before/after"
// punch. This compositor writes essay_overlap_mobile.png with the
// same back+front overlap baked in, plus the coloured header strips
// ("Original 29/40" / "Enhanced 36/40").
//
// Output: public/preview-v2/assets/essay_overlap_mobile.png
// Run:    npx tsx scripts/_compose-essay-overlap.ts

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { writeFile } from "fs/promises";
import path from "path";

const CARD_W = 1000;             // both cards rendered at this width
const HEADER_H = 64;             // coloured strip above each essay
const OFFSET_RIGHT = 220;        // front card pushed this far right of back
const OVERLAP_Y_FRAC = 0.62;     // front's top sits this fraction down the back card

(async () => {
  const assets = path.join(__dirname, "..", "public", "preview-v2", "assets");
  const back = await loadImage(path.join(assets, "essay1.png"));
  const front = await loadImage(path.join(assets, "essay2.png"));

  // Scale both essay PNGs to CARD_W (keep aspect).
  const backH = Math.round((back.height / back.width) * CARD_W);
  const frontH = Math.round((front.height / front.width) * CARD_W);

  const backBlockH = HEADER_H + backH;
  const frontBlockH = HEADER_H + frontH;
  const overlapY = Math.round(backBlockH * OVERLAP_Y_FRAC);

  const W = OFFSET_RIGHT + CARD_W + 24;          // 24 px right padding
  const H = overlapY + frontBlockH + 24;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  // Transparent canvas — caller can place on any background.

  const drawCard = (
    x: number,
    y: number,
    headerBg: string,
    headerColor: string,
    title: string,
    score: string,
    img: Awaited<ReturnType<typeof loadImage>>,
    imgH: number,
  ) => {
    // Soft drop shadow under the whole card.
    ctx.save();
    ctx.shadowColor = "rgba(11, 31, 58, 0.18)";
    ctx.shadowBlur = 22;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(x, y, CARD_W, HEADER_H + imgH);
    ctx.restore();
    // Header strip.
    ctx.fillStyle = headerBg;
    ctx.fillRect(x, y, CARD_W, HEADER_H);
    ctx.fillStyle = headerColor;
    ctx.textBaseline = "middle";
    ctx.font = "bold 26px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(title, x + 22, y + HEADER_H / 2);
    ctx.textAlign = "right";
    ctx.font = "bold 30px sans-serif";
    ctx.fillText(score, x + CARD_W - 22, y + HEADER_H / 2);
    ctx.textAlign = "left";
    // Essay image.
    ctx.drawImage(img, x, y + HEADER_H, CARD_W, imgH);
    // Card border.
    ctx.strokeStyle = "#E4EEEA";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, CARD_W - 1, HEADER_H + imgH - 1);
  };

  // Back card first.
  drawCard(0, 0, "#FFF4F4", "#B42318", "Original — as submitted", "29/40", back, backH);
  // Front card on top, offset right + down.
  drawCard(OFFSET_RIGHT, overlapY, "#ECFDF3", "#067647", "Enhanced — upgrades in green", "36/40", front, frontH);

  const out = path.join(assets, "essay_overlap_mobile.png");
  const buf = canvas.toBuffer("image/png");
  await writeFile(out, buf);
  console.log(`Wrote ${out}  (${(buf.length / 1024).toFixed(1)} KB, ${W}×${H})`);
})().catch(e => { console.error(e); process.exit(1); });
