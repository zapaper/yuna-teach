// Helpers for picking which scanned PDF page best represents a
// question's writing for the review UI. Shared by scan-submit (live
// map at upload time), remark-paper.ts (backfill while re-marking),
// and backfill-pagemap.ts (idempotent backfill of older clones).
//
// Why a helper at all: the obvious choice — use the parent
// question's printableBounds.pageIndex — points to where the
// question's LABEL is drawn. For multi-subpart questions whose
// subparts span pages, that's the page where the previous question
// finishes; the current question's actual writing is usually
// further down. Picking the page with the most subparts on it
// fixes the "Q13 review shows Q12's working" symptom without
// needing the UI to flip through multiple pages per question.

type SubpartBound = { pageIndex?: number };
type PrintableBoundsLite = {
  pageIndex?: number;
  subparts?: Record<string, SubpartBound>;
};

/**
 * Returns the 0-based loop pageIndex of the page that best
 * represents this question's writing — defaulting to the parent
 * question's pageIndex when there are no subparts (single-part
 * OEQ, MCQ) or when no subpart has a numeric pageIndex.
 *
 * Algorithm for multi-subpart: tally how many subparts land on
 * each page, pick the page with the highest count. Ties resolve
 * to the FIRST tied page (lower index = earlier in the paper),
 * matching natural reading order.
 */
export function pickRepresentativePageIndex(bounds: PrintableBoundsLite | null | undefined): number | null {
  if (!bounds) return null;
  const defaultIdx = typeof bounds.pageIndex === "number" && Number.isFinite(bounds.pageIndex)
    ? bounds.pageIndex
    : null;
  const subparts = bounds.subparts ?? {};
  const counts = new Map<number, number>();
  for (const sp of Object.values(subparts)) {
    if (typeof sp.pageIndex === "number" && Number.isFinite(sp.pageIndex)) {
      counts.set(sp.pageIndex, (counts.get(sp.pageIndex) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return defaultIdx;
  let bestPage: number | null = null;
  let bestCount = -1;
  for (const [page, count] of counts) {
    if (count > bestCount || (count === bestCount && bestPage !== null && page < bestPage)) {
      bestPage = page;
      bestCount = count;
    }
  }
  return bestPage ?? defaultIdx;
}

/**
 * Convenience: returns the scan-file index (PDF page index =
 * representative loop pageIndex + 1 for the cover page) or null
 * when bounds are missing entirely.
 */
export function pickScanFileIndex(bounds: PrintableBoundsLite | null | undefined): number | null {
  const idx = pickRepresentativePageIndex(bounds);
  return idx === null ? null : idx + 1;
}
