import sharp from "sharp";

// CamScanner-style watermarks sit in the bottom-right corner of every scanned
// page. A plain white rectangle composited over that area removes them before
// extraction/marking sees the image. Constants are percentages of the page.
export const WATERMARK_MASK_BOTTOM_PCT = 0.08;
export const WATERMARK_MASK_RIGHT_PCT = 0.20;
// Top-left corner: scanner apps stamp a small icon / login email on the first
// page. Defaults match the bottom-right shape so the result looks symmetric.
export const WATERMARK_MASK_TOP_PCT = 0.08;
export const WATERMARK_MASK_LEFT_PCT = 0.20;

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

export async function maskTopLeftCorner(
  buf: Buffer,
  topPct = WATERMARK_MASK_TOP_PCT,
  leftPct = WATERMARK_MASK_LEFT_PCT,
): Promise<Buffer> {
  try {
    const meta = await sharp(buf).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) return buf;
    const maskW = Math.max(1, Math.ceil(W * leftPct));
    const maskH = Math.max(1, Math.ceil(H * topPct));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${maskW}" height="${maskH}"><rect width="100%" height="100%" fill="white"/></svg>`;
    return await sharp(buf)
      .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch {
    return buf;
  }
}

// Convenience wrapper: applies whichever corners are requested in one
// sharp pipeline (composite supports an array, so we only re-encode once).
export async function maskCorners(
  buf: Buffer,
  opts: {
    bottomRight?: boolean;
    topLeft?: boolean;
    bottomPct?: number;
    rightPct?: number;
    topPct?: number;
    leftPct?: number;
  },
): Promise<Buffer> {
  try {
    const meta = await sharp(buf).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) return buf;
    const ops: sharp.OverlayOptions[] = [];
    if (opts.bottomRight) {
      const maskW = Math.max(1, Math.ceil(W * (opts.rightPct ?? WATERMARK_MASK_RIGHT_PCT)));
      const maskH = Math.max(1, Math.ceil(H * (opts.bottomPct ?? WATERMARK_MASK_BOTTOM_PCT)));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${maskW}" height="${maskH}"><rect width="100%" height="100%" fill="white"/></svg>`;
      ops.push({ input: Buffer.from(svg), left: W - maskW, top: H - maskH });
    }
    if (opts.topLeft) {
      const maskW = Math.max(1, Math.ceil(W * (opts.leftPct ?? WATERMARK_MASK_LEFT_PCT)));
      const maskH = Math.max(1, Math.ceil(H * (opts.topPct ?? WATERMARK_MASK_TOP_PCT)));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${maskW}" height="${maskH}"><rect width="100%" height="100%" fill="white"/></svg>`;
      ops.push({ input: Buffer.from(svg), left: 0, top: 0 });
    }
    if (ops.length === 0) return buf;
    return await sharp(buf).composite(ops).jpeg({ quality: 92 }).toBuffer();
  } catch {
    return buf;
  }
}
