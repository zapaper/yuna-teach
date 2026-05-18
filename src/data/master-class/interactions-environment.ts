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
    pctOeq: 47,
    headline: "1 in 4 PSLE Life-Science questions test this topic — more than any other Life-Science chapter.",
  },
  keyConcepts: [
    {
      title: "Why this topic carries so many marks",
      body: "Out of every PSLE Science paper, this is the single most-tested Life-Science topic. Half the questions are OEQ — students lose marks not because they don't know the science, but because they don't write the **full causal chain**.",
      bullets: [
        "27% of PSLE Life-Science questions test this topic",
        "Nearly half (47%) are open-ended — you must explain, not just pick",
        "Most OEQs follow the same shape: 'Organism X decreases. What happens to Y?'",
      ],
      callout: "If you only revise one Life-Science topic — start here.",
    },
    {
      title: "The 5 vocabulary pillars",
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
      title: "Causal-chain reasoning — the biggest scorer",
      body: "Most OEQ marks come from writing every step. PSLE markers reward each link in the chain.",
      bullets: [
        "Step 1: Name what changes (grass dies)",
        "Step 2: Name who loses food (grasshoppers have less food)",
        "Step 3: Name the outcome (grasshoppers starve or move away → population decreases)",
        "Step 4: Chain to the next animal (birds now have fewer grasshoppers to eat → bird population decreases)",
      ],
      callout: "Writing 'bird population decreases' alone = 1 mark. Writing the full chain = 3-4 marks.",
    },
    {
      title: "Mutual-benefit patterns to recognise",
      body: "Aquarium and pond questions almost always test mutualism. The two most common patterns:",
      bullets: [
        "**Plant + fish**: plant releases **oxygen** (photosynthesis) → fish use for **respiration**; fish release **carbon dioxide** (respiration) → plant uses for **photosynthesis**",
        "**Pollinator + flower**: bird/insect feeds on **nectar**; pollen sticks to body → carried to next flower → pollination → fertilisation",
        "**Cleaner + host**: bird feeds on parasites of a larger animal; the animal stays clean and the bird gets food",
      ],
      callout: "Both organisms must benefit — if one is harmed, it's NOT mutualism.",
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
