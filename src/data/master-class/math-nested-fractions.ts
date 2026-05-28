// Master Class content authored in YAML — see ./math-nested-fractions.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./math-nested-fractions.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const mathNestedFractions: MasterClassContent = data as MasterClassContent;
