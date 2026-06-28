"use client";
// Fires window.print() once on mount. Splitting it into a client
// child keeps the parent route a server component so it can hit
// Prisma directly without a fetch round-trip.

import { useEffect } from "react";

export default function PrintTrigger() {
  useEffect(() => {
    // 200ms gives layout + fonts a moment to settle before the
    // print dialog snapshots the page.
    const t = setTimeout(() => window.print(), 200);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="no-print bg-violet-50 border border-violet-200 rounded-lg px-3 py-2 mb-4 text-xs text-violet-800 flex items-center justify-between">
      <span>Print dialog should appear automatically. If not:</span>
      <button
        type="button"
        onClick={() => window.print()}
        className="px-3 py-1 rounded bg-violet-600 text-white font-semibold hover:bg-violet-700"
      >
        🖨 Print now
      </button>
    </div>
  );
}
