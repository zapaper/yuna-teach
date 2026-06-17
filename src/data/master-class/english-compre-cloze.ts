// Master Class content authored in YAML — see ./english-compre-cloze.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./english-compre-cloze.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const englishCompreCloze: MasterClassContent = data as MasterClassContent;
