// Server-side LaTeX → PNG renderer used by the printable PDF route.
//
// Pipeline: MathJax (TeX → SVG) → resvg-js (SVG → PNG). Both deps are
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

import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { Resvg } from "@resvg/resvg-js";

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

const cache = new Map<string, MathImage | null>();

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
export function renderLatexToPng(latex: string, fontSize: number): MathImage | null {
  const key = `${latex}::${fontSize}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  try {
    const { doc, adaptor } = ensureMathJax();
    const node = doc.convert(latex, { display: false });
    // adaptor.innerHTML returns the SVG string (the math is wrapped
    // in a single <svg> element).
    const rawSvg = (adaptor as unknown as { innerHTML: (n: unknown) => string }).innerHTML(node);

    // Parse the ex-based dimensions before stripping them — resvg
    // doesn't understand `ex`, but we need them to compute the PDF
    // footprint and baseline shift.
    const widthEx = parseFloat(/width="([\d.]+)ex"/.exec(rawSvg)?.[1] ?? "0");
    const heightEx = parseFloat(/height="([\d.]+)ex"/.exec(rawSvg)?.[1] ?? "0");
    const valignEx = parseFloat(/vertical-align:\s*([-\d.]+)ex/.exec(rawSvg)?.[1] ?? "0");
    if (!widthEx || !heightEx) {
      cache.set(key, null);
      return null;
    }

    // Strip the `width`/`height` attributes (which use ex units)
    // and the inline `style` (which uses vertical-align). Leave
    // the viewBox intact — resvg uses it for aspect ratio.
    const cleanSvg = rawSvg
      .replace(/\s(width|height)="[^"]*"/g, "")
      .replace(/\sstyle="[^"]*"/g, "");

    const widthPt = widthEx * PT_PER_EX(fontSize);
    const heightPt = heightEx * PT_PER_EX(fontSize);
    // valign is reported as a NEGATIVE ex value when the math
    // descends below the baseline (e.g. fractions). Flip sign so
    // descentPt is a positive "how far below baseline" number.
    const descentPt = -valignEx * PT_PER_EX(fontSize);

    const pxWidth = Math.max(1, Math.ceil(widthPt * PX_PER_PT));
    const pxHeight = Math.max(1, Math.ceil(heightPt * PX_PER_PT));

    const resvg = new Resvg(cleanSvg, {
      background: "rgba(255,255,255,0)",
      fitTo: { mode: "width", value: pxWidth },
    });
    const rendered = resvg.render();
    const png = rendered.asPng();

    const result: MathImage = {
      png,
      pxWidth: rendered.width,
      pxHeight: rendered.height,
      widthPt,
      heightPt,
      descentPt,
    };
    cache.set(key, result);
    return result;
  } catch (err) {
    console.warn(
      `[math-render] failed for "${latex}":`,
      err instanceof Error ? err.message : err,
    );
    cache.set(key, null);
    return null;
  }
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
