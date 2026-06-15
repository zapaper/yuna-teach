// Bundled snapshot of unified-diagnosis runs for the workshop tutor
// page. Each cache file is JSON imported statically so it ends up in
// the bundle instead of relying on disk paths that Railway's
// standalone server doesn't copy.

import benjaminScience from "./tutor-cache/unified-diagnosis-benjamin-ong-science.gemini-cache.json";
import davidScience from "./tutor-cache/unified-diagnosis-david-lim-science.gemini-cache.json";
import ijScience from "./tutor-cache/unified-diagnosis-ij-science.gemini-cache.json";
import jeremiahScience from "./tutor-cache/unified-diagnosis-jeremiahsy-science.gemini-cache.json";
import kaiyangScience from "./tutor-cache/unified-diagnosis-kaiyangnggg-science.gemini-cache.json";
import markScience from "./tutor-cache/unified-diagnosis-mark-lim-science.gemini-cache.json";
import ruthieScience from "./tutor-cache/unified-diagnosis-ruthie-science.gemini-cache.json";
import markMath from "./tutor-cache/unified-diagnosis-mark-lim-math.gemini-cache.json";
import davidMath from "./tutor-cache/unified-diagnosis-david-lim-math.gemini-cache.json";
import kaiyangMath from "./tutor-cache/unified-diagnosis-kaiyangnggg-math.gemini-cache.json";
import benjaminMath from "./tutor-cache/unified-diagnosis-benjamin-ong-math.gemini-cache.json";
import hooperMath from "./tutor-cache/unified-diagnosis-hooper-math.gemini-cache.json";

export type CachedReport = {
  patterns: Array<{ name: string; what: string; specific_examples: Array<{ questionRef: string; type?: "oeq" | "mcq"; whatWentWrong: string }>; strategic_advice: string; trigger_keywords: string[] }>;
  classification: Array<{ idx: number; patternIndex: number }>;
};

// Key shape: `<safeName>:<subject>` lowercased, dashes for whitespace.
export const TUTOR_CACHE: Record<string, CachedReport> = {
  "benjamin-ong:science": benjaminScience as CachedReport,
  "david-lim:science":    davidScience as CachedReport,
  "ij:science":           ijScience as CachedReport,
  "jeremiahsy:science":   jeremiahScience as CachedReport,
  "kaiyangnggg:science":  kaiyangScience as CachedReport,
  "mark-lim:science":     markScience as CachedReport,
  "ruthie:science":       ruthieScience as CachedReport,
  "mark-lim:math":        markMath as CachedReport,
  "david-lim:math":       davidMath as CachedReport,
  "kaiyangnggg:math":     kaiyangMath as CachedReport,
  "benjamin-ong:math":    benjaminMath as CachedReport,
  "hooper:math":          hooperMath as CachedReport,
};
