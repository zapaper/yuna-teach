// Master Class content is authored in YAML — see ./grammar-mcq-1.yaml.
// A pre-build step (scripts/build-master-class.mjs, wired into the
// `prebuild` + `postinstall` npm scripts) converts it to
// ./grammar-mcq-1.generated.json which this module imports directly.

import data from "./grammar-mcq-1.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const grammarMcq1: MasterClassContent = data as MasterClassContent;
