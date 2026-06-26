// Last week's diagnosis snapshots — used by loadTutorData to compute
// the weekly delta block on the Lumi page. Each snapshot was captured
// BEFORE the current cache was overwritten, so it represents the
// "last Friday's report" for delta purposes.
//
// Production: the Friday cron will write into this index automatically.
// For the Mark + David trial, we wired six entries by hand.

import markMathLW    from "./tutor-cache/unified-diagnosis-mark-lim-math.lastweek.gemini-cache.json";
import markSciLW     from "./tutor-cache/unified-diagnosis-mark-lim-science.lastweek.gemini-cache.json";
import markEngLW     from "./tutor-cache/unified-diagnosis-mark-lim-english.lastweek.gemini-cache.json";
import davidMathLW   from "./tutor-cache/unified-diagnosis-david-lim-math.lastweek.gemini-cache.json";
import davidSciLW    from "./tutor-cache/unified-diagnosis-david-lim-science.lastweek.gemini-cache.json";
import davidEngLW    from "./tutor-cache/unified-diagnosis-david-lim-english.lastweek.gemini-cache.json";
import jeremiahMathLW    from "./tutor-cache/unified-diagnosis-jeremiahsy-math.lastweek.gemini-cache.json";
import jeremiahSciLW     from "./tutor-cache/unified-diagnosis-jeremiahsy-science.lastweek.gemini-cache.json";
import jeremiahEngLW     from "./tutor-cache/unified-diagnosis-jeremiahsy-english.lastweek.gemini-cache.json";
import kaiyangMathLW   from "./tutor-cache/unified-diagnosis-kaiyangnggg-math.lastweek.gemini-cache.json";
import kaiyangSciLW    from "./tutor-cache/unified-diagnosis-kaiyangnggg-science.lastweek.gemini-cache.json";
import kaiyangEngLW    from "./tutor-cache/unified-diagnosis-kaiyangnggg-english.lastweek.gemini-cache.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const LUMI_LASTWEEK_CACHE: Record<string, any> = {
  "mark-lim:math":      markMathLW,
  "mark-lim:science":   markSciLW,
  "mark-lim:english":   markEngLW,
  "david-lim:math":     davidMathLW,
  "david-lim:science":  davidSciLW,
  "david-lim:english":  davidEngLW,
  "jeremiahsy:math":    jeremiahMathLW,
  "jeremiahsy:science": jeremiahSciLW,
  "jeremiahsy:english": jeremiahEngLW,
  "kaiyangnggg:math":    kaiyangMathLW,
  "kaiyangnggg:science": kaiyangSciLW,
  "kaiyangnggg:english": kaiyangEngLW,
};
