// Master Class content authored in YAML — see ./chinese-comprehension.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./chinese-comprehension.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const chineseComprehension: MasterClassContent = data as MasterClassContent;
