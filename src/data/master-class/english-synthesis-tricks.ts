// Master Class content authored in YAML — see ./english-synthesis-tricks.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./english-synthesis-tricks.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const englishSynthesisTricks: MasterClassContent = data as MasterClassContent;
