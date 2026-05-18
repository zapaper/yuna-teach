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
  /** Optional 1-mark-vs-full-marks example block. Rendered as a
   *  red/green comparison below the bullets so students see exactly
   *  what scoring upgrade they're aiming for. */
  scoringExample?: {
    scenario: string;
    oneMark: { label: string; text: string };
    fullMarks: { label: string; text: string };
  };
  /** Optional inline pie chart — renders a SVG donut showing the
   *  highlighted % vs the rest. Used on stats slides to make the
   *  headline number visual. */
  pieChart?: {
    percentage: number;
    label: string;
    caption?: string;
  };
  /** Optional AI-generated diagram. The `diagramPrompt` is hand-
   *  authored; the workshop view has a "Generate diagram" button that
   *  calls Gemini image-gen and saves the result to disk under
   *  VOLUME_PATH/master-class/<slug>/slide-<idx>.jpg. The renderer
   *  loads the image lazily via the diagram GET endpoint. */
  diagramPrompt?: string;
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
    psleQuestions: 19,
    psleSubjectPercent: 28.4,
    totalPracticePool: 85,
    psleQuestionsInPool: 19,
    schoolQuestionsInPool: 66,
    pctOeq: 58,
    headline: "More than 1 in 4 PSLE Life-Science questions test this topic — 10.8% of total PSLE Science marks, and 58% of them are open-ended.",
  },
  keyConcepts: [
    {
      title: "How much PSLE testing on this topic",
      body: "This is by far the most-tested Life-Science topic on PSLE — both in question count and in total marks. A roughly even mix of MCQ and OEQ, with the OEQ carrying the heavier mark weight.",
      pieChart: {
        percentage: 12,
        label: "of PSLE Science marks",
        caption: "More than any other single Life-Science topic.",
      },
      bullets: [
        "**28%** of PSLE Life-Science questions test this topic",
        "**~12%** of total PSLE Science marks come from it",
        "**58%** are open-ended (OEQ), **42%** are MCQ",
        "**We will cover the top common questions and mistakes:**\n  • Definitions\n  • Food Web\n  • Adaptation\n  • Mutualism\n  • Decomposer\n  • Human Impact",
      ],
      callout: "If you only revise one Life-Science topic — start here.",
    },
    {
      title: "1: Key Definitions",
      body: "**33% of PSLE OEQ** have a definition sub-part. This is a give-away to master.",
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
      title: "Food Web: Causal Chain reasoning — common mistakes",
      body: "Most questions will show a food web, and describe what happens when one population decreases. PSLE markers reward each link in the **chain** — writing only the endpoint earns 1 mark, the full chain earns 3-4.",
      bullets: [
        "Step 1: Name what **changes** (grass dies)",
        "Step 2: Name who has **less food** (grasshoppers have less food)",
        "Step 3: Name the **outcome** (grasshoppers **starve or move away** → **population decreases**)",
        "Step 4: **Chain** to the next animal (birds now have fewer grasshoppers to eat → bird **population decreases**)",
      ],
      scoringExample: {
        scenario: "Disease kills the grass in habitat T (grass → grasshopper → bird → fox). What happens to the bird population?",
        oneMark: {
          label: "1 mark",
          text: "The bird population will decrease.",
        },
        fullMarks: {
          label: "3 marks",
          text: "With less grass to feed on, the grasshopper population decreases as they starve or move away. Birds then have fewer grasshoppers to feed on, so the bird population also decreases.",
        },
      },
      callout: "Writing 'bird population decreases' alone = 1 mark. Writing the full chain = 3-4 marks.",
    },
    {
      title: "Food Web: explaining it",
      body: "Most wrong answers come from misreading the diagram, not from misunderstanding the science. Use a fixed 2-step process for **every** food-web question.",
      bullets: [
        "**Arrow direction = 'eaten by'** — 'A → B' means **B eats A**. Say this in your head before answering.",
        "**Find the producer first** — the **producer** has NO incoming arrows (nothing eats it; it makes its own food via photosynthesis). The **ultimate source of energy is always the Sun**.",
        "**Step 1** — Map out the **producer**, **primary consumer** (plant eater), and **secondary consumer** (meat eater).",
        "**Step 2** — Map the **impact on each group** with the change. (**↑** for increase, **↓** for decrease.)",
        "**Match-graph MCQ trick** — solve the impact in your head FIRST, then match to one of the 4 graphs. Don't read the graphs first or you'll get pattern-matched into the wrong answer.",
      ],
      scoringExample: {
        scenario: "The food chain shown is: grass → grasshopper → bird. Explain how energy is transferred along this chain.",
        oneMark: {
          label: "1 mark",
          text: "Energy flows from grass to grasshopper to bird.",
        },
        fullMarks: {
          label: "3 marks",
          text: "Grass is the **producer** — it captures **sunlight energy through photosynthesis**. The grasshopper eats the grass, transferring energy from grass to grasshopper. The bird then eats the grasshopper, transferring the energy further along the chain. So the **ultimate source of energy is the Sun**.",
        },
      },
      callout: "Map first (Step 1 + Step 2), then answer. 'WHO eats WHOM?' before any prediction.",
    },
    {
      title: "Mutual Benefits scoring pattern",
      body: "Aquarium and pond questions almost always test mutualism.",
      bullets: [
        "**Plant + fish**: plant releases **oxygen** (**photosynthesis**) → fish use for **respiration**; fish release **carbon dioxide** (**respiration**) → plant uses for **photosynthesis**",
        "**Pollinator + flower**: bird/insect **feeds on nectar**; **pollen sticks to body** → carried to next flower → **pollination** → **fertilisation**",
        "**Cleaner + host**: bird **feeds on parasites** of a larger animal; the animal stays **clean** and the bird gets **food**",
        "**Common trap** — Don't say 'plants give food to fish'. Unless the fish is shown eating the plant, plants give **oxygen** (and **shelter**), NOT food. PSLE 2024 used this exact distractor.",
      ],
      scoringExample: {
        scenario: "How do aquatic plants and fish benefit each other in an aquarium?",
        oneMark: {
          label: "1 mark (incomplete)",
          text: "Plants give food to fish, and fish give carbon dioxide to plants.",
        },
        fullMarks: {
          label: "4 marks",
          text: "Plants release oxygen during photosynthesis, which the fish use for respiration. Fish release carbon dioxide during respiration, which the plants use for photosynthesis. The plants also provide shelter for the fish.",
        },
      },
      callout: "Both organisms must benefit — if one is harmed, it's NOT mutualism.",
    },
    {
      title: "Adaptation: Feature → how it helps → link to environment",
      body: "Adaptations are **features** or **behaviours** that help an organism survive in its environment. PSLE answer template is fixed: name the **feature** / **behaviour** → explain **how it helps** → connect to the **environmental condition**.",
      bullets: [
        "**Physical features — Animals**: body parts shaped for survival (thick fur → keep warm in cold; webbed feet → swim faster; gills → take in oxygen from water).",
        "**Physical features — Plants**: deep tap roots → reach water in dry soil; broad leaves → catch sunlight on forest floor; waxy leaves → reduce water loss; floating stems → stay near the light surface in a pond.",
        "**Behaviours** — actions to survive (hibernation, migration, camouflage to hide from predators).",
        "**Bonus — Tolerance graphs**: when shown a graph of population vs temperature / light / water, look for the **peak range** that suits the organism. State the specific range (e.g. 'between 20°C and 25°C', 'around 60 units of water vapour'), not just 'high' or 'low'.",
      ],
      scoringExample: {
        scenario: "How does the polar bear's thick fur help it survive in the Arctic?",
        oneMark: {
          label: "1 mark",
          text: "Polar bear has thick fur.",
        },
        fullMarks: {
          label: "3 marks",
          text: "Polar bear has thick fur which traps a layer of air to keep it warm in the cold Arctic environment.",
        },
      },
      callout: "Answer template: 'Feature: ____. How it helps: ____. This helps the organism survive in ____.'",
    },
    {
      title: "Decomposer: easy to miss points",
      body: "Decomposers (**bacteria** and **fungi**, including **mould**) don't usually appear in the food-web diagram, but they're often the missing piece in OEQ answers. Knowing their role unlocks 1-2 mark bonuses that most students leave on the table.",
      bullets: [
        "**What they do** — feed on **dead organisms** and waste; **respire** (use up **oxygen**, release **carbon dioxide**); break dead matter down, **releasing nutrients back to soil**.",
        "**Why they matter** — without decomposers, dead matter piles up and **nutrients stay trapped**. Plants can't grow → entire food chain collapses.",
        "**Aquarium trap** — when a plant dies in a pond/aquarium, decomposers **use up oxygen** as they **respire** on the dead plant. Less oxygen left for fish.",
      ],
      scoringExample: {
        scenario: "What is the role of bacteria in this ecosystem?",
        oneMark: {
          label: "1 mark",
          text: "Bacteria break down dead organisms.",
        },
        fullMarks: {
          label: "3 marks",
          text: "Bacteria decompose dead organisms and waste, **releasing nutrients** back to the soil for **plants to absorb**.",
        },
      },
      callout: "Decomposers are the 'invisible' link in every ecosystem question — add them to your answer.",
    },
  ],
  // Common-mistakes deck retired — the equivalent warnings are now
  // baked into the relevant Key Concept slides (e.g. "plants give food
  // to fish" lives in the Mutualism slide; arrow direction is in the
  // Food-Web Reading slide).
  commonMistakes: [],
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
