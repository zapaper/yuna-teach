// Master Class content authored in YAML — see ./math-percentage-traps.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./math-percentage-traps.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const mathPercentageTraps: MasterClassContent = data as MasterClassContent;
