// Server-side PDF -> JPEG buffers using pdfjs-dist + @napi-rs/canvas.
// We need this for inbound-email scans: parents email a single PDF
// containing all pages, but the marking pipeline expects per-page JPGs
// at submissions/<paperId>/page_N.jpg. Pure-JS rendering would require
// a canvas; @napi-rs/canvas is a native Node binding that satisfies the
// CanvasFactory contract pdfjs needs.
//
// pdfjs-dist v5 ships an ESM build that works in Node when imported
// from the .mjs entry. We pin to disableFontFace + useSystemFonts:false
// so it doesn't try to fetch CDN fonts at render time.

import { createCanvas, type SKRSContext2D, type Canvas } from "@napi-rs/canvas";
import path from "path";
import { pathToFileURL } from "url";

// Locate pdfjs-dist's bundled standard fonts + CMaps so we can pass
// them as file:// URLs to getDocument(). Without these, every PDF
// that references Helvetica / Times / Arial (i.e. nearly every PDF)
// logs "UnknownErrorException: Ensure that the standardFontDataUrl
// API parameter is provided" and falls back to a default font that
// can corrupt text rendering. CMaps matter for CJK encoded PDFs
// (PSLE Chinese papers, prelim papers from local schools).
//
// Computed lazily (not at module top level): Turbopack intercepts
// createRequire / import.meta.url at build time and returns numeric
// module IDs in place of file paths, which crashes path.dirname()
// during `next build` page-data collection. process.cwd() resolves
// to the runtime app root at request time and is bundler-safe.
let _fontUrls: { standardFontDataUrl: string; cMapUrl: string } | null = null;
function getPdfjsAssetUrls() {
  if (!_fontUrls) {
    const pkgRoot = path.join(process.cwd(), "node_modules", "pdfjs-dist");
    _fontUrls = {
      standardFontDataUrl: pathToFileURL(path.join(pkgRoot, "standard_fonts") + "/").href,
      cMapUrl: pathToFileURL(path.join(pkgRoot, "cmaps") + "/").href,
    };
  }
  return _fontUrls;
}

type CanvasAndContext = { canvas: Canvas; context: SKRSContext2D };

class NodeCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    return { canvas, context };
  }
  reset(c: CanvasAndContext, width: number, height: number) {
    c.canvas.width = width;
    c.canvas.height = height;
  }
  destroy(c: CanvasAndContext) {
    c.canvas.width = 0;
    c.canvas.height = 0;
  }
}

let _pdfjs: typeof import("pdfjs-dist") | null = null;
async function getPdfjs() {
  if (!_pdfjs) {
    _pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs") as typeof import("pdfjs-dist");
  }
  return _pdfjs;
}

export async function renderPdfToJpegs(
  buf: Buffer,
  maxDim = 2048,
  quality = 85,
): Promise<Buffer[]> {
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(buf);
  const { standardFontDataUrl, cMapUrl } = getPdfjsAssetUrls();
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    standardFontDataUrl,
    cMapUrl,
    cMapPacked: true,
  }).promise;

  const factory = new NodeCanvasFactory();
  const out: Buffer[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(maxDim / baseViewport.width, maxDim / baseViewport.height, 2);
      const viewport = page.getViewport({ scale });
      const w = Math.ceil(viewport.width);
      const h = Math.ceil(viewport.height);
      const cc = factory.create(w, h);
      await page.render({
        canvas: cc.canvas as unknown as HTMLCanvasElement,
        canvasContext: cc.context as unknown as CanvasRenderingContext2D,
        viewport,
        canvasFactory: factory as unknown as object,
        background: "white",
        // ENABLE annotations (annotationMode = 1). Teachers / parents
        // often mark up exam PDFs with digital annotations (highlights,
        // free-text comments, ink drawings) using Adobe, GoodNotes,
        // iPad markup, etc. These are stored as PDF annotation objects
        // — distinct from the page content stream — and previously
        // setting annotationMode: 0 meant we silently rendered the
        // unmarked original. The diagnostic flow specifically needs
        // those marks to read teacher's totals + per-question scores.
        // (Trade-off: re-introduces the 'AnnotationBorderStyle ignoring
        // width' warning on PDFs with fractional border widths. Cosmetic.)
        annotationMode: 1,
      } as Parameters<typeof page.render>[0]).promise;
      out.push(cc.canvas.toBuffer("image/jpeg", quality));
      factory.destroy(cc);
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return out;
}
