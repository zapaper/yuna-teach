// Master Class content authored in YAML — see ./english-visual-text-mcq.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./english-visual-text-mcq.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const englishVisualTextMcq: MasterClassContent = data as MasterClassContent;
