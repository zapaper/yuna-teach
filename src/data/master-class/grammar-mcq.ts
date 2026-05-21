// Master Class content is authored in YAML — see ./grammar-mcq.yaml.
// A pre-build step (scripts/build-master-class.mjs, wired into the
// `prebuild` + `postinstall` npm scripts) converts it to
// ./grammar-mcq.generated.json which this module imports directly.

import data from "./grammar-mcq.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const grammarMcq: MasterClassContent = data as MasterClassContent;
