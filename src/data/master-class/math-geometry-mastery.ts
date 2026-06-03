// Master Class content authored in YAML — see ./math-geometry-mastery.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./math-geometry-mastery.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const mathGeometryMastery: MasterClassContent = data as MasterClassContent;
