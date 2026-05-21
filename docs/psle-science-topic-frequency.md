# PSLE Science Topic Frequency — 2022 to 2024

**Source:** four comprehensive master papers in our database covering all of PSLE 2022, 2023, and 2024:

- `PSLE Physical Science MCQ 2022-2024`
- `PSLE Physical Science OEQ 2022-2024`
- `PSLE Life Science OEQ 2022-2024`
- `P6 Life Science MCQ 2022-2024`

**Total sample:** 122 questions / **297 marks** across 3 years (PSLE Science is 100 marks/year × 3 years = 300; the ~3-mark gap is one OEQ subpart with `null` marks).

> All percentages below are computed over the total 297 marks (not within a Life/Physical sub-bucket). Refresh anytime with:
>
> ```bash
> npx tsx scripts/psle-science-2022-2024.ts
> ```

---

## Top topics by marks (PSLE 2022–2024)

| Rank | Topic | Qs | MCQ | OEQ | Marks | % total marks |
|---:|---|---:|---:|---:|---:|---:|
| 1 | **Interactions within the environment** | 15 | 8 | 7 | 39 | **13.1%** |
| 2 | Electrical system and circuits | 11 | 7 | 4 | 31 | 10.4% |
| 3 | Interaction of forces (Frictional + gravitational + ...) | 12 | 8 | 4 | 29 | 9.8% |
| 3 | Heat energy and uses | 11 | 6 | 5 | 29 | 9.8% |
| 5 | Diversity of living and non-living things | 11 | 10 | 1 | 23 | 7.7% |
| 6 | Reproduction in plants and animals | 8 | 5 | 3 | 18 | 6.1% |
| 6 | Plant parts and functions | 7 | 4 | 3 | 18 | 6.1% |
| 8 | Life cycles in plants and animals | 8 | 6 | 2 | 16 | 5.4% |
| 9 | Cycles in matter | 6 | 4 | 2 | 14 | 4.7% |
| 9 | Interaction of forces (Magnets) | 6 | 5 | 1 | 14 | 4.7% |
| 11 | Photosynthesis | 5 | 3 | 2 | 13 | 4.4% |
| 11 | Energy conversion | 4 | 2 | 2 | 13 | 4.4% |
| 13 | Human respiratory and circulatory systems | 4 | 3 | 1 | 10 | 3.4% |
| 13 | Diversity of materials | 5 | 5 | 0 | 10 | 3.4% |
| 15 | Human digestive system | 3 | 2 | 1 | 8 | 2.7% |
| 16 | Water cycle, evaporation, condensation | 3 | 3 | 0 | 6 | 2.0% |
| 16 | Light energy and uses | 3 | 3 | 0 | 6 | 2.0% |

---

## Period comparison: 2020–2021 vs 2022–2024

The 2020 and 2021 papers exist in our DB as separate full PSLE Science papers. Topic weightage has shifted noticeably between the two periods:

| Topic | 2020–21 % | 2022–24 % | Trend |
|---|---:|---:|---|
| Interactions within environment | 5.0% | 13.1% | **2.5× up** |
| Energy conversion | 1.0% | 4.4% | up |
| Heat energy | 7.5% | 9.8% | up |
| Electrical circuits | 9.0% | 10.4% | slight up |
| Life cycles | 4.0% | 5.4% | up |
| Diversity of living | 7.0% | 7.7% | flat |
| Interaction of forces (Friction+Gravity) | 10.0% | 9.8% | flat |
| Cycles in matter | 7.0% | 4.7% | down |
| Human respiratory | 6.0% | 3.4% | down |
| Interaction of forces (Magnets) | 5.5% | 4.7% | slight down |
| Diversity of materials | 4.5% | 3.4% | down |

Refresh the comparison with:

```bash
npx tsx scripts/psle-science-compare-periods.ts
```

---

## Why we use 2022–2024 only for master-class stats

For master-class "% of PSLE marks" headlines we use the **2022–2024** sample because:

1. It is **fully comprehensive** for those 3 years — MCQ + OEQ × Life + Physical.
2. It reflects the **current syllabus weighting** that today's P6 students will face on the live PSLE.
3. The 2020–2021 data is a useful sanity-check sample but the topic mix has visibly changed (see comparison above), so a 5-year blended figure would understate topics like Interactions Environment that have grown in recent papers.

---

## Data quality fixes applied

- **2026-05-21**: PSLE Physical Science MCQ paper had `marksAvailable=1` on every question; PSLE MCQs are 2 marks each. Bulk-updated to 2 via `scripts/fix-physical-mcq-marks.ts`. Restored 42 marks to the total. Every Physical Science topic % shifted up accordingly.
- **Outstanding:** PSLE Life Science OEQ Q14b has `null` marksAvailable. Worth ~1–2 marks; needs the original paper to set accurately.

---

## Reusable scripts

| Script | Purpose |
|---|---|
| `scripts/psle-science-2022-2024.ts` | Canonical table — 4-paper comprehensive 2022–2024 frequency |
| `scripts/psle-science-frequency-2020-2024.ts` | 5-year view extrapolated from 2020+2021 full papers |
| `scripts/psle-science-compare-periods.ts` | Side-by-side 2020-21 vs 2022-24 per topic |
| `scripts/audit-2022-2024-totals.ts` | Per-paper totals + null/no-topic spot-check |
| `scripts/fix-physical-mcq-marks.ts` | One-off scoring repair for Physical Science MCQ (already run) |
