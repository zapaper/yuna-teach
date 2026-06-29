// Map a Chinese section label to its English gloss. Used wherever
// we surface a section name to parents (quiz section header, quiz-
// assign modal, parent dashboard sections list) so non-Chinese-
// reading parents can tell which section type they're looking at.
//
// Returns null when no mapping is known — caller decides whether to
// render fallback empty / hide the gloss.

export function sectionLabelGloss(label: string): string | null {
  const l = label.trim();
  if (l.includes("完成对话")) return "Complete the dialogue";
  if (l.includes("对话填空")) return "Dialogue cloze";
  if (l.includes("短文填空")) return "Cloze passage";
  if (l.includes("阅读理解")) {
    // 阅读理解 splits into MCQ-heavy and OEQ-heavy variants. Use the
    // shorter "Compre MCQ" / "Compre OEQ" labels parents asked for,
    // since the long "Comprehension A (MCQ + 长 OEQ)" form clutters
    // the modal. Plain 阅读理解 stays as "Comprehension".
    if (/OEQ/i.test(l)) return "Compre OEQ";
    if (/MCQ|\bA\b/i.test(l)) return "Compre MCQ";
    return "Comprehension";
  }
  if (l.includes("语文应用")) return "Vocabulary application";
  if (l.includes("词语搭配")) return "Word collocations";
  if (l.includes("词语")) return "Vocabulary";
  if (l.includes("词汇")) return "Vocabulary";
  if (l.includes("改正")) return "Editing";
  if (l.includes("配伍")) return "Matching";
  if (l.includes("看图")) return "Picture description";
  if (l.includes("默写")) return "Dictation";
  if (l.includes("听力")) return "Listening";
  return null;
}
