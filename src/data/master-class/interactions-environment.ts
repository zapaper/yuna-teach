// Master Class content for "Interactions within the environment".
// Hand-authored from analysis of 41 PSLE actual Life-Science questions
// + 74 school WA / Prelim questions in the master bank.
//
// Shape is intentionally serialisable so future topics can be authored
// as plain JSON; for now TypeScript gives us type-checking + IDE.

export type MasterClassSlide = {
  title: string;
  body: string;        // markdown-friendly; renderer can format
  bullets?: string[];
  callout?: string;    // a one-sentence emphasis
};

export type MasterClassContent = {
  slug: string;
  subject: "science" | "math" | "english" | "chinese";
  level: "P5-P6" | "P3-P4";
  topicLabel: string;          // matches examQuestion.syllabusTopic exactly
  title: string;               // human-friendly title
  stats: {
    psleQuestions: number;
    psleSubjectPercent: number;   // % of all PSLE life-science Q's
    totalPracticePool: number;     // PSLE + school
    psleQuestionsInPool: number;
    schoolQuestionsInPool: number;
    pctOeq: number;
    headline: string;             // big-stat sentence to put up top
  };
  keyConcepts: MasterClassSlide[];     // 3-4 slides
  commonMistakes: MasterClassSlide[];  // 3-4 slides
  keyWords: Array<{ word: string; definition: string }>;
};

export const interactionsEnvironment: MasterClassContent = {
  slug: "interactions-environment",
  subject: "science",
  level: "P5-P6",
  topicLabel: "Interactions within the environment",
  title: "Interactions within the Environment",
  stats: {
    psleQuestions: 11,
    psleSubjectPercent: 26.8,
    totalPracticePool: 85,
    psleQuestionsInPool: 11,
    schoolQuestionsInPool: 74,
    pctOeq: 91,
    headline: "1 in 4 PSLE Life-Science questions test this topic — 8.9% of total PSLE Science marks, and 91% of those marks are open-ended.",
  },
  keyConcepts: [
    {
      title: "How much PSLE testing on this topic",
      body: "This is by far the most-tested Life-Science topic on PSLE — both in question count and in total marks. And almost all of it is open-ended, where the marker is looking for explanations, not just picks.",
      bullets: [
        "**27%** of PSLE Life-Science questions test this topic",
        "**8.9%** of total PSLE Science marks come from it",
        "**91%** of these PSLE questions are open-ended (OEQ)",
        "**33%** test definitions of population / community / habitat / ecosystem · **19%** test food-web disruption · **7%** test adaptation",
      ],
      callout: "If you only revise one Life-Science topic — start here.",
    },
    {
      title: "Key concept definitions",
      body: "PSLE distractors are designed around one-word differences in these definitions. Get them character-perfect.",
      bullets: [
        "**Population** — a group of living things of the **same kind** in one place",
        "**Community** — all the **different populations** living in one place",
        "**Habitat** — the place where an organism lives, grows and reproduces",
        "**Ecosystem** — a community + the **non-living** factors (water, air, sunlight, soil)",
        "**Decomposer** — feeds on **dead organisms** and waste (bacteria, fungi)",
      ],
      callout: "Population = same kind. Community = different kinds. This trips up most students.",
    },
    {
      title: "Causal-chain reasoning — the place where most students lose marks",
      body: "Most OEQ marks come from writing every step. PSLE markers reward each link in the **chain**.",
      bullets: [
        "Step 1: Name what **changes** (grass dies)",
        "Step 2: Name who has **less food** (grasshoppers have less food)",
        "Step 3: Name the **outcome** (grasshoppers **starve or move away** → **population decreases**)",
        "Step 4: **Chain** to the next animal (birds now have fewer grasshoppers to eat → bird **population decreases**)",
      ],
      callout: "Writing 'bird population decreases' alone = 1 mark. Writing the full chain = 3-4 marks.",
    },
    {
      title: "Reading a food web — the operating manual",
      body: "Before answering ANY food-web question, walk through these checks. Most wrong answers come from misreading the diagram, not from misunderstanding the science.",
      bullets: [
        "**Arrow direction = 'eaten by'** — 'A → B' means **B eats A**. Say this in your head before answering.",
        "**Find the producer first** — the **producer** has NO incoming arrows (nothing eats it for energy; it makes its own food via photosynthesis). Usually a plant or algae.",
        "**Count the predators of each species** — a species with **many predators** is fragile; if its prey dies out, it suffers more. A predator with **many prey options** is resilient — it just switches to another food source.",
        "**Trace energy upward** — energy flows from producer → primary consumer (eats plants) → secondary consumer (eats primary) → top predator. Apex predators have **no outgoing arrows** for predation.",
      ],
      callout: "Always answer the question 'WHO eats WHOM here?' before predicting population changes.",
    },
    {
      title: "Food-web question shapes you'll meet",
      body: "Aside from causal-chain OEQ, food-web questions on PSLE come in a few predictable shapes. Recognising the shape tells you exactly what kind of answer the marker wants.",
      bullets: [
        "**Match-graph MCQ (19%)** — 4 graphs showing populations of B, C, D, E over time; pick the one that matches a predicted change. **Trick**: solve in your head first, THEN match — don't read graphs first.",
        "**True-statement MCQ (19%)** — 4 statements about the food web (e.g. 'W) energy comes from Sun, X) A is a producer, Y) B has 3 predators, Z) C will increase'). Check each statement against the diagram. Eliminate the false ones.",
        "**Draw the food web (PSLE OEQ)** — given a paragraph like 'B and C feed on F; E eats both B and C', draw the web with **correct arrow direction** (energy from prey to predator). Always include the Sun if asked about energy.",
        "**Count chains / predators** — 'How many food chains are in this web?' Trace each path from producer to top predator separately; branching creates separate chains.",
        "**Source-of-energy question** — short factual answer. The ultimate source of energy for every food chain is the **Sun** — even in deep-water food chains, energy traces back through photosynthesis.",
      ],
      callout: "When you see a food web, identify the shape FIRST. Each shape has its own answer template.",
    },
    {
      title: "Decomposers — the easy-to-miss scorer",
      body: "Decomposers (**bacteria** and **fungi**, including **mould**) don't usually appear in the food-web diagram, but they're often the missing piece in OEQ answers. Knowing their role unlocks 1-2 mark bonuses that most students leave on the table.",
      bullets: [
        "**What they do** — feed on **dead organisms** and waste; **respire** (use up **oxygen**, release **carbon dioxide**); break dead matter down so **nutrients return to the soil**.",
        "**Why they matter** — without decomposers, dead matter piles up and **nutrients stay trapped**. Plants can't grow → entire food chain collapses.",
        "**Aquarium trap** — when a plant dies in a pond/aquarium, decomposers **use up oxygen** as they respire on the dead plant. Less oxygen left for fish.",
        "**Common PSLE phrasing** — 'What is the role of bacteria in this ecosystem?' Answer template: 'Bacteria decompose dead organisms / waste, releasing nutrients back to the soil for plants to absorb.'",
      ],
      callout: "Decomposers are the 'invisible' link in every ecosystem question — add them to your answer.",
    },
    {
      title: "Mutual-benefit patterns: master the scoring patterns",
      body: "Aquarium and pond questions almost always test mutualism. The two most common patterns:",
      bullets: [
        "**Plant + fish**: plant releases **oxygen** (**photosynthesis**) → fish use for **respiration**; fish release **carbon dioxide** (**respiration**) → plant uses for **photosynthesis**",
        "**Pollinator + flower**: bird/insect **feeds on nectar**; **pollen sticks to body** → carried to next flower → **pollination** → **fertilisation**",
        "**Cleaner + host**: bird **feeds on parasites** of a larger animal; the animal stays **clean** and the bird gets **food**",
      ],
      callout: "Both organisms must benefit — if one is harmed, it's NOT mutualism.",
    },
    {
      title: "Adaptation: feature + how-it-helps",
      body: "Adaptations are **features** or **behaviours** that help an organism survive in its environment. PSLE answer template is fixed: name the **feature** → explain **how it helps** → connect to the **environmental condition**.",
      bullets: [
        "**Physical features** — body parts shaped for survival (thick fur → keep warm in cold; waxy leaves → reduce water loss; webbed feet → swim faster)",
        "**Behaviours** — actions to survive (hibernation, migration, camouflage to hide from predators)",
        "**Tolerance graphs** — when shown a graph of population vs temperature/light/water, look for the **peak range** that suits the organism. State the specific range, not just 'high' or 'low'.",
        "**Plant adaptations to environment** — deep tap roots → reach water in dry soil; broad leaves → catch sunlight in forest floor; floating stems → stay near light surface in pond",
      ],
      callout: "Answer template: 'Feature: ____. How it helps: enables ____ so the organism can survive in ____.'",
    },
  ],
  commonMistakes: [
    {
      title: "Mixing up population and community",
      body: "These two words appear in nearly every PSLE Life-Science paper. The distractor in the MCQ is always 'a group of **different** species' — that's a community, not a population.",
      bullets: [
        "WRONG: 'A population is a group of different species in one place.'",
        "RIGHT: 'A population is a group of living things of the **same kind** that live together and reproduce in a particular place.'",
        "Tip: population = **one kind**, community = **many kinds**.",
      ],
      callout: "Real PSLE 2023 distractor used this exact swap.",
    },
    {
      title: "Skipping the 'because there is less food' step",
      body: "If you write only the outcome without the cause, you lose 1-2 marks per question.",
      bullets: [
        "WRONG: 'The bird population will decrease.'",
        "RIGHT: 'With less grass, the grasshopper population decreases. With fewer grasshoppers, birds have less food, so the bird population decreases as they die or fly away.'",
        "Always answer the question 'WHY' — the marker is looking for the linking phrase 'because there is less food'.",
      ],
      callout: "OEQ marking rubric awards points per link in the chain — never write just the endpoint.",
    },
    {
      title: "Saying plants give food to fish in aquariums",
      body: "Unless the question shows the fish actually eating the plant, plants do NOT give food to fish in PSLE answers.",
      bullets: [
        "WRONG: 'Plants give food to fish.'",
        "RIGHT: 'Plants give oxygen (from photosynthesis) for the fish to respire. Plants also provide shelter for the fish.'",
        "Look at the diagram — only if a fish is shown eating algae/aquatic plant does 'food' apply.",
      ],
      callout: "PSLE 2024 Q5 distractor used exactly this — 'plants give food to fish' was wrong.",
    },
    {
      title: "Reversing the arrow in a food web",
      body: "Food-web arrows go from the EATEN to the EATER. 'A → B' means 'B eats A'. Many students reverse this and lose marks on every food-web question.",
      bullets: [
        "Read 'A → B' as: 'A is eaten by B' or 'B eats A'.",
        "The arrow shows energy flow direction.",
        "Producers (plants) have no incoming arrows — they make their own food.",
        "If you can't tell which is the producer, the answer to 'which arrow is wrong' is often staring you in the face.",
      ],
      callout: "Always say in your head: 'A is eaten by B' before answering.",
    },
  ],
  keyWords: [
    { word: "population", definition: "A group of living things of the same kind that live together and reproduce in a particular place." },
    { word: "community", definition: "All the different populations of living things living together in a particular place." },
    { word: "habitat", definition: "The place where an organism lives, grows and reproduces." },
    { word: "ecosystem", definition: "A community together with the non-living factors (e.g. water, air, sunlight, soil) in their environment." },
    { word: "producer", definition: "A living thing (usually a plant) that makes its own food via photosynthesis." },
    { word: "consumer", definition: "A living thing that gets food by eating other living things." },
    { word: "decomposer", definition: "A living thing (bacteria, fungi) that feeds on dead organisms and waste." },
    { word: "predator", definition: "An animal that hunts and eats other animals." },
    { word: "prey", definition: "An animal that is hunted and eaten by another animal." },
    { word: "mutualism", definition: "A relationship between two organisms where both benefit." },
    { word: "adaptation", definition: "A feature or behaviour that helps an organism survive in its environment." },
  ],
};
