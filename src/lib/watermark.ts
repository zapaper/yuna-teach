import sharp from "sharp";

// CamScanner-style watermarks sit in the bottom-right corner of every scanned
// page. A plain white rectangle composited over that area removes them before
// extraction/marking sees the image. Constants are percentages of the page.
export const WATERMARK_MASK_BOTTOM_PCT = 0.06;
export const WATERMARK_MASK_RIGHT_PCT = 0.20;

export async function maskBottomRightCorner(
  buf: Buffer,
  bottomPct = WATERMARK_MASK_BOTTOM_PCT,
  rightPct = WATERMARK_MASK_RIGHT_PCT,
): Promise<Buffer> {
  try {
    const meta = await sharp(buf).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) return buf;
    const maskW = Math.max(1, Math.ceil(W * rightPct));
    const maskH = Math.max(1, Math.ceil(H * bottomPct));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${maskW}" height="${maskH}"><rect width="100%" height="100%" fill="white"/></svg>`;
    return await sharp(buf)
      .composite([{ input: Buffer.from(svg), left: W - maskW, top: H - maskH }])
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch {
    return buf;
  }
}
