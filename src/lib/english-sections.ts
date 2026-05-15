// Helpers for matching English exam section labels.
//
// Section names come from upstream structure-analysis and end up as
// `syllabusTopic` on each question (e.g. "Comprehension Open Ended",
// "Comprehension OEQ", "Comprehension OE", "Comp OEQ", "Comprehension
// (Open-ended)"). All these refer to the SAME section. Spot-fixing each
// matcher across the codebase has caused bugs where one path recognises
// the section and another doesn't — leaving the comp-OEQ passage absent
// from the quiz and the questions routed through the wrong renderer.
// This module is the single source of truth.

/** True when the label refers to the comprehension-OEQ (open-ended)
 *  section, in any of its known spellings:
 *    - "Comprehension Open Ended"
 *    - "Comprehension Open-Ended"
 *    - "Comprehension OEQ"
 *    - "Comprehension OE"
 *    - "Comp OEQ"
 *    - "Comprehension (Open-ended)"
 */
export function isCompOeqLabel(label: string | null | undefined): boolean {
  if (!label) return false;
  const t = label.toLowerCase();
  if (!t.includes("comp")) return false;
  if (t.includes("open")) return true;
  if (t.includes("oeq")) return true;
  // Match a bare "oe" token (e.g. "Comprehension OE") but not "oei" /
  // "oel" / a longer word containing "oe".
  return /\boe\b/.test(t);
}
