// Master Class content authored in YAML — see ./math-painted-cube.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./math-painted-cube.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const mathPaintedCube: MasterClassContent = data as MasterClassContent;
