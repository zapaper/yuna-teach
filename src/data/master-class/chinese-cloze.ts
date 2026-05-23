// Master Class content authored in YAML — see ./chinese-cloze.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./chinese-cloze.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const chineseCloze: MasterClassContent = data as MasterClassContent;
