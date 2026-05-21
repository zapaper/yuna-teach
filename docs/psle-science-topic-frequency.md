# PSLE Science Topic Frequency — 2022 to 2024

**Source:** four comprehensive master papers in our database covering all of PSLE 2022, 2023, and 2024:

- `PSLE Physical Science MCQ 2022-2024`
- `PSLE Physical Science OEQ 2022-2024`
- `PSLE Life Science OEQ 2022-2024`
- `P6 Life Science MCQ 2022-2024`

**Total sample:** 122 questions / **255 marks** across 3 years.

> All percentages below are computed over the total 255 marks (not within a Life/Physical sub-bucket). Refresh anytime with:
>
> ```bash
> npx tsx scripts/psle-science-2022-2024.ts
> ```

---

## Top topics by marks (PSLE 2022–2024)

| Rank | Topic | Qs | MCQ | OEQ | Marks | % total marks |
|---:|---|---:|---:|---:|---:|---:|
| 1 | **Interactions within the environment** | 15 | 8 | 7 | 39 | **15.3%** |
| 2 | Electrical system and circuits | 11 | 7 | 4 | 24 | 9.4% |
| 3 | Diversity of living and non-living things | 11 | 10 | 1 | 23 | 9.0% |
| 4 | Heat energy and uses | 11 | 6 | 5 | 23 | 9.0% |
| 5 | Interaction of forces (Frictional + gravitational + ...) | 12 | 8 | 4 | 21 | 8.2% |
| 6 | Reproduction in plants and animals | 8 | 5 | 3 | 18 | 7.1% |
| 7 | Plant parts and functions | 7 | 4 | 3 | 18 | 7.1% |
| 8 | Life cycles in plants and animals | 8 | 6 | 2 | 16 | 6.3% |
| 9 | Photosynthesis | 5 | 3 | 2 | 13 | 5.1% |
| 10 | Energy conversion | 4 | 2 | 2 | 11 | 4.3% |
| 11 | Human respiratory and circulatory systems | 4 | 3 | 1 | 10 | 3.9% |
| 12 | Cycles in matter | 6 | 4 | 2 | 10 | 3.9% |
| 13 | Interaction of forces (Magnets) | 6 | 5 | 1 | 9 | 3.5% |
| 14 | Human digestive system | 3 | 2 | 1 | 8 | 3.1% |
| 15 | Diversity of materials | 5 | 5 | 0 | 5 | 2.0% |
| 16 | Water cycle, evaporation, condensation | 3 | 3 | 0 | 4 | 1.6% |
| 17 | Light energy and uses | 3 | 3 | 0 | 3 | 1.2% |

> **Note on totals:** 255 marks / 3 years = ~85 marks per year. PSLE Science is normally 100 marks per year, so the sample covers roughly 85% of the printed paper. Any untagged or unrecognised questions sit in `(no topic)` and are not material to the rankings above.

---

## Period comparison: 2020–2021 vs 2022–2024

The 2020 and 2021 papers exist in our DB as separate full PSLE Science papers. Topic weightage has shifted noticeably between the two periods:

| Topic | 2020–21 % | 2022–24 % | Trend |
|---|---:|---:|---|
| Interactions within environment | 5.0% | 15.3% | **3× up** |
| Energy conversion | 1.0% | 4.3% | up |
| Heat energy | 7.5% | 9.0% | up |
| Life cycles | 4.0% | 6.3% | up |
| Diversity of living | 7.0% | 9.0% | up |
| Electrical circuits | 9.0% | 9.4% | flat |
| Interaction of forces (Friction+Gravity) | 10.0% | 8.2% | down |
| Cycles in matter | 7.0% | 3.9% | down |
| Human respiratory | 6.0% | 3.9% | down |
| Interaction of forces (Magnets) | 5.5% | 3.5% | down |
| Diversity of materials | 4.5% | 2.0% | down |

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

## Reusable scripts

| Script | Purpose |
|---|---|
| `scripts/psle-science-2022-2024.ts` | Canonical table — 4-paper comprehensive 2022–2024 frequency |
| `scripts/psle-science-frequency-2020-2024.ts` | 5-year view extrapolated from 2020+2021 full papers |
| `scripts/psle-science-compare-periods.ts` | Side-by-side 2020-21 vs 2022-24 per topic |
| `scripts/verify-interactions-2022-2024.ts` | Drills into every "Interactions" question for tagging audit |
