// Copies the opencv.js runtime out of node_modules into public/vendor/
// so DocumentScanner can load it via a <script> tag at run time. The
// bundler (Turbopack) blows its parser stack trying to walk the multi-
// megabyte opencv.js source — by serving it as a static asset we skip
// the bundler entirely. Runs from `postinstall` so the file is present
// on every install (Railway's build, local dev, CI).

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

const src = "node_modules/@techstark/opencv-js/dist/opencv.js";
const dst = "public/vendor/opencv.js";

if (!existsSync(src)) {
  // Soft fail: the package may not be installed yet (e.g. running
  // `npm install --omit=dev` in some environments). The DocumentScanner
  // surfaces a friendly error when /vendor/opencv.js 404s.
  console.warn(`[copy-opencv] ${src} not found — skipping`);
  process.exit(0);
}
mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);
const { size } = statSync(dst);
console.log(`[copy-opencv] copied ${(size / 1024 / 1024).toFixed(1)} MB → ${dst}`);
