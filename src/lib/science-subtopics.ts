// Per-topic sub-topic buckets for Science. Shared across P5 + P6 + PSLE
// because the bucket boundaries reflect P6 syllabus depth and P5 rolls
// up cleanly (P5 questions can pull from the same buckets, and Lumi
// quizzes can dip into P5 as a soft fallback when a P6 bucket is thin).
//
// Drives:
//   1. Sub-topic classifier (scripts/classify-science-subtopics.ts).
//   2. LumiQuizCombo.subTopicWeights validation — combos can only
//      target a sub-topic that exists in this map.
//   3. Trend-aware prioritisation (future): topic + sub-topic deltas
//      from the kid's recent-third vs overall accuracy.
//
// Two topics already had buckets baked in via the Mastery-paper
// tagging pass (Electrical + Interactions within the environment).
// The other 14 were derived by Gemini reading ~40-50 sampled
// questions per topic and proposing 3-4 buckets, then validating
// the distribution by re-classifying the same sample. See
// scripts/derive-subtopic-buckets.ts and eval/derived-buckets/*.json
// for the artefacts.
//
// Topics intentionally excluded (pool too thin even with MCQs):
//   · Cells (18 OEQ / 22 total)
//   · Plant respiratory and circulatory systems (13 / 15)

export type ScienceTopicBuckets = {
  topic: string;
  buckets: { id: string; description: string }[];
};

export const SCIENCE_SUBTOPIC_TAXONOMY: ScienceTopicBuckets[] = [
  // ── Pre-existing (Mastery-paper tagging pass) ───────────────────
  {
    topic: "Electrical system and circuits",
    buckets: [
      { id: "series-vs-parallel", description: "Comparing series and parallel circuits — switch behaviour, bulb brightness when one bulb is removed, current paths." },
      { id: "general-circuits", description: "Circuit reading — which path completes, which bulb lights, current flow, open vs closed circuit." },
      { id: "bulb-brightness", description: "What makes a bulb brighter or dimmer — battery count, bulb count in series, wire length / thickness." },
      { id: "electromagnets", description: "Electromagnet behaviour — current causes magnetism, strength factors (coil turns, current size, core material)." },
    ],
  },
  {
    topic: "Interactions within the environment",
    buckets: [
      { id: "adaptation", description: "How a feature of a living thing helps it survive in its environment." },
      { id: "food-web-explaining", description: "Reading food webs / chains, predicting what happens if one organism is removed or added." },
      { id: "causal-chain", description: "Walking through a multi-step cause-and-effect chain across organisms or environment factors." },
      { id: "decomposer", description: "Role of decomposers (fungi, bacteria) in recycling nutrients back to the environment." },
      { id: "human-impact", description: "Human activity affecting an ecosystem — pollution, deforestation, conservation." },
      { id: "mutual-benefits", description: "Mutualistic relationships between organisms (clownfish-anemone, etc.)." },
    ],
  },

  // ── Data-derived buckets ───────────────────────────────────────
  {
    topic: "Heat energy and uses",
    buckets: [
      { id: "heat-transfer-and-materials", description: "Testing conduction and insulation, and how material type, surface area, or trapped air affect the rate of heat transfer." },
      { id: "changes-of-state", description: "Melting, freezing, boiling, and evaporation — often involving interpretation of temperature-time graphs that plateau during state change." },
      { id: "expansion-and-contraction", description: "Expansion of solids, liquids, and gases when heated and contraction when cooled, including real-world applications (railway tracks, bridge joints)." },
      { id: "heat-temperature-and-measurement", description: "Distinguishing heat from temperature, correct use of thermometers, relationship between heat energy, mass, and temperature change." },
    ],
  },
  {
    topic: "Reproduction in plants and animals",
    buckets: [
      { id: "reproductive-parts-and-functions", description: "Identifying reproductive parts in plants and humans (anther, stigma, ovule, testes, ovary, etc.) and their specific functions." },
      { id: "pollination-and-fertilisation", description: "Pollination and fertilisation in plants and animals — agents (wind, insects), conditions required, comparing pollination types." },
      { id: "fruit-and-seed-dispersal", description: "Methods, structural adaptations, and advantages of fruit and seed dispersal (wind / water / animal / explosive)." },
      { id: "experimental-design-and-data-interpretation", description: "Interpreting data from charts and graphs or understanding experimental setups related to any aspect of reproduction." },
    ],
  },
  {
    topic: "Interaction of forces (Frictional force, gravitational force, elastic spring force)",
    buckets: [
      { id: "investigating-frictional-force", description: "Experiments on how surface texture, mass, or lubricants affect the amount of friction or an object's motion." },
      { id: "investigating-elastic-force", description: "Experiments with springs or elastic materials — relationship between force, extension or compression, and material properties." },
      { id: "identifying-and-representing-forces", description: "Identifying the presence and direction of forces like gravity, friction, and elastic force in various scenarios." },
      { id: "applying-force-concepts", description: "Applying force properties to explain phenomena, predict outcomes, or analyse energy changes." },
    ],
  },
  {
    topic: "Energy conversion",
    buckets: [
      { id: "gravitational-potential-to-kinetic", description: "Conversion between gravitational potential energy and kinetic energy — ramps, pendulums, falling objects." },
      { id: "elastic-potential-to-kinetic", description: "Conversion between elastic potential energy and kinetic energy — springs, rubber bands, other deformable materials." },
      { id: "electricity-generation-and-application", description: "Converting various energy sources into electrical energy and its application in powering devices like bulbs or motors." },
      { id: "energy-loss-and-inefficiency", description: "Conversion of useful energy into non-useful forms like heat and sound due to friction, air resistance, or inherent inefficiency." },
    ],
  },
  {
    topic: "Human respiratory and circulatory systems",
    buckets: [
      { id: "system-components-and-functions", description: "Identifying the parts of the respiratory and circulatory systems and describing their primary roles." },
      { id: "gas-exchange-and-air-composition", description: "Gas exchange in the lungs and the differences in composition between inhaled and exhaled air." },
      { id: "blood-circulation-and-transport", description: "Pathway of blood flow and the transport of oxygen, carbon dioxide, and nutrients to and from different body parts." },
      { id: "physiological-response-to-activity", description: "How and why breathing rate, heart rate, and blood flow change in response to physical activities like exercise." },
    ],
  },
  {
    topic: "Photosynthesis",
    buckets: [
      { id: "factors-affecting-photosynthesis", description: "How the rate of photosynthesis is influenced by light intensity, carbon dioxide concentration, and temperature." },
      { id: "photosynthesis-fundamentals", description: "Core definition — requirements (light, water, CO₂), products (sugar, oxygen), role of chlorophyll or chloroplasts." },
      { id: "gas-exchange-and-respiration", description: "Interplay between photosynthesis and respiration — predicting or explaining net change in gas levels in a sealed environment." },
      { id: "scientific-investigation-method", description: "Application of scientific method to photosynthesis experiments — identifying variables, designing control set-ups, ensuring a fair test." },
    ],
  },
  {
    topic: "Interaction of forces (Magnets)",
    buckets: [
      { id: "interaction-with-other-forces", description: "Scenarios where magnetic force interacts with other forces such as gravity, friction, and elastic force." },
      { id: "magnetic-properties-and-principles", description: "Fundamental magnetic characteristics — poles, attraction, repulsion, identification of magnetic materials." },
      { id: "electromagnetism-and-applications", description: "Creating electromagnets, factors affecting their strength, and their use in various devices." },
    ],
  },
  {
    topic: "Cycles in matter",
    buckets: [
      { id: "properties-of-matter", description: "Fundamental properties of solids, liquids, and gases — mass, occupying space, definite shape or volume, compressibility." },
      { id: "interpreting-heating-curves-data", description: "Analysis of temperature-time graphs or tables of melting and boiling points to determine a substance's state." },
      { id: "water-cycle-applications", description: "Applying evaporation, condensation, and freezing to explain everyday phenomena — water droplets or ice on cold surfaces." },
      { id: "measuring-volume-displacement", description: "Calculating or determining the volume of objects or substances using the water displacement method or how matter occupies space." },
    ],
  },
  {
    topic: "Plant parts and functions",
    buckets: [
      { id: "water-transport-system", description: "Absorption of water by roots and its upward movement through the water-carrying tubes (xylem)." },
      { id: "food-production-and-transport", description: "Photosynthesis in leaves and the distribution of manufactured food through the food-carrying tubes (phloem)." },
      { id: "transpiration-and-gaseous-exchange", description: "Water loss (transpiration) and the exchange of gases through tiny openings (stomata) on the leaves." },
      { id: "integrated-plant-systems", description: "Interaction between the water and food transport systems or how different parts work together for overall plant function." },
    ],
  },
  {
    topic: "Diversity of living and non-living things",
    buckets: [
      { id: "classification-of-organisms", description: "Using or interpreting classification tools — flowcharts, tables, dichotomous keys — to group organisms." },
      { id: "characteristics-of-animals", description: "Defining features of different animal groups: insects, birds, mammals, fish, amphibians." },
      { id: "characteristics-of-plants-and-fungi", description: "Defining features of plants and fungi — how they obtain food, reproduce, and are structured." },
      { id: "properties-of-life-and-micro-organisms", description: "Universal characteristics of living things, distinction between living and non-living, properties of micro-organisms like bacteria." },
    ],
  },
  {
    topic: "Life cycles in plants and animals",
    buckets: [
      { id: "seed-germination-and-experiments", description: "Conditions for seed germination, role of seed parts during growth, designing fair experiments on these factors." },
      { id: "animal-life-cycle-stages", description: "Identifying, sequencing, and comparing the stages in various animal life cycles, including their distinct characteristics." },
      { id: "plant-reproduction-and-life-cycle", description: "Life cycle of a flowering plant after germination — functions of flowers, fruits, and the processes of reproduction." },
      { id: "factors-affecting-animal-development", description: "Interpreting data or scenarios to analyse how environmental factors and ecological interactions influence animal life cycles." },
    ],
  },
  {
    topic: "Light energy and uses",
    buckets: [
      { id: "shadow-formation-and-properties", description: "Formation of shadows, predicting their shape, factors that change their size or position." },
      { id: "vision-and-reflection", description: "How light travels from a source, reflects off objects, and enters the eye to enable sight." },
      { id: "light-investigations-and-data", description: "Designing or interpreting experiments — often using light sensors and data — to investigate properties of light and materials." },
      { id: "properties-of-materials", description: "Classifying materials as transparent, translucent, or opaque based on their interaction with light." },
    ],
  },
  {
    topic: "Water cycle, evaporation, condensation",
    buckets: [
      { id: "explaining-condensation-phenomena", description: "Explaining everyday observations of condensation — mist, fog, droplets forming on a cooler surface, breath on cold glass." },
      { id: "factors-affecting-evaporation", description: "Experiments comparing how temperature, wind, or exposed surface area affect the rate of evaporation." },
      { id: "evaporation-condensation-systems", description: "Systems like solar stills, terrariums, or distillation where evaporation and condensation are used together." },
      { id: "water-cycle-and-definitions", description: "Identifying stages in the global water cycle or the fundamental definitions of processes like evaporation and boiling." },
    ],
  },
  {
    topic: "Diversity of materials",
    buckets: [
      { id: "properties-and-applications", description: "Linking a material's property (strength, flexibility, waterproof, conductivity) to its suitability for a particular function in an everyday object." },
      { id: "fundamental-concepts-of-matter", description: "Core concepts of matter — mass, volume, density (as observed through floating and sinking)." },
      { id: "scientific-investigation-and-classification", description: "Designing fair tests, interpreting experimental data, classifying materials using tables and flowcharts." },
    ],
  },
  {
    topic: "Human digestive system",
    buckets: [
      { id: "organ-identification-and-function", description: "Identifying parts of the digestive system from diagrams and describing the main function of specific organs." },
      { id: "process-of-digestion-and-absorption", description: "Breakdown of food and absorption of nutrients — often involving interpretation of graphs or data showing changes in substances." },
      { id: "factors-and-system-interactions", description: "Experimental factors affecting the rate of digestion or the relationship between the digestive system and other body systems." },
    ],
  },
];

// Quick lookup — used at runtime by validators / combos.
export const SCIENCE_SUBTOPIC_INDEX: Record<string, string[]> = Object.fromEntries(
  SCIENCE_SUBTOPIC_TAXONOMY.map(({ topic, buckets }) => [topic, buckets.map(b => b.id)]),
);

export function isValidSubTopic(topic: string, subTopic: string): boolean {
  const ids = SCIENCE_SUBTOPIC_INDEX[topic];
  return Array.isArray(ids) && ids.includes(subTopic);
}

// Per-bucket description lookup — used by the classifier prompt.
export function describeBucket(topic: string, subTopic: string): string | null {
  const entry = SCIENCE_SUBTOPIC_TAXONOMY.find(t => t.topic === topic);
  if (!entry) return null;
  const b = entry.buckets.find(b => b.id === subTopic);
  return b?.description ?? null;
}
