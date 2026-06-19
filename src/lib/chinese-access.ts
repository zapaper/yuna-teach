// Chinese assignment gate.
//
// As of the 2026-06-20 PSLE Chinese launch, all signed-in users (any
// parent, plus admin via the parallel isAdmin() gate at call sites)
// can assign Chinese quizzes and Chinese-paper test quizzes. The gate
// previously locked Chinese to an allow-list while the bank + marker
// integration were under verification.
//
// Kept as a named function (rather than inlining `true`) so the
// daily-quiz and ParentDashboard call sites can re-gate behind a
// future flag without churn if needed.

export function canAssignChinese(name: string | null | undefined): boolean {
  void name; // silence the unused-arg lint without changing the signature
  return true;
}
