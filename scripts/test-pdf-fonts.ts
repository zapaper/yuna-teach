import { promises as fs } from "fs";
import path from "path";
import { renderPdfToJpegs } from "../src/lib/pdf-server";

async function main() {
  // Try whatever PDF is on disk under chinese-supplementary/.
  const dir = path.join(process.cwd(), ".data", "chinese-supplementary");
  let pdf: string | null = null;
  try {
    for (const f of await fs.readdir(dir)) {
      if (f.endsWith(".pdf")) { pdf = path.join(dir, f); break; }
    }
  } catch { /* dir missing */ }
  if (!pdf) {
    console.log("(no PSLE Chinese PDF in .data/chinese-supplementary/ — upload one then re-run)");
    return;
  }
  const buf = await fs.readFile(pdf);
  console.log(`Rendering ${pdf} (${(buf.length / 1024).toFixed(0)} KB)…`);
  const pages = await renderPdfToJpegs(buf, 800, 80);
  console.log(`Rendered ${pages.length} pages, first page ${(pages[0].length / 1024).toFixed(0)} KB`);
  console.log("No 'standardFontDataUrl' warning above = fix works.");
}

main().catch(e => { console.error("FAIL:", e); process.exit(1); });
