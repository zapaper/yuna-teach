// Analyse WRONG-answer marking notes across the top-5 PSLE Science
// topics so the /onboarding-assets/psle-science-top-topics cheat
// sheet's "Common mistakes" table is grounded in real data, not
// made-up pedagogy claims.
//
// For each of the top-5 topics we pull every clone-question row
// where marksAwarded < marksAvailable AND markingNotes is non-empty,
// then cluster the notes and surface the most common failure modes
// + a representative example (student's actual answer + marker's
// note).
//
// Run: npx tsx scripts/_analyse-science-top5-mistakes.ts

import { prisma } from "@/lib/db";

const TOP5_TOPICS = [
  "Interaction of forces (Frictional force, gravitational force, elastic spring force)",
  "Interactions within the environment",
  "Electrical system and circuits",
  "Heat energy and uses",
  "Diversity of living and non-living things",
];

type Row = {
  id: string;
  syllabusTopic: string | null;
  subTopic: string | null;
  transcribedStem: string | null;
  studentAnswer: string | null;
  answer: string | null;
  markingNotes: string | null;
  marksAwarded: number | null;
  marksAvailable: number | null;
};

async function main() {
  for (const topic of TOP5_TOPICS) {
    console.log("\n================================================================");
    console.log(`TOPIC: ${topic}`);
    console.log("================================================================");

    const rows = await prisma.examQuestion.findMany({
      where: {
        syllabusTopic: topic,
        examPaper: {
          subject: { contains: "science", mode: "insensitive" },
          markingStatus: { in: ["complete", "released"] },
          NOT: { paperType: "eval" },
        },
        marksAwarded: { not: null },
        marksAvailable: { not: null, gt: 0 },
        markingNotes: { not: null },
      },
      select: {
        id: true,
        syllabusTopic: true,
        subTopic: true,
        transcribedStem: true,
        studentAnswer: true,
        answer: true,
        markingNotes: true,
        marksAwarded: true,
        marksAvailable: true,
      },
      take: 2000,
    });

    const wrong = rows.filter(r => (r.marksAwarded ?? 0) < (r.marksAvailable ?? 0));
    const wrongOEQ = wrong.filter(r => {
      const notes = (r.markingNotes ?? "").toLowerCase();
      return notes.length > 8;
    });

    console.log(`Total marked rows on this topic: ${rows.length}`);
    console.log(`Wrong (marksAwarded < marksAvailable): ${wrong.length}`);
    console.log(`Wrong with substantive marking notes: ${wrongOEQ.length}`);

    // Per-subTopic breakdown so we see if one sub-topic dominates.
    const bySub = new Map<string, number>();
    for (const r of wrongOEQ) {
      const k = r.subTopic ?? "(untagged)";
      bySub.set(k, (bySub.get(k) ?? 0) + 1);
    }
    const sortedSubs = [...bySub.entries()].sort((a, b) => b[1] - a[1]);
    console.log("\nWrong-answer counts by sub-topic:");
    for (const [sub, n] of sortedSubs) console.log(`  ${n}  ${sub}`);

    // Cluster marking notes by looking at the first phrase before a
    // period. Not perfect but enough to see the tail vs the head.
    const noteHead = new Map<string, Row[]>();
    for (const r of wrongOEQ) {
      const raw = (r.markingNotes ?? "").trim();
      // Strip common intro like "You lost 1 mark because…" and take
      // the first ~60 chars of the content clause.
      const cleaned = raw
        .replace(/^you lost \d+ mark[s]?\s*because\s*/i, "")
        .replace(/^lost \d+ mark[s]?\s*/i, "")
        .replace(/^(the )?answer (was |is )?(wrong|incorrect)( because)?\s*/i, "")
        .toLowerCase();
      const key = cleaned.slice(0, 60);
      const arr = noteHead.get(key) ?? [];
      arr.push(r);
      noteHead.set(key, arr);
    }
    const sortedNotes = [...noteHead.entries()].sort((a, b) => b[1].length - a[1].length);
    console.log("\nTop marking-note clusters (head 60 chars):");
    for (const [head, arr] of sortedNotes.slice(0, 15)) {
      console.log(`  ${arr.length}x  ${head}`);
    }

    // Print 3-5 representative examples spanning the top cluster and
    // a couple of long-tail ones so we can hand-pick.
    console.log("\nRepresentative wrong-answer examples:");
    const picks: Row[] = [];
    for (const [, arr] of sortedNotes.slice(0, 5)) {
      picks.push(arr[Math.floor(Math.random() * arr.length)]);
      if (picks.length >= 6) break;
    }
    for (const [i, r] of picks.entries()) {
      const stem = (r.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 220);
      const student = (r.studentAnswer ?? "").replace(/\s+/g, " ").slice(0, 220);
      const correct = (r.answer ?? "").replace(/\s+/g, " ").slice(0, 220);
      const notes = (r.markingNotes ?? "").replace(/\s+/g, " ").slice(0, 350);
      console.log(`\n  Example ${i + 1} (sub-topic: ${r.subTopic ?? "?"}, ${r.marksAwarded}/${r.marksAvailable})`);
      console.log(`    Stem: ${stem}`);
      console.log(`    Student: ${student}`);
      console.log(`    Correct: ${correct}`);
      console.log(`    Marker notes: ${notes}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
