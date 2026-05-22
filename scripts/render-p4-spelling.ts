// Render every page of the P4 Chinese spelling PDF to a JPG.

import { renderPdfToJpegs } from "../src/lib/pdf-server";
import * as fs from "fs";
import * as path from "path";

const PDF = "C:/Users/peter/Yuna teach/Data Past Year Papers/PSLE Chinese/P4 Chinese spelling.pdf";
const OUT_DIR = path.join(__dirname, "p4-spelling-pages");

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const buf = fs.readFileSync(PDF);
  const jpgs = await renderPdfToJpegs(buf, 2400, 88);
  console.log(`Rendered ${jpgs.length} pages`);
  for (let i = 0; i < jpgs.length; i++) {
    const p = path.join(OUT_DIR, `page-${String(i + 1).padStart(2, "0")}.jpg`);
    fs.writeFileSync(p, jpgs[i]);
    console.log(`  ${p} (${(jpgs[i].length / 1024).toFixed(0)} KB)`);
  }
})();
