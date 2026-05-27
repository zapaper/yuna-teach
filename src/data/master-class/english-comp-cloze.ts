// Master Class content authored in YAML — see ./english-comp-cloze.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./english-comp-cloze.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const englishCompCloze: MasterClassContent = data as MasterClassContent;
