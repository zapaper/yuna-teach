import { promises as fs } from "fs";
import path from "path";

type Q = { questionNum: string; marksAvailable: number | null; syllabusTopic: string | null; subTopic: string | null; transcribedStem: string | null };
type Paper = { year: string; title: string; questions: Q[] };

async function main() {
  const raw = await fs.readFile(path.join(__dirname, "psle-math-dump.json"), "utf8");
  const papers: Paper[] = JSON.parse(raw);

  for (const year of ["2022", "2023", "2024", "2025"]) {
    const p = papers.find(x => x.year === year);
    if (!p) continue;
    const algebra = (p.questions ?? []).filter(q => (q.syllabusTopic ?? "").toLowerCase() === "algebra");
    console.log(`\n=== ${year} — ${algebra.length} questions tagged "Algebra" ===`);
    for (const q of algebra) {
      const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 200);
      console.log(`  Q${q.questionNum} (${q.marksAvailable}m, ${q.subTopic ?? "-"}): ${stem}`);
    }
  }

  // Also show: 2024 questions labeled NOT-Algebra whose stems contain a
  // variable letter (n, x, p, q) — these are candidates that 2025 might
  // have labeled Algebra.
  console.log(`\n=== 2024 non-algebra questions that mention a variable ===`);
  const p24 = papers.find(x => x.year === "2024");
  if (p24) {
    const candidates = (p24.questions ?? []).filter(q => {
      if ((q.syllabusTopic ?? "").toLowerCase() === "algebra") return false;
      const s = (q.transcribedStem ?? "").toLowerCase();
      return /\b(when\s+[nxypqkm]\s*=|let\s+[nxypqkm]\s*=|find\s+the\s+value\s+of\s+[nxypqkm])/.test(s);
    });
    for (const q of candidates) {
      const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 200);
      console.log(`  Q${q.questionNum} (${q.marksAvailable}m, topic=${q.syllabusTopic}): ${stem}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
