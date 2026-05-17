import { prisma } from "../src/lib/db";

(async () => {
  const CLONE_ID = "cmotxyve5003ld15sdmlwo9sl";
  const MASTER_ID = "cmo3uk2pq007q114hox2v0x56";

  const newSolution =
    "**Answer: (1)**\n\n" +
    "**Step 1:** When water freezes, it loses heat even at the same temperature. Point E represents this. Since we start with a container of water, A and B did not represent a change in state, hence it neither lost or gained heat.\n\n" +
    "**Step 2:** Let's understand why the other statements are wrong! Evaporation happens at **all temperatures** as long as water is a liquid, so evaporation is definitely happening between BC.\n\n" +
    "**Step 3:** When a temperature graph has flat lines (like AB or CD might be), the temperature stays the same because the water is changing state (like boiling or melting). Even though the temperature stays the same, the water is still **gaining heat** or **losing heat** to make that change happen! Therefore, statement **(1)** is the only correct choice.";

  const newElab = JSON.stringify({ solution: newSolution, diagrams: [] });

  for (const id of [CLONE_ID, MASTER_ID]) {
    await prisma.examQuestion.update({ where: { id }, data: { elaboration: newElab } });
    console.log(`updated ${id}`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
