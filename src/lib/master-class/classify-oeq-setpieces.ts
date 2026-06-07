// Stem-based classifier for the Chinese 写作套话 (Q33 + Q40) master
// class. Source questions all carry syllabusTopic="阅读理解 OEQ" so
// the picker can't distinguish them by tag alone — it would pick two
// Q33s (or two Q40s) by chance. This splits the pool into two
// independently-bucketed sub-topics so the picker draws one of each.
//
// Sub-topic IDs (must match chinese-oeq-setpieces.yaml):
//   q33-writing  — 短文写作: write an email / SMS / note / short
//                  letter in response to a situational prompt.
//   q40-opinion  — 个人意见: give a personal opinion ("do you agree?"
//                  or "what kind of person?") about a passage character
//                  or scenario.
//
// Returns null for stems that match neither shape — those get skipped
// rather than misrouted into the wrong bucket.
export function classifyOeqSetpieces(stem: string | null): string | null {
  if (!stem) return null;
  const s = stem;

  // ─── Q33: writing-task patterns ────────────────────────────
  // Real PSLE shapes:
  //   "请你写一个手机短信给她…"     (PSLE 2019)
  //   "请写一封电邮给…"             (variants)
  //   "如果你是 X… 请写一封短信…"
  //   "写一个便条 / 通知…"
  // The defining feature is an explicit instruction to write a
  // letter / email / SMS / note targeted at a named recipient.
  if (/写一?[个封]?\s*(手机短信|电邮|便条|短信|通知|信)/.test(s)) return "q33-writing";
  if (/请你?写/.test(s) && /(短信|电邮|便条|通知|信|短文)/.test(s)) return "q33-writing";
  if (/如果你是[^。]{2,40}请/.test(s) && /(写|建议|告诉|通知)/.test(s)) return "q33-writing";

  // ─── Q40: opinion / character-assessment patterns ──────────
  // Two recognised PSLE formats:
  //   (a) "你同意…吗?" / "你赞成…吗?"  — Do you agree / approve?
  //   (b) "X 是个怎样的人?"            — What kind of person is X?
  if (/(你同意|你不同意|你赞成|你不赞成|你认同)/.test(s) && /吗/.test(s)) return "q40-opinion";
  if (/(是个?怎样的人|是什么样的人)/.test(s)) return "q40-opinion";
  if (/对(于)?[^。]{2,40}(看法|做法|意见|想法)/.test(s)) return "q40-opinion";

  // Unclassified — caller skips. We deliberately don't fall back to
  // either bucket so a stem we don't recognise can't pollute one
  // sub-topic's pool with the other shape.
  return null;
}
