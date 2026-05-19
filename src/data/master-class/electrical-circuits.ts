// Master Class content is authored in YAML — see ./electrical-circuits.yaml.
// A pre-build step (scripts/build-master-class.mjs, wired into the
// `prebuild` + `postinstall` npm scripts) converts it to
// ./electrical-circuits.generated.json which this module imports directly.
//
// Edit the .yaml file to change slide content / narration. Running
// `npm install` or `npm run build` regenerates the JSON. In dev you
// can re-run `node scripts/build-master-class.mjs` to refresh.

import data from "./electrical-circuits.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const electricalCircuits: MasterClassContent = data as MasterClassContent;
