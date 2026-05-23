// Master Class content authored in YAML — see ./science-diversity.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./science-diversity.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const scienceDiversity: MasterClassContent = data as MasterClassContent;
