// Master Class content authored in YAML — see ./chinese-sentence-completion.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./chinese-sentence-completion.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const chineseSentenceCompletion: MasterClassContent = data as MasterClassContent;
