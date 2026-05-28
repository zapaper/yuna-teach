// Master Class content authored in YAML — see ./math-speed-multi-stage.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./math-speed-multi-stage.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const mathSpeedMultiStage: MasterClassContent = data as MasterClassContent;
