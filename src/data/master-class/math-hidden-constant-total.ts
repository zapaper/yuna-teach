// Master Class content authored in YAML — see ./math-hidden-constant-total.yaml.
// Pre-build step (scripts/build-master-class.mjs) converts to JSON.

import data from "./math-hidden-constant-total.generated.json";
import type { MasterClassContent } from "./interactions-environment";

export const mathHiddenConstantTotal: MasterClassContent = data as MasterClassContent;
