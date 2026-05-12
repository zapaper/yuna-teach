// Server-side LaTeX → PNG renderer used by the printable PDF route.
//
// Pipeline: MathJax (TeX → SVG) → sharp (SVG → PNG). Both deps are
// pure Node — they work inside Next's API routes with no headless
// browser. We oversample by 4x so the embedded image still looks
// crisp when scaled into the PDF at ~11pt body size.
//
// The MathJax document is initialised once per process (module-level
// singleton). The TeX input jax allocates a few MB of grammar tables
// on first construction, so this is a real cost we want to amortise.
//
// Results are cached in-memory by `${latex}::${fontSize}`. A single
// printable usually contains the same fractions / square roots
// dozens of times across sub-parts and answer keys — caching saves
// 10-20x on rendering time without bloating memory (PNG buffers for
// typical primary-school math are <2KB each).
//
// Notes on dependency choice: we previously used @resvg/resvg-js for
// the SVG→PNG step but Turbopack couldn't externalize its native
// .node binding cleanly (build failed with "non-ecmascript placeable
// asset"). sharp is already a dependency, already covered by the
// project's outputFileTracingIncludes, and handles MathJax's SVG
// just fine via its libvips SVG backend.

import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import sharp from "sharp";

type MJDocument = {
  convert: (input: string, options?: { display?: boolean }) => unknown;
};

let mjDoc: MJDocument | null = null;
let mjAdaptor: ReturnType<typeof liteAdaptor> | null = null;

function ensureMathJax(): { doc: MJDocument; adaptor: ReturnType<typeof liteAdaptor> } {
  if (mjDoc && mjAdaptor) return { doc: mjDoc, adaptor: mjAdaptor };
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const tex = new TeX({ packages: AllPackages });
  const svg = new SVG({ fontCache: "none" });
  mjDoc = mathjax.document("", { InputJax: tex, OutputJax: svg }) as MJDocument;
  mjAdaptor = adaptor;
  return { doc: mjDoc, adaptor };
}

export type MathImage = {
  png: Buffer;
  // Pixel dimensions of the rendered PNG. These are 4x oversampled,
  // so when embedding in the PDF you divide by `pxPerPt` to get the
  // intended footprint in PDF points.
  pxWidth: number;
  pxHeight: number;
  // Footprint at the requested body font size, in PDF points.
  widthPt: number;
  heightPt: number;
  // How far the image extends below the text baseline (in points).
  // MathJax reports this as a CSS `vertical-align: -Nex` on the
  // outer <svg>. Drawn images sit on their bottom edge in pdf-lib,
  // so the PDF code uses this to shift the image down so its
  // baseline lines up with the surrounding text baseline.
  descentPt: number;
};

// sharp's SVG → PNG path is async (Promise-returning), so we cache
// the in-flight Promise rather than just the resolved value. That
// way the second call for the same expression piggybacks on the
// first render rather than starting a fresh raster job.
const cache = new Map<string, Promise<MathImage | null>>();

// 1 em ≈ fontSize pt; 1 ex ≈ fontSize/2 pt (close enough for
// MathJax's sizing — its internal "ex" assumes a font with
// ex-height ~half its em).
const PT_PER_EX = (fontSize: number) => fontSize / 2;
// 4x oversample is the sweet spot — enough to look sharp on a
// 600 dpi print but small enough not to blow up the PDF.
const PX_PER_PT = 4;

/**
 * Render a single LaTeX expression to a PNG buffer suitable for
 * pdf-lib's `embedPng`. Returns null on parse / render failure so
 * callers can gracefully fall back to plain text.
 */
export function renderLatexToPng(latex: string, fontSize: number): Promise<MathImage | null> {
  const key = `${latex}::${fontSize}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const job: Promise<MathImage | null> = (async () => {
    try {
      const { doc, adaptor } = ensureMathJax();
      const node = doc.convert(latex, { display: false });
      // adaptor.innerHTML returns the SVG string (the math is
      // wrapped in a single <svg> element).
      const rawSvg = (adaptor as unknown as { innerHTML: (n: unknown) => string }).innerHTML(node);

      // Parse the ex-based dimensions before stripping them — the
      // raster engine wants absolute pixel sizes, and we need the
      // ex values to compute the PDF footprint and baseline shift.
      const widthEx = parseFloat(/width="([\d.]+)ex"/.exec(rawSvg)?.[1] ?? "0");
      const heightEx = parseFloat(/height="([\d.]+)ex"/.exec(rawSvg)?.[1] ?? "0");
      const valignEx = parseFloat(/vertical-align:\s*([-\d.]+)ex/.exec(rawSvg)?.[1] ?? "0");
      if (!widthEx || !heightEx) return null;

      const widthPt = widthEx * PT_PER_EX(fontSize);
      const heightPt = heightEx * PT_PER_EX(fontSize);
      // valign is reported as a NEGATIVE ex value when the math
      // descends below the baseline (e.g. fractions). Flip sign so
      // descentPt is a positive "how far below baseline" number.
      const descentPt = -valignEx * PT_PER_EX(fontSize);

      const pxWidth = Math.max(1, Math.ceil(widthPt * PX_PER_PT));
      const pxHeight = Math.max(1, Math.ceil(heightPt * PX_PER_PT));

      // Replace the ex-based dimensions with the exact pixel size we
      // want sharp to rasterise at. Leaving them as ex caused libvips
      // to fall back to its default DPI assumption and produce a
      // mis-sized output. The viewBox stays untouched so the math
      // scales correctly.
      const sizedSvg = rawSvg
        .replace(/\swidth="[^"]*"/, ` width="${pxWidth}"`)
        .replace(/\sheight="[^"]*"/, ` height="${pxHeight}"`)
        .replace(/\sstyle="[^"]*"/g, "");

      const png = await sharp(Buffer.from(sizedSvg))
        .resize({ width: pxWidth, height: pxHeight, fit: "fill" })
        .png()
        .toBuffer();

      return {
        png,
        pxWidth,
        pxHeight,
        widthPt,
        heightPt,
        descentPt,
      };
    } catch (err) {
      console.warn(
        `[math-render] failed for "${latex}":`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  })();

  cache.set(key, job);
  return job;
}

// Math segment regex matching MathText's client-side detection:
// `$...$` with at least one `\command` inside so plain currency
// ("$5", "$120") is left alone. Used by callers that want to
// tokenize a mixed string into [plain, math, plain, ...].
export const MATH_SEGMENT_RE = /\$([^$\n]*\\[a-zA-Z][^$\n]*)\$/g;

export type Token =
  | { kind: "text"; value: string }
  | { kind: "math"; value: string };

/** Split a mixed string into alternating text / math tokens. */
export function tokenizeMath(text: string): Token[] {
  const out: Token[] = [];
  let cursor = 0;
  // Reset lastIndex — the regex has the /g flag and tokenize is
  // called many times per request.
  MATH_SEGMENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATH_SEGMENT_RE.exec(text)) !== null) {
    if (m.index > cursor) out.push({ kind: "text", value: text.slice(cursor, m.index) });
    out.push({ kind: "math", value: m[1] });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) out.push({ kind: "text", value: text.slice(cursor) });
  return out;
}
