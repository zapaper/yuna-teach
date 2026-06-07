import { readFileSync } from "fs";
import { join } from "path";

const PAPER = process.argv[2];
if (!PAPER) { console.log("Usage: tsx _trigger-mark.ts <paperId>"); process.exit(1); }

const cookieValue = readFileSync(join("eval", "cookie.txt"), "utf8").trim();
const cookie = `yuna_session=${cookieValue}`;
const baseUrl = "https://www.markforyou.com";

async function main() {
  console.log(`POST ${baseUrl}/api/exam/${PAPER}/mark`);
  const res = await fetch(`${baseUrl}/api/exam/${PAPER}/mark`, {
    method: "POST",
    headers: { cookie },
  });
  console.log(`status: ${res.status}`);
  const text = await res.text();
  console.log(`body: ${text}`);
  process.exit(res.ok ? 0 : 1);
}
main();
