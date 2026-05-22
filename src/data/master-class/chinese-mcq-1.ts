// Master Class content authored in YAML — see ./chinese-mcq-1.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./chinese-mcq-1.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const chineseMcq1: MasterClassContent = data as MasterClassContent;
