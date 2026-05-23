// Master Class content authored in YAML — see ./chinese-oeq-setpieces.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./chinese-oeq-setpieces.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const chineseOeqSetpieces: MasterClassContent = data as MasterClassContent;
