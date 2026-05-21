// Master Class content is authored in YAML — see ./grammar-mcq-2.yaml.
// A pre-build step (scripts/build-master-class.mjs, wired into the
// `prebuild` + `postinstall` npm scripts) converts it to
// ./grammar-mcq-2.generated.json which this module imports directly.

import data from "./grammar-mcq-2.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const grammarMcq2: MasterClassContent = data as MasterClassContent;
