// Master Class content authored in YAML — see ./math-combined-figure-area.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./math-combined-figure-area.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const mathCombinedFigureArea: MasterClassContent = data as MasterClassContent;
