// Master Class content authored in YAML — see ./forces.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./forces.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const forces: MasterClassContent = data as MasterClassContent;
