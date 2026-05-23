// Master Class content authored in YAML — see ./chinese-idioms.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./chinese-idioms.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const chineseIdioms: MasterClassContent = data as MasterClassContent;
