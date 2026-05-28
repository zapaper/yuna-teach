// Master Class content authored in YAML — see ./math-geometry-angles.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./math-geometry-angles.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const mathGeometryAngles: MasterClassContent = data as MasterClassContent;
