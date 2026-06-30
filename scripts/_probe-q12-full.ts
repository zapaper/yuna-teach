import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  // Pull ALL columns to find where the kid's ink might live for an in-app quiz
  const q = await prisma.examQuestion.findUnique({
    where: { id: "cmr0oo3pu001vb307r56o2smf" },
  });
  if (!q) return;
  // Print field names + value lengths so we can spot any populated blob
  for (const [k, v] of Object.entries(q)) {
    if (v === null) continue;
    if (typeof v === "string") console.log(`${k}: <string ${v.length} chars>`);
    else if (typeof v === "object") console.log(`${k}: ${JSON.stringify(v).slice(0, 200)}`);
    else console.log(`${k}: ${v}`);
  }
  await prisma.$disconnect();
})();
