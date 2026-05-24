# Marking Regression Eval

Re-run the marking pipeline against a fixed corpus of known-good papers and
flag any per-question score regressions. Used before pushing changes that
affect marking logic, prompts, or models.

## Files

- `corpus.json` — list of paper IDs that have been manually verified to be
  marked correctly. Hand-edit to add/remove papers.
- `snapshot.json` — frozen state of each corpus paper's per-question
  `marksAwarded`. The ground-truth baseline. Regenerate when the corpus
  changes (or when you've intentionally re-marked a paper and accept the
  new outcome as the new baseline).
- `results.json` — output of the most recent eval run.

## Workflow

```bash
# 1. (One-off) Capture the current marked state of every paper in corpus.json
npx tsx scripts/snapshot-eval-papers.ts

# 2. Run the eval — clones each paper, re-marks, compares
npx tsx scripts/run-marking-eval.ts

# Optional flags:
npx tsx scripts/run-marking-eval.ts --cleanup        # delete clones after run
npx tsx scripts/run-marking-eval.ts --tolerance=0    # strict equality (default ±0.5)
npx tsx scripts/run-marking-eval.ts --paper=cmpj...  # run a single paper
```

## What gets compared

Only per-question `marksAwarded` and the implied total score. AI feedback
text (`markingNotes`) is deliberately ignored — wording will vary on each
re-mark; we only care that the numbers agree.

## How clones work

The runner creates a new `ExamPaper` row with `paperType="eval"` that
copies the source's questions and the student's canvas files on disk.
The clone's `marksAwarded` is reset to `null` so the marker re-grades
from scratch. Originals are never touched.

`paperType="eval"` keeps clones out of the parent dashboard's activity
lists. Pass `--cleanup` to delete them after the run, or leave them for
manual inspection.

## When to regenerate the snapshot

- You added new papers to `corpus.json` → re-snapshot to capture them.
- You intentionally improved marking and accept the new outcome on some
  papers as the new baseline → re-snapshot.
- You discovered a snapshot paper was actually marked wrong → fix it
  manually in the parent UI first, then re-snapshot.

Otherwise leave the snapshot alone — that's the whole point of it being
a regression baseline.
