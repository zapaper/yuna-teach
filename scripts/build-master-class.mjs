// Build step: convert every src/data/master-class/*.yaml to a sibling
// *.generated.json file. The TS modules import the JSON (works in both
// server and client bundles, unlike the YAML+fs runtime approach which
// fails in client components).
//
// Run via `npm run build` (prebuild hook) and on `npm install`
// (postinstall hook). Authors edit the YAML; this script regenerates
// the JSON before Next bundles.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "src/data/master-class");

if (!fs.existsSync(dataDir)) {
  console.log(`[master-class] No data dir at ${dataDir}, skipping`);
  process.exit(0);
}

const yamlFiles = fs.readdirSync(dataDir).filter(f => f.endsWith(".yaml"));
if (yamlFiles.length === 0) {
  console.log(`[master-class] No YAML files in ${dataDir}`);
  process.exit(0);
}

let count = 0;
for (const f of yamlFiles) {
  const yamlPath = path.join(dataDir, f);
  const yamlText = fs.readFileSync(yamlPath, "utf8");
  let parsed;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    console.error(`[master-class] Failed to parse ${f}: ${err.message}`);
    process.exit(1);
  }
  const jsonPath = path.join(dataDir, f.replace(/\.yaml$/, ".generated.json"));
  fs.writeFileSync(jsonPath, JSON.stringify(parsed, null, 2) + "\n");
  console.log(`[master-class] ${f} → ${path.basename(jsonPath)}`);
  count++;
}
console.log(`[master-class] generated ${count} JSON file${count === 1 ? "" : "s"}`);
