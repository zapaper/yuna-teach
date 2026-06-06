// Format a stored questionNum for display.
// Pure-numeric labels ("12", "3a") get a leading "Q" so the UI reads
// "Q12" / "Q3a". Labels that already start with a letter ("P2-12a",
// "QP-1", "B2-3") encode their section/paper in the prefix already —
// adding another "Q" doubles up into nonsense like "QP2-12a". Keep
// those as-is.
export function formatQNum(questionNum: string): string {
  if (!questionNum) return "";
  return /^[A-Za-z]/.test(questionNum) ? questionNum : `Q${questionNum}`;
}
