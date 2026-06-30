// AUTO-GENERATED — do not edit by hand.
// Run: npx tsx scripts/_auto-promote-lumi-combos.ts
// Reads workshop cache (src/lib/tutor-cache/) + DB to build a combo
// per kid+subject for every kid with both a workshop diagnosis AND
// ≥2 pickable weak topics (≥5 attempts each).
//
// Used as a fallback by lumi-combos.ts when no hand-written entry
// exists.

import type { LumiQuizCombo, LumiEnglishQuizCombo } from "./lumi-combos";

export const AUTO_LUMI_COMBOS_SCIENCE: Record<string, LumiQuizCombo[]> = {
  // al4
  "cmpjrpzqc00qheplmyhd42g36": [
    {
      label: "Interaction of forces — focused practice",
      rationale: "Top miss area (5/10 = 50%). Drilled where your sub-topic gaps are biggest.",
      topic: "Interaction of forces (Magnets)",
      subTopicWeights: {"magnetic-properties-and-principles":10},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Interaction of forces — what to look out for",
        watchOut: [
        "When a question asks you to **'describe how'** or **'explain how'** an experiment works, imagine you are writing an instruction manual for a friend.\n- **List the exact actions** (e.g., 'move the paper clip', 'bring both ends close').\n- **State what to measure or observe** to get the result.",
        "Instead of explaining how to move the paper clip to test the magnet's strength, AL4 just wrote that a ruler was used.",
        "AL4 left the question blank when asked to explain how to test if a metal bar is a magnet."
        ],
      },
    },
    {
      label: "Life cycles in plants and animals — focused practice",
      rationale: "Top miss area (5/13 = 38%). Drilled where your sub-topic gaps are biggest.",
      topic: "Life cycles in plants and animals",
      subTopicWeights: {"seed-germination-and-experiments":5,"animal-life-cycle-stages":3,"plant-reproduction-and-life-cycle":3},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Life cycles in plants and animals — what to look out for",
        watchOut: [],
      },
    },
  ],
  // alexa-goh
  "cmonse0zo004v8eod7ohjm6go": [
    {
      label: "Water cycle, evaporation, condensation — focused practice",
      rationale: "Top miss area (8/10 = 80%). Drilled where your sub-topic gaps are biggest.",
      topic: "Water cycle, evaporation, condensation",
      subTopicWeights: {"factors-affecting-evaporation":5,"explaining-condensation-phenomena":3,"water-cycle-and-definitions":3},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Water cycle, evaporation, condensation — what to look out for",
        watchOut: [
        "When you see an open-ended question, never leave it empty! Treat it as a chance to collect points:\n- **Write down the science keywords** you know belong to the topic (like 'evaporation', 'condensation', or 'gains heat').\n- **Describe what you see** happening in the picture, even if you aren't sure of the full scientific reason.\n- Every correct keyword or step can earn you a half or full mark!",
        "Alexa left the entire question blank instead of trying to explain how the water droplets gained heat and evaporated.",
        "She skipped explaining how the mirror became foggy, missing a chance to mention 'condensation' for partial credit."
        ],
      },
    },
    {
      label: "Cycles in matter — focused practice",
      rationale: "Top miss area (11/20 = 55%). Drilled where your sub-topic gaps are biggest.",
      topic: "Cycles in matter",
      subTopicWeights: {"properties-of-matter":5,"measuring-volume-displacement":3,"interpreting-heating-curves-data":2},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Cycles in matter — what to look out for",
        watchOut: [
        "When a question involves pumping air in or out of a rigid container, remember these rules:\n- **Water cannot be compressed**, so it always takes up its fixed amount of space.\n- **Air can be compressed**, so its volume is always exactly equal to the **empty space left in the container**.\n- Pumping more air in changes the **mass**, but the **volume** stays the same!",
        "She added the volumes together instead of realising the extra air would just compress into the existing 150 cm³ of empty space.",
        "She thought the final volume of air would be the total capacity of the container, forgetting to subtract the space taken up by the water."
        ],
      },
    },
  ],
  // amberamberteo
  "cmojzgv7t0026d4vn3i1frkhp": [
    {
      label: "Reproduction in plants and animals — focused practice",
      rationale: "Top miss area (13/16 = 81%). Drilled where your sub-topic gaps are biggest.",
      topic: "Reproduction in plants and animals",
      subTopicWeights: {"pollination-and-fertilisation":5,"reproductive-parts-and-functions":4,"experimental-design-and-data-interpretation":2},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Reproduction in plants and animals — what to look out for",
        watchOut: [
        "When you see **'explain why'** or **'describe how'**, treat it like a story that needs a clear ending.\n- Use linking words like **'which allows'** or **'so that'**.\n- For plant reproduction, always complete the story: **pollination → fertilisation → ovary becomes fruit**.",
        "Amberamberteo correctly named the ovule but forgot to mention it contains the egg cell for fertilisation.",
        "She described the flower's parts well but missed the step-by-step process of pollen transfer, fertilisation, and the ovary becoming a fruit."
        ],
      },
    },
    {
      label: "Diversity of materials — focused practice",
      rationale: "Top miss area (6/11 = 55%). Drilled where your sub-topic gaps are biggest.",
      topic: "Diversity of materials",
      subTopicWeights: {"fundamental-concepts-of-matter":8,"scientific-investigation-and-classification":2},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Diversity of materials — what to look out for",
        watchOut: [
        "When you see a tough question, don't leave it empty! Try to write down at least two science keywords related to the topic.\n- **'Explain why'** → write down the science concept (like 'takes up space' or 'magnetic').\n- **'State two'** → even if you only know one, write it down! Every keyword is a chance for partial marks.",
        "Amberamberteo left both parts of the question completely blank instead of trying to name the flower part or guess a difference.",
        "She skipped the explanation for how golf balls save water, missing a chance to write about them taking up space."
        ],
      },
    },
  ],
  // benjamin-ong
  "cmopc9wpb007svj1mp4mgoae2": [
    {
      label: "Plant parts and functions — focused practice",
      rationale: "Top miss area (17/29 = 59%). Drilled where your sub-topic gaps are biggest.",
      topic: "Plant parts and functions",
      subTopicWeights: {"water-transport-system":5,"integrated-plant-systems":3,"food-production-and-transport":3},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Plant parts and functions — what to look out for",
        watchOut: [
        "When you see these prompts, treat them as stop signs:\n- **'explain why'** → always add a **'so that...'** or **'which means...'** to show the final result.\n- **'describe'** → double-check if you need to mention **where** something comes from (like food made in the leaves).",
        "Benjamin correctly noted there are fewer grasshoppers, but stopped before explaining that this means less food for the birds.",
        "He correctly identified the food-carrying tubes, but forgot to mention that the food is made in the leaves."
        ],
      },
    },
    {
      label: "Diversity of living and non-living things — focused practice",
      rationale: "Top miss area (6/12 = 50%). Drilled where your sub-topic gaps are biggest.",
      topic: "Diversity of living and non-living things",
      subTopicWeights: {},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Diversity of living and non-living things — what to look out for",
        watchOut: [],
      },
    },
  ],
  // caleb
  "cmq4xj0vm0029apq234jrmrh6": [
    {
      label: "Interactions within the environment — focused practice",
      rationale: "Top miss area (13/48 = 27%). Drilled where your sub-topic gaps are biggest.",
      topic: "Interactions within the environment",
      subTopicWeights: {"food-web-explaining":7,"adaptation":2,"causal-chain":2},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Interactions within the environment — what to look out for",
        watchOut: [
        "When you see a food web and one animal increases or decreases, draw up and down arrows next to the other organisms to show what happens next.\n- **'more predators'** → the prey population goes down\n- **'less predators'** → the prey population goes up",
        "Caleb didn't correctly trace how getting rid of the caterpillars would affect the chicken population.",
        "He picked a graph that didn't correctly show how fewer birds would lead to more prey and fewer plants."
        ],
      },
    },
    {
      label: "Light energy and uses — focused practice",
      rationale: "Top miss area (5/21 = 24%). Drilled where your sub-topic gaps are biggest.",
      topic: "Light energy and uses",
      subTopicWeights: {"vision-and-reflection":10},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Light energy and uses — what to look out for",
        watchOut: [],
      },
    },
  ],
  // david-lim
  "cmm5wf91d000ryrxwaddlo6xh": [
    {
      label: "Human respiratory and circulatory systems — focused practice",
      rationale: "Top miss area (12/23 = 52%). Drilled where your sub-topic gaps are biggest.",
      topic: "Human respiratory and circulatory systems",
      subTopicWeights: {"blood-circulation-and-transport":5,"gas-exchange-and-air-composition":4,"physiological-response-to-activity":2},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Human respiratory and circulatory systems — what to look out for",
        watchOut: [
        "When you see these prompts, treat them as a chain of events:\n- **'explain how'** or **'explain why'** → always ask yourself, **'And then what happens?'** until you reach the final result.\n- Use linking words like **'so that'**, **'which causes'**, or **'resulting in'** to connect your ideas and show the full picture.",
        "He correctly identified that Animal B helps pollinate the plant, but missed the final steps about fertilisation and seed germination.",
        "He noted that the block had more gravitational potential energy, but stopped short of explaining that it converts to more kinetic energy."
        ],
      },
    },
    {
      label: "Interaction of forces — focused practice",
      rationale: "Top miss area (34/84 = 40%). Drilled where your sub-topic gaps are biggest.",
      topic: "Interaction of forces (Frictional force, gravitational force, elastic spring force)",
      subTopicWeights: {"applying-force-concepts":4,"investigating-frictional-force":3,"investigating-elastic-force":3},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Interaction of forces — what to look out for",
        watchOut: [
        "When you see these prompts, treat them as a chain of events:\n- **'explain how'** or **'explain why'** → always ask yourself, **'And then what happens?'** until you reach the final result.\n- Use linking words like **'so that'**, **'which causes'**, or **'resulting in'** to connect your ideas and show the full picture.",
        "He correctly identified that Animal B helps pollinate the plant, but missed the final steps about fertilisation and seed germination.",
        "He noted that the block had more gravitational potential energy, but stopped short of explaining that it converts to more kinetic energy."
        ],
      },
    },
  ],
  // drewie
  "cmotxyhij002gd15sbadl7k6i": [
    {
      label: "Reproduction in plants and animals — focused practice",
      rationale: "Top miss area (6/6 = 100%). Drilled where your sub-topic gaps are biggest.",
      topic: "Reproduction in plants and animals",
      subTopicWeights: {"reproductive-parts-and-functions":8,"experimental-design-and-data-interpretation":2},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Reproduction in plants and animals — what to look out for",
        watchOut: [],
      },
    },
    {
      label: "Water cycle, evaporation, condensation — focused practice",
      rationale: "Top miss area (7/9 = 78%). Drilled where your sub-topic gaps are biggest.",
      topic: "Water cycle, evaporation, condensation",
      subTopicWeights: {"water-cycle-and-definitions":6,"factors-affecting-evaporation":3,"explaining-condensation-phenomena":1},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Water cycle, evaporation, condensation — what to look out for",
        watchOut: [
        "When answering open-ended questions, think about the specific science topic being tested before you write.\n- **Highlight the topic** in your mind (e.g., Water Cycle, Plant Transport, Experimental Design).\n- **Brainstorm 2-3 keywords** related to that topic (like 'evaporation', 'surface area', or 'mineral salts').\n- Make sure those exact words make it into your final sentence!",
        "He correctly noticed the air gaps between the drying plates, but missed the key scoring terms 'evaporation' and 'exposed surface area'.",
        "He correctly identified that water is transported from the roots, but forgot to include 'mineral salts' in his answer."
        ],
      },
    },
  ],
  // elijah
  "cmpv1u1kz0001kej78ivc2ii2": [
    {
      label: "Interaction of forces — focused practice",
      rationale: "Top miss area (19/64 = 30%). Drilled where your sub-topic gaps are biggest.",
      topic: "Interaction of forces (Magnets)",
      subTopicWeights: {},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Interaction of forces — what to look out for",
        watchOut: [],
      },
    },
    {
      label: "Diversity of materials — focused practice",
      rationale: "Top miss area (16/216 = 7%). Drilled where your sub-topic gaps are biggest.",
      topic: "Diversity of materials",
      subTopicWeights: {},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Diversity of materials — what to look out for",
        watchOut: [
        "When you read an open-ended question, circle the exact question word and the target detail.\n- **'What happens to the amount'** → your answer must say 'increases', 'decreases', or 'remains the same'.\n- **'What happens to the size'** → your answer must describe it getting bigger or smaller.\n- Always re-read the question after writing your answer to check if they match.",
        "When asked what happens to the amount of food and water, he explained why the hamsters need it instead of stating that the amount would decrease.",
        "When asked what happens to the size of the balloon, he mentioned its weight instead of saying it gets bigger."
        ],
      },
    },
  ],
  // emily-lim
  "cmmfmmnwy00fdbbbfgm7k3wpn": [
    {
      label: "Human digestive system — focused practice",
      rationale: "Top miss area (13/50 = 26%). Drilled where your sub-topic gaps are biggest.",
      topic: "Human digestive system",
      subTopicWeights: {"process-of-digestion-and-absorption":4,"factors-and-system-interactions":4,"organ-identification-and-function":3},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Human digestive system — what to look out for",
        watchOut: [
        "When you see questions about the **digestive system**, remember these key jobs:\n- **Mouth/Teeth**: Cuts food into smaller pieces (but doesn't finish digestion).\n- **Small Intestine**: Finishes digestion and absorbs the food into the blood.\n- **Large Intestine**: Absorbs water from the leftover waste.",
        "She mixed up the roles of the small and large intestines, forgetting that the large intestine absorbs water and doesn't have digestive juices.",
        "She mentioned that teeth break food into simpler substances, but teeth only cut food into smaller pieces without chemically digesting it."
        ],
      },
    },
    {
      label: "Life cycles in plants and animals — focused practice",
      rationale: "Top miss area (9/36 = 25%). Drilled where your sub-topic gaps are biggest.",
      topic: "Life cycles in plants and animals",
      subTopicWeights: {"animal-life-cycle-stages":10},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Life cycles in plants and animals — what to look out for",
        watchOut: [
        "When you see **'explain why'** or **'explain how'**, always try to include a **'so that...'** or **'which means...'** ending to show the final result.\n- If a question asks for **'two differences'** or **'two reasons'**, number them 1 and 2 on your paper so you don't forget the second one.",
        "She correctly noted that iron and steel are magnetic, but forgot to add the final consequence that both would fall into the same container.",
        "She explained that chewing increases surface area, but missed the final step of stating that this makes digestion faster."
        ],
      },
    },
  ],
  // enxin
  "cmpii1sad0029edtv33dhmalc": [
    {
      label: "Human digestive system — focused practice",
      rationale: "Top miss area (7/11 = 64%). Drilled where your sub-topic gaps are biggest.",
      topic: "Human digestive system",
      subTopicWeights: {"organ-identification-and-function":4,"process-of-digestion-and-absorption":4,"factors-and-system-interactions":1},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Human digestive system — what to look out for",
        watchOut: [
        "When you see questions about the **digestive system**, trace the food's journey step-by-step:\n- **Mouth**: Digestion starts here (saliva).\n- **Small Intestine**: Digestion ends here, and the good stuff (digested food) enters the blood.\n- **Large Intestine**: Only the leftovers (**undigested food** and water) go here. No digestion happens here!",
        "Enxin selects an option stating that digestion starts in the stomach, forgetting that the process actually begins in the mouth with saliva.",
        "Enxin thinks that digested food is passed to the large intestine, when in fact only undigested food and water end up there."
        ],
      },
    },
    {
      label: "Water cycle, evaporation, condensation — focused practice",
      rationale: "Top miss area (17/42 = 40%). Drilled where your sub-topic gaps are biggest.",
      topic: "Water cycle, evaporation, condensation",
      subTopicWeights: {"explaining-condensation-phenomena":4,"factors-affecting-evaporation":3,"water-cycle-and-definitions":3},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Water cycle, evaporation, condensation — what to look out for",
        watchOut: [
        "When you see questions about **water droplets**, **mist**, or a **white cloud** forming, treat it as a signal to write out the full 'condensation story':\n- Start with **'warmer water vapour'** from the surroundings or the hot liquid.\n- Mention that it **'touches a cooler surface'**.\n- End with **'loses heat and condenses'** into water droplets.",
        "Enxin correctly identifies that the water will evaporate, but forgets to explain that the warm water vapour must touch the cooler metal tray and lose heat to condense into droplets.",
        "Enxin mentions that the ice gains heat, but misses the crucial step where warmer water vapour from the surrounding air touches the cooler beaker and condenses."
        ],
      },
    },
  ],
  // hongjun23
  "cmpxpj5650003129ks5j25l5i": [
    {
      label: "Life cycles in plants and animals — focused practice",
      rationale: "Top miss area (5/9 = 56%). Drilled where your sub-topic gaps are biggest.",
      topic: "Life cycles in plants and animals",
      subTopicWeights: {"animal-life-cycle-stages":3,"seed-germination-and-experiments":3,"factors-affecting-animal-development":3},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Life cycles in plants and animals — what to look out for",
        watchOut: [
        "When you see an open-ended question that looks tough, don't skip it entirely.\n- **Write down any science keywords** you know related to the topic.\n- **Describe what you see** in the diagram or graph.\n- Even a partial answer or a simple label can earn you some marks!",
        "hongjun23 left the entire question blank instead of attempting to draw the life cycle or identify the stages.",
        "hongjun23 skipped the question, missing the chance to suggest conditions for hatching or explain survival chances."
        ],
      },
    },
    {
      label: "Interaction of forces — focused practice",
      rationale: "Top miss area (5/10 = 50%). Drilled where your sub-topic gaps are biggest.",
      topic: "Interaction of forces (Frictional force, gravitational force, elastic spring force)",
      subTopicWeights: {"applying-force-concepts":7,"identifying-and-representing-forces":3},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Interaction of forces — what to look out for",
        watchOut: [],
      },
    },
  ],
  // ij
  "cmpjshl820001c9kbsdebavk9": [
    {
      label: "Interactions within the environment — focused practice",
      rationale: "Top miss area (18/42 = 43%). Drilled where your sub-topic gaps are biggest.",
      topic: "Interactions within the environment",
      subTopicWeights: {"adaptation":4,"food-web-explaining":4,"causal-chain":2},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Interactions within the environment — what to look out for",
        watchOut: [
        "When you see **'explain'** or **'describe how'**, always ask yourself 'so what?' at the end of your answer. Use a **'so that...'** or **'which leads to...'** phrase to link your thought to the final result.",
        "IJ correctly noted the shorter dispersal distance but stopped before mentioning that this leads to overcrowding.",
        "IJ explained that multiple entrances make the burrow accessible, but missed the final point that it allows them to escape if a predator blocks one path."
        ],
      },
    },
    {
      label: "Reproduction in plants and animals — focused practice",
      rationale: "Top miss area (7/23 = 30%). Drilled where your sub-topic gaps are biggest.",
      topic: "Reproduction in plants and animals",
      subTopicWeights: {"fruit-and-seed-dispersal":6,"reproductive-parts-and-functions":2,"experimental-design-and-data-interpretation":2},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Reproduction in plants and animals — what to look out for",
        watchOut: [],
      },
    },
  ],
  // jeremiahsy
  "cmnk7dkkj006z14p6yf06ohzm": [
    {
      label: "Reproduction in plants and animals — focused practice",
      rationale: "Top miss area (31/37 = 84%). Drilled where your sub-topic gaps are biggest.",
      topic: "Reproduction in plants and animals",
      subTopicWeights: {"reproductive-parts-and-functions":6,"pollination-and-fertilisation":3,"experimental-design-and-data-interpretation":1},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Reproduction in plants and animals — what to look out for",
        watchOut: [
        "Remember that the **ovary** swells to become the **fruit**, and the **ovules** inside become the **seeds**.\n- In humans, the **womb** is only for a **fertilised egg** to grow into a baby; unfertilised eggs do not develop there.",
        "He mixed up the roles of the ovary and ovules when deciding how a fruit and its seeds are formed.",
        "He thought an unfertilised egg develops in the womb, but only a fertilised egg develops into a baby there."
        ],
      },
    },
    {
      label: "Light energy and uses — focused practice",
      rationale: "Top miss area (12/23 = 52%). Drilled where your sub-topic gaps are biggest.",
      topic: "Light energy and uses",
      subTopicWeights: {"vision-and-reflection":3,"shadow-formation-and-properties":3,"properties-of-materials":3},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Light energy and uses — what to look out for",
        watchOut: [],
      },
    },
  ],
  // kaiyangnggg
  "cmojzr4fu004gd4vnx8wmz6zk": [
    {
      label: "Interaction of forces — focused practice",
      rationale: "Top miss area (59/78 = 76%). Drilled where your sub-topic gaps are biggest.",
      topic: "Interaction of forces (Frictional force, gravitational force, elastic spring force)",
      subTopicWeights: {"identifying-and-representing-forces":6,"applying-force-concepts":3,"investigating-elastic-force":1},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Interaction of forces — what to look out for",
        watchOut: [],
      },
    },
    {
      label: "Energy conversion — focused practice",
      rationale: "Top miss area (34/50 = 68%). Drilled where your sub-topic gaps are biggest.",
      topic: "Energy conversion",
      subTopicWeights: {"electricity-generation-and-application":5,"gravitational-potential-to-kinetic":3,"elastic-potential-to-kinetic":2},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Energy conversion — what to look out for",
        watchOut: [
        "When you see questions about energy conversion, ask yourself: 'Is it moving right now?'\n- **Moving objects** (wind, falling water, a flying ball) have **kinetic energy**.\n- **Stored energy** (fuels, food, batteries, stretched springs) is **potential energy**.",
        "When asked for a source that is NOT potential energy, he picked fuel (which stores chemical potential energy) instead of wind (which has kinetic energy).",
        "He thought the stretched rubber band had kinetic energy, rather than recognizing it stores potential energy until it is released."
        ],
      },
    },
  ],
  // larisalami
  "cmp0i0w260007ed25233a901u": [
    {
      label: "Heat energy and uses — focused practice",
      rationale: "Top miss area (9/42 = 21%). Drilled where your sub-topic gaps are biggest.",
      topic: "Heat energy and uses",
      subTopicWeights: {"expansion-and-contraction":5,"changes-of-state":3,"heat-temperature-and-measurement":2},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Heat energy and uses — what to look out for",
        watchOut: [
        "When you see a graph with flat lines, remember:\n- **Flat lines** mean the substance is changing state (like melting or boiling). It is still **gaining heat**, even though the temperature isn't going up!\n- **Sloped lines** mean the temperature is actually changing.",
        "Larisalami included the flat parts of the graph where the ice is melting, even though the temperature isn't increasing during those times.",
        "He picked only the sloped lines, forgetting that the ice and water are still gaining heat even when the temperature line is flat."
        ],
      },
    },
    {
      label: "Reproduction in plants and animals — focused practice",
      rationale: "Top miss area (1/5 = 20%). Drilled where your sub-topic gaps are biggest.",
      topic: "Reproduction in plants and animals",
      subTopicWeights: {"fruit-and-seed-dispersal":10},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Reproduction in plants and animals — what to look out for",
        watchOut: [],
      },
    },
  ],
  // lohxy2014
  "cmpuqemdt000112ltfrrcmpqg": [
    {
      label: "Interactions within the environment — focused practice",
      rationale: "Top miss area (6/13 = 46%). Drilled where your sub-topic gaps are biggest.",
      topic: "Interactions within the environment",
      subTopicWeights: {"food-web-explaining":8,"adaptation":2},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Interactions within the environment — what to look out for",
        watchOut: [
        "When you see a food web, remember that the arrow means **'is eaten by'** or **'gives energy to'**.\n- **Producers** (plants) only have arrows pointing AWAY from them.\n- **Trace the arrow tip** to find the eater (the predator).",
        "LohXY2014 counted only one producer, forgetting that any living thing with only outgoing arrows (and no incoming arrows) is a producer.",
        "He picked the wrong table row, likely reading the arrows backwards when trying to figure out the predator and prey roles."
        ],
      },
    },
    {
      label: "Cycles in matter — focused practice",
      rationale: "Top miss area (2/5 = 40%). Drilled where your sub-topic gaps are biggest.",
      topic: "Cycles in matter",
      subTopicWeights: {"interpreting-heating-curves-data":10},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Cycles in matter — what to look out for",
        watchOut: [],
      },
    },
  ],
  // lohzr-p4
  "cmq09jz9r006iptoefdj5bj90": [
    {
      label: "Cycles in matter — focused practice",
      rationale: "Top miss area (17/26 = 65%). Drilled where your sub-topic gaps are biggest.",
      topic: "Cycles in matter",
      subTopicWeights: {"properties-of-matter":6,"measuring-volume-displacement":4,"water-cycle-applications":1},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Cycles in matter — what to look out for",
        watchOut: [
        "When you see questions about pumping **'air'** into a **'sealed'** container or tank:\n- Remember that air is a gas, so its volume is just the **empty space** available.\n- First, subtract any liquids or solids from the total container size.\n- The leftover space is your final air volume, no matter how much extra air is pumped in!",
        "He/she added the pumped air to the tank's capacity, forgetting that the air will just compress to fit the 500 cm³ tank.",
        "He/she added the extra air from the syringe to the total, instead of realizing the air just squeezes into the remaining 150 cm³ of empty space."
        ],
      },
    },
    {
      label: "Human digestive system — focused practice",
      rationale: "Top miss area (8/14 = 57%). Drilled where your sub-topic gaps are biggest.",
      topic: "Human digestive system",
      subTopicWeights: {"organ-identification-and-function":5,"process-of-digestion-and-absorption":4,"factors-and-system-interactions":1},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Human digestive system — what to look out for",
        watchOut: [
        "When answering questions about the **digestive system**, keep these key jobs in mind:\n- **Mouth**: Digestion starts here with saliva (teeth only chew, they don't digest!).\n- **Small Intestine**: Finishes digestion AND absorbs the digested food into the blood.\n- **Large Intestine**: Does not digest! It only absorbs **water** from the leftover waste.",
        "He/she missed that the small intestine is the superstar organ responsible for both digesting food AND absorbing it.",
        "He/she mixed up the intestines, forgetting that the small intestine absorbs digested food while the large intestine absorbs water."
        ],
      },
    },
  ],
  // mark-lim
  "cmmbbyvs30004qa9yinn3drl6": [
    {
      label: "Human respiratory and circulatory systems — focused practice",
      rationale: "Top miss area (60/105 = 57%). Drilled where your sub-topic gaps are biggest.",
      topic: "Human respiratory and circulatory systems",
      subTopicWeights: {"gas-exchange-and-air-composition":5,"physiological-response-to-activity":3,"blood-circulation-and-transport":2},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Human respiratory and circulatory systems — what to look out for",
        watchOut: [],
      },
    },
    {
      label: "Plant parts and functions — focused practice",
      rationale: "Top miss area (10/16 = 63%). Drilled where your sub-topic gaps are biggest.",
      topic: "Plant parts and functions",
      subTopicWeights: {"integrated-plant-systems":10},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Plant parts and functions — what to look out for",
        watchOut: [],
      },
    },
  ],
  // omi
  "cmqjq81ni0017utjdartsk52u": [
    {
      label: "Human digestive system — focused practice",
      rationale: "Top miss area (13/22 = 59%). Drilled where your sub-topic gaps are biggest.",
      topic: "Human digestive system",
      subTopicWeights: {"organ-identification-and-function":6,"process-of-digestion-and-absorption":2,"factors-and-system-interactions":2},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Human digestive system — what to look out for",
        watchOut: [],
      },
    },
    {
      label: "Human respiratory and circulatory systems — focused practice",
      rationale: "Top miss area (4/8 = 50%). Drilled where your sub-topic gaps are biggest.",
      topic: "Human respiratory and circulatory systems",
      subTopicWeights: {"system-components-and-functions":8,"blood-circulation-and-transport":3},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Human respiratory and circulatory systems — what to look out for",
        watchOut: [],
      },
    },
  ],
  // ruthie
  "cmos5pfmw000114n1eem2gcw7": [
    {
      label: "Energy conversion — focused practice",
      rationale: "Top miss area (9/25 = 36%). Drilled where your sub-topic gaps are biggest.",
      topic: "Energy conversion",
      subTopicWeights: {"electricity-generation-and-application":4,"gravitational-potential-to-kinetic":3,"energy-loss-and-inefficiency":3},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Energy conversion — what to look out for",
        watchOut: [
        "When tracing energy conversions, take it one step at a time and remember where energy is stored versus where it is moving.\n- **Batteries and stretched objects** always start with **potential energy** (chemical or elastic).\n- **Moving objects** always have **kinetic energy**. If it's moving even a little bit, kinetic energy is not zero!\n- Remember that energy is never 'destroyed'; it usually converts into **sound and heat energy** at the end.",
        "She mixed up how kinetic energy changes as a ball rolls down and up a ramp, forgetting that it still has some kinetic energy as long as it is moving.",
        "She chose 'electrical energy' as the starting energy for a battery, but a battery actually stores 'potential energy' first."
        ],
      },
    },
    {
      label: "Interactions within the environment — focused practice",
      rationale: "Top miss area (6/31 = 19%). Drilled where your sub-topic gaps are biggest.",
      topic: "Interactions within the environment",
      subTopicWeights: {"food-web-explaining":7,"mutual-benefits":2,"adaptation":2},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Interactions within the environment — what to look out for",
        watchOut: [],
      },
    },
  ],
  // shayane
  "cmpuoa41n001d105bxxo78i02": [
    {
      label: "Diversity of living and non-living things — focused practice",
      rationale: "Top miss area (6/7 = 86%). Drilled where your sub-topic gaps are biggest.",
      topic: "Diversity of living and non-living things",
      subTopicWeights: {"classification-of-organisms":8,"characteristics-of-plants-and-fungi":2},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Diversity of living and non-living things — what to look out for",
        watchOut: [
        "When classifying living things, watch out for these tricky ones:\n- **Ferns** are plants (they make food) but they **do not have seeds** (they use spores).\n- **Mushrooms/Fungi** are not plants, so they **cannot make their own food**.",
        "She tried to classify a fern and a sunflower by whether they make their own food, but both are plants; the real difference is that ferns do not have seeds.",
        "She picked an option suggesting the mushroom could make its own food, forgetting that fungi break down dead matter instead."
        ],
      },
    },
    {
      label: "Plant parts and functions — focused practice",
      rationale: "Top miss area (7/9 = 78%). Drilled where your sub-topic gaps are biggest.",
      topic: "Plant parts and functions",
      subTopicWeights: {"integrated-plant-systems":4,"water-transport-system":4,"transpiration-and-gaseous-exchange":2},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Plant parts and functions — what to look out for",
        watchOut: [
        "When you see questions about the **digestive system**, remember the journey: Mouth → Gullet → Stomach → Small Intestine → Large Intestine. Keep in mind that **digestion starts in the mouth** and ends completely in the **small intestine**.",
        "She swapped the order of the intestines, choosing large intestine before small intestine.",
        "She selected that the mouth does not digest food, forgetting that saliva starts the digestion process."
        ],
      },
    },
  ],
  // umarh
  "cmpu1m6pf009a14gmkdfrforu": [
    {
      label: "Diversity of living and non-living things — focused practice",
      rationale: "Top miss area (13/29 = 45%). Drilled where your sub-topic gaps are biggest.",
      topic: "Diversity of living and non-living things",
      subTopicWeights: {},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Diversity of living and non-living things — what to look out for",
        watchOut: [
        "Remember this golden rule for these two groups:\n- **Plants (Ferns/Moss)** → Make their own food, so they **need light**.\n- **Fungi (Mushrooms/Yeast)** → Feed on other things, so they **do not need light**.\nHowever, they do share one big similarity: both reproduce by **spores**!",
        "He thought both ferns and mushrooms can survive without light, forgetting that ferns are plants and need light to make food.",
        "He mixed up the headings for a chart separating fungi (yeast, mushrooms) from non-flowering plants (moss, ferns)."
        ],
      },
    },
    {
      label: "Diversity of materials — focused practice",
      rationale: "Top miss area (1/7 = 14%). Drilled where your sub-topic gaps are biggest.",
      topic: "Diversity of materials",
      subTopicWeights: {},
      skillTag: "evidence-then-conclusion",
      topicRecap: {
        heading: "Diversity of materials — what to look out for",
        watchOut: [
        "When a question asks how to **identify** an animal group, look for its unique 'VIP' trait:\n- **Insects** → 6 legs, 3 body parts\n- **Fish** → gills, scales, fins\n- **Mammals** → hair/fur, produce milk\nMany animals lay eggs, so that is rarely the deciding clue!",
        "When asked how to identify an insect, UmarH chose 'lays eggs' instead of the defining feature 'has six legs'.",
        "He picked 'reproduces by laying eggs' to identify a fish, rather than its unique feature of breathing through gills."
        ],
      },
    },
  ],
};

export const AUTO_LUMI_COMBOS_ENGLISH: Record<string, LumiEnglishQuizCombo[]> = {
  // adriel
  "cmpuxa81a000nn2qp6cfegw0u": [
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (12/55 = 22%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [
        "When filling in blanks or choosing vocabulary words:\n- Look for **collocations** (words that naturally go together, like 'poor visibility' instead of 'vague visibility').\n- In cloze passages, check if your word fits the **grammar of the sentence**, not just the general topic (e.g., needing a pronoun like 'our' instead of an adjective like 'deep').",
        "He picked 'reaps', which a farmer does, instead of 'yields', which is what the garden itself does to produce a crop.",
        "He wrote the adjective 'deep' to describe the breathing, but the sentence needed the pronoun 'our' to fit the grammar."
        ],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (11/70 = 16%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"subject-verb-agreement":5,"idiomatic-prepositions":3,"pronouns":3},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When filling in blanks or choosing vocabulary words:\n- Look for **collocations** (words that naturally go together, like 'poor visibility' instead of 'vague visibility').\n- In cloze passages, check if your word fits the **grammar of the sentence**, not just the general topic (e.g., needing a pronoun like 'our' instead of an adjective like 'deep').",
        "He picked 'reaps', which a farmer does, instead of 'yields', which is what the garden itself does to produce a crop.",
        "He wrote the adjective 'deep' to describe the breathing, but the sentence needed the pronoun 'our' to fit the grammar."
        ],
      },
    },
  ],
  // al4
  "cmpjrpzqc00qheplmyhd42g36": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (1/5 = 20%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"correlative-preference":6},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [],
      },
    },
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (5/95 = 5%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [],
      },
    },
  ],
  // allisonteo
  "cmpwicswm0003pwrh52tmawxi": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (8/10 = 80%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"reported-speech":3,"subordinator":2,"correlative-preference":2},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (6/20 = 30%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"connectors-tenses":5,"pronouns":3,"verb-forms":3},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When you see tricky subjects, take a moment to check if they are singular or plural:\n- **'Neither' or 'Either'** → always treat these as singular subjects.\n- **Activities ending in '-ing'** (like 'reading') → treat the activity as a single thing, so use a singular verb.\n- **'Fellow' or 'group' words** → check if the sentence is talking about one person or many people.",
        "Chose the plural verb 'attend' instead of the singular 'attends' for the pronoun 'Neither'.",
        "Chose the plural verb 'help' instead of the singular 'helps' for the activity 'reading'."
        ],
      },
    },
  ],
  // andrea
  "cmq67kcxn0019bgkrvdku9w6f": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (5/5 = 100%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"subordinator":2,"substitution-inversion":2,"correlative-preference":1},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [],
      },
    },
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (3/5 = 60%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [],
      },
    },
  ],
  // angyunshanariel
  "cmpnv03yo001cu9v124es2hwf": [
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (18/60 = 30%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [
        "When you see a blank in a vocabulary question, look for the **story clues** in the rest of the sentence. Treat it like a detective game:\n- If there are **'leftovers'**, the feast must be big!\n- If there are **'financial difficulties'**, the spending must be huge!\n- Always double-check if your chosen word matches the **cause and effect** in the sentence.",
        "She chose 'meager' (small) for a feast, but the clue 'lots of leftovers' tells us the feast was actually 'lavish' (huge).",
        "She picked 'negligible' (tiny) for spending, but the clue 'financial difficulties' means the spending was 'extravagant' (too much)."
        ],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (6/20 = 30%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "Phrasal verbs can be tricky because changing one small word changes the whole meaning! When you see options starting with the same verb (like **'taken'** or **'set'**):\n- Read the whole sentence quietly to yourself with each option.\n- Think about whether the preposition (like 'in', 'off', or 'down') makes sense for the specific situation.",
        "She picked 'taken off' instead of 'taken in' to describe being fooled by a magician's trick.",
        "She chose 'set off' instead of 'set in' to describe fatigue starting to happen after a marathon."
        ],
      },
    },
  ],
  // audrey
  "cmpzc9z4a00f1x52fsyd53tgh": [
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (14/52 = 27%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [
        "When choosing a vocabulary word, look for the **'context clues'** hidden in the rest of the sentence.\n- Highlight the reason or action happening around the blank.\n- Ask yourself: 'Does my choice make sense with the rest of the story?'",
        "Audrey chose 'desired' instead of 'inevitable' for a concert cancellation caused by a sudden heavy downpour.",
        "She picked 'curiously' instead of 'suspiciously' to match the meaning of 'skeptically'."
        ],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (9/42 = 21%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When you see a phrasal verb question, try replacing the blank with the meaning of each option to see which one fits best.\n- **'put off'** means to postpone, while **'put down'** means to insult or place something on a surface.\n- **'taken in'** means to be tricked, while **'taken up'** means to start a new hobby.",
        "Audrey chose 'put down' instead of 'put off' for delaying a birthday party.",
        "She picked 'taken up' instead of 'taken in' when describing being tricked by a magician."
        ],
      },
    },
  ],
  // caleb
  "cmq4xj0vm0029apq234jrmrh6": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (7/30 = 23%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"reported-speech":3,"noun-phrase":3,"substitution-inversion":1},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [
        "When you see a reported speech question, use your pencil to circle all the time words (like 'yesterday' or 'later') and describing words in the original quote.\n- **Check off each circled word** as you write your final answer to make sure nothing is left behind.",
        "He correctly changed the sentence structure but forgot to change 'later' to 'later that day'.",
        "He successfully transformed the speech but accidentally left out the word 'new' when describing the museum."
        ],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (3/30 = 10%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"pronouns":3,"connectors-tenses":3,"subject-verb-agreement":3},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [],
      },
    },
  ],
  // clara
  "cmnq8plhv007jetag5gmxvl8v": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (5/5 = 100%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"reported-speech":3,"correlative-preference":2,"noun-phrase":2},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [
        "When you see a new word given in bold, try these steps:\n- **Write down a draft** of the new sentence.\n- Check if you need to change the tense or pronouns.\n- Even if you aren't sure, attempting it gives you a chance at partial marks.",
        "Clara left this blank instead of trying to combine the sentences using 'would rather'.",
        "Clara skipped this reported speech question rather than attempting to shift the tenses."
        ],
      },
    },
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (3/5 = 60%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [
        "If you are stuck on a multiple-choice question, use this strategy:\n- **Cross out the options** you know are definitely wrong.\n- **Make a guess** from the remaining choices.\n- Never leave an MCQ blank!",
        "Clara left this vocabulary question blank instead of guessing the best fit.",
        "Clara skipped this visual text question rather than picking the most likely reason for the exclamation mark."
        ],
      },
    },
  ],
  // david-lim
  "cmm5wf91d000ryrxwaddlo6xh": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (74/188 = 39%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"reported-speech":3,"subordinator":2,"participle-clauses":1},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [
        "When you see prompts like **'asked'** or **'wanted to know'**, treat them as a checklist:\n- **Pronouns** → check who is talking to whom (e.g., change 'I' to 'he' or 'she')\n- **Time words** → shift words like 'yesterday' to **'the previous day'**\n- **Tense** → take one step back in time (e.g., 'is' becomes 'was')",
        "David forgot to change the pronoun to match the speaker, writing 'he' instead of 'she'.",
        "He changed 'last weekend' to 'the previous week' instead of 'the previous weekend'."
        ],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (124/503 = 25%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"tag-questions":4,"connectors-tenses":3,"pronouns":3},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When you see prompts like **'asked'** or **'wanted to know'**, treat them as a checklist:\n- **Pronouns** → check who is talking to whom (e.g., change 'I' to 'he' or 'she')\n- **Time words** → shift words like 'yesterday' to **'the previous day'**\n- **Tense** → take one step back in time (e.g., 'is' becomes 'was')",
        "David forgot to change the pronoun to match the speaker, writing 'he' instead of 'she'.",
        "He changed 'last weekend' to 'the previous week' instead of 'the previous weekend'."
        ],
      },
    },
  ],
  // eg
  "cmqa97aqx00138zk403nx9ud2": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (13/25 = 52%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"reported-speech":2,"subordinator":2,"participle-clauses":2},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [
        "When checking your synthesis and transformation answers, do a quick **'capital check'**. Scan specifically for the word **'I'** and any **names of people or places** to make sure they stand tall!",
        "Forgot to capitalise the 'I' in the middle of the sentence.",
        "Wrote Henry's name with a lowercase 'h'."
        ],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (3/20 = 15%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"pronouns":7,"connectors-tenses":3},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "Try the **'he/him' trick**! If you can replace the word with 'he', use **'who'**. If you can replace it with 'him', use **'whom'**. Also, if there is a preposition right before the blank (like 'to', 'for', or 'with'), always choose **'whom'**.",
        "Chose 'whom' instead of 'who' for the man doing the action of helping.",
        "Chose 'who' instead of 'whom' after the preposition 'to'."
        ],
      },
    },
  ],
  // el44
  "cmpjr2yjx00mweplm8xet2iit": [
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (10/40 = 25%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [
        "When choosing a vocabulary word, look for context clues in the rest of the sentence to narrow down the exact meaning needed. Try plugging your choice into the sentence to see if it sounds like a natural, everyday phrase. If a word describes a physical action (like 'obstructed'), make sure it makes sense with the object (like a 'clue').",
        "He chose 'superficial' (meaning on the surface) instead of 'indispensable' (meaning absolutely necessary) for a crucial scientific step.",
        "He picked 'obstructed' (physically blocked) instead of 'stumped' (confused) when talking about a tricky clue."
        ],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (5/20 = 25%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"pronouns":4,"connectors-tenses":4,"subject-verb-agreement":2},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [],
      },
    },
  ],
  // emily-lim
  "cmmfmmnwy00fdbbbfgm7k3wpn": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (6/15 = 40%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"subordinator":5,"correlative-preference":1},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [
        "When doing Synthesis and Transformation, treat the original sentences like a strict recipe.\n- **Do not change or swap words** unless the grammar rule forces you to.\n- **Tick off the words** from the original sentence as you write them down to ensure you haven't missed any small words like 'the' or 'a'.",
        "She changed the word 'work' to 'homework', which slightly changed the meaning of the original sentence.",
        "She dropped the word 'the' before 'lesson', writing 'start lesson' instead of 'start the lesson'."
        ],
      },
    },
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (2/40 = 5%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [],
      },
    },
  ],
  // faith
  "cmqj81mfb004m6rbdsgw8zobn": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (2/5 = 40%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"subordinator":3,"correlative-preference":3},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (10/190 = 5%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"countable/uncountable":8,"connectors-tenses":3},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [],
      },
    },
  ],
  // ij
  "cmpjshl820001c9kbsdebavk9": [
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (13/95 = 14%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [
        "When choosing a vocabulary word, look closely at the **surrounding clues** and ask 'who or what is doing the action?':\n- **Check the actor:** Is it a person, an object, or a place? (e.g., a person 'reaps', but a garden 'yields').\n- **Check the tone:** Is the situation normal or sudden? (e.g., 'bustle' vs 'flurry').\n- **Try it in a simple sentence:** Substitute the word into a basic sentence to see if it sounds right with the surrounding words.",
        "IJ chose 'bustle' (which means normal busy movement) instead of 'flurry' to describe a sudden, chaotic panic.",
        "IJ picked 'reaps' (which is what a farmer does) instead of 'yields' to describe what the garden itself produces."
        ],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (1/5 = 20%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"connectors-tenses":10},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When filling in blanks with grammar words, look for **hidden pairs and group sizes**:\n- **Two vs Many:** Use **'between'** for exactly two things, and **'among'** or **'amongst'** for three or more.\n- **Contrasting groups:** When a sentence starts by talking about 'some' people, the contrasting group is almost always **'others'**.",
        "IJ used 'between' (which is for two things) instead of 'amongst' (which is for a larger group of students).",
        "IJ used 'some' instead of 'others' to complete the contrasting pair 'some... while others...'."
        ],
      },
    },
  ],
  // j-di-o
  "cmqjq1kmn0005utjdsl4090e8": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (6/40 = 15%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"reported-speech":2,"noun-phrase":2,"substitution-inversion":2},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [],
      },
    },
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (22/168 = 13%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [],
      },
    },
  ],
  // jeremiahsy
  "cmnk7dkkj006z14p6yf06ohzm": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (4/10 = 40%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"noun-phrase":2,"reported-speech":2,"participle-clauses":2},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (3/25 = 12%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When you need to connect two ideas:\n- **Check for commas** → if there's a comma joining two clauses, you often need a relative pronoun like **'which'** or **'who'**, not 'It'.\n- **Look at the relationship** → ask yourself if the second part is an addition, a contrast, or a consequence, and pick the matching word.",
        "He used 'It' instead of 'which' to link a descriptive clause to the main sentence.",
        "He chose 'if' instead of 'or' to show the consequence of not doing something."
        ],
      },
    },
  ],
  // jeron16
  "cmpsi48y5000qji84cyscuzcy": [
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (2/5 = 40%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"verb-forms":5,"connectors-tenses":5},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When you see a blank next to a preposition (like 'in', 'on', or 'to'), treat it as a fixed phrase puzzle:\n- **Read the whole phrase aloud** to see if it sounds like a familiar idiom.\n- **Check the connector meaning**: does it add information (in addition to) or show a contrast (in spite of)?",
        "He wrote 'stand on straight' instead of the correct idiom 'stand on end' for hair sticking up.",
        "He wrote 'In spite to' instead of 'In addition to' when adding a new point about keeping warm."
        ],
      },
    },
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (1/5 = 20%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [],
      },
    },
  ],
  // joylynn
  "cmpw71a1t0021bzg3jvn7c5dy": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (5/5 = 100%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"subordinator":2,"reported-speech":2,"substitution-inversion":2},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [],
      },
    },
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (4/5 = 80%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [
        "When options look similar, look for context clues in the rest of the sentence to guide your choice.\n- If the sentence mentions **'never giving up'**, look for a word that means stubborn or determined.\n- If it talks about **'cutting down too many trees'**, look for a negative word about taking advantage.",
        "Joylynn confused 'explore' with 'exploit' when describing loggers cutting down too many trees.",
        "She chose 'indignant' (angry) instead of 'tenacious' (determined) for an opponent who never gives up."
        ],
      },
    },
  ],
  // kaiyangnggg
  "cmojzr4fu004gd4vnx8wmz6zk": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (49/70 = 70%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"reported-speech":2,"correlative-preference":2,"noun-phrase":1},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [
        "When you see speech marks **\" \"**, remember the three steps for reported speech:\n- **Change the pronouns** so they make sense from the reporter's point of view.\n- **Shift the tense backwards** (e.g., present becomes past, past becomes past perfect).\n- **Change time words** (e.g., 'today' becomes 'that day', 'now' becomes 'then').",
        "Kaiyangnggg kept the word order as a question and used 'my' instead of 'their'.",
        "He used the past tense 'saw' instead of shifting it back to the past perfect 'had seen'."
        ],
      },
    },
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (62/134 = 46%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [],
      },
    },
  ],
  // kayden
  "cmplc7a1l00033gxd3mvd27io": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (4/5 = 80%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"reported-speech":6},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [
        "When you see speech marks changing to reported speech, remember to **shift the tense back one step**.\n- **Simple Past** becomes **Past Perfect** (e.g., 'went' → 'had gone').\n- Always check if time words like 'yesterday' need to change to **'the previous day'**.",
        "Kayden kept the simple past 'went' instead of shifting it to the past perfect 'had gone'.",
        "He used 'were surprised' instead of shifting back to 'had been surprised'."
        ],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (5/15 = 33%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When choosing a verb, always trace it back to its **true subject**.\n- For **'either... or'**, the verb must match the subject **closest to the blank**.\n- Cross out extra descriptive words between the subject and the blank so you can see the pairing clearly.",
        "Kayden chose the singular 'was' for the plural subject 'actions'.",
        "He picked a singular verb for 'group members' when using the 'either... or' rule."
        ],
      },
    },
  ],
  // lohxy2014
  "cmpuqemdt000112ltfrrcmpqg": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (12/25 = 48%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"reported-speech":2,"subordinator":2,"substitution-inversion":2},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [
        "When you see speech marks being removed, remember to take one step back in time. Change present tense to past tense, and past tense to past perfect. Also, don't forget to change time words like **'tomorrow'** to **'the next day'**!",
        "He wrote 'if I saw' instead of 'if I had seen', forgetting to shift the past tense to past perfect.",
        "He wrote 'must submit' instead of 'had to submit', forgetting to change the modal verb."
        ],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (36/88 = 41%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"tag-questions":4,"connectors-tenses":3,"verb-forms":3},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When filling in a blank, always read the words immediately before and after it. Look out for prepositions like **'in'**, **'with'**, or **'for'**, and choose a word that pairs perfectly with them to form a correct phrase.",
        "He wrote 'keen' instead of 'interested', missing that the blank is followed by the preposition 'in'.",
        "He wrote 'to' instead of 'with' for the phrase 'familiar with technology'."
        ],
      },
    },
  ],
  // lohzr-p4
  "cmq09jz9r006iptoefdj5bj90": [
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (23/66 = 35%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [
        "When choosing a vocabulary word, look for **hidden clues** in the sentence that tell you exactly how an action happens.\n- For example, if the sentence mentions a 'leaking tap' and a 'slow stream', look for a gentle word like **'trickling'** rather than 'pouring'.\n- Try plugging your chosen word into the sentence and imagine the action in your head to see if it fits perfectly.",
        "He chose 'swell' instead of 'slosh' to describe the big, noisy splash of water when children jump into a pool.",
        "He picked 'manage' instead of 'handle' when talking about holding a delicate physical object like a vase."
        ],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (13/64 = 20%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When you need to fill in a pronoun, draw a line back to the **exact noun** it is replacing.\n- Ask yourself: Is it a person or an object? Is it **singular** (one) or **plural** (more than one)?\n- If it is a single object like a ball, use **'it'**. If it is a single object far away, use **'that'**.",
        "He used 'his' instead of 'it' to refer to a football flying through the air.",
        "He chose 'Those' instead of 'That' when pointing to a single bird flying high in the sky."
        ],
      },
    },
  ],
  // mahdi12
  "cmpujhw1u000l14eokd2gzxj9": [
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (23/30 = 77%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [
        "When two words seem to mean the same thing, look closely at the words around the blank.\n- **Read the whole sentence** to see if the word needs to fit a specific tone or pair with a specific preposition.\n- **Try plugging in both options** to see which one sounds more natural in that exact context.",
        "Chose 'prevented' instead of 'impeded' when describing how a lack of confidence slows down an ability.",
        "Picked 'intensive' instead of 'overwhelming' to describe a very strong smell."
        ],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (13/30 = 43%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"pronouns":4,"idiomatic-prepositions":4,"tag-questions":3},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "Certain words are best friends and always stick together with specific prepositions.\n- **Learn them as a pair**: When you learn a new word, learn its preposition partner too (e.g., 'similar to', 'confide in').\n- **Read aloud**: Sometimes your ears can catch the right pair if you read the sentence softly to yourself.",
        "Chose 'over' instead of 'on' after the word 'congratulated'.",
        "Picked 'from' instead of 'to' when using the word 'similar'."
        ],
      },
    },
  ],
  // mark-lim
  "cmmbbyvs30004qa9yinn3drl6": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (100/202 = 50%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"reported-speech":3,"noun-phrase":2,"correlative-preference":1},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [
        "When you see speech marks being removed, remember to step back in time!\n- **Change the tense**: present becomes past, and past becomes past perfect (e.g., 'wrote' becomes 'had written').\n- **Update time words**: 'yesterday' becomes 'the previous day', and 'now' becomes 'then'.",
        "He kept the present tense 'like' instead of shifting it back to the past tense 'liked'.",
        "He forgot to change the present tense 'is' to 'was' and left the time word 'today' instead of changing it to 'that day'."
        ],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (96/945 = 10%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"tag-questions":4,"pronouns":4,"verb-forms":2},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When deciding between 'who' and 'whom', try the 'he/him' trick!\n- If you can replace the word with **'he'**, use **'who'** (e.g., 'who is a teacher').\n- If you can replace it with **'him'**, use **'whom'** (e.g., 'to whom you were speaking').",
        "He picked 'who' instead of 'whom' after the preposition 'to'.",
        "He used 'whom' as the subject of the verb 'is' ('whom is an excellent teacher') instead of 'who'."
        ],
      },
    },
  ],
  // meryll
  "cmpuockrk0023105b9sfvsifx": [
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (3/10 = 30%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When you need to fill in a pronoun or verb, trace it back to the **main subject** it belongs to.\n- If the subject is plural (like 'tigers' or 'sisters'), use **plural** words like 'their' or 'clean'.\n- If the subject is singular (like 'park'), use **singular** words like 'its' or 'cleans'.",
        "She used the singular 'its' for the plural 'tigers'.",
        "She used the plural 'their' for the singular 'park'."
        ],
      },
    },
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (2/10 = 20%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [],
      },
    },
  ],
  // natashatsai
  "cmq1nty4o0002umcoodrkjp79": [
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (4/10 = 40%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When you see phrases like **'as well as'** or **'together with'**, treat them as extra information.\n- **Cross out** the extra phrase in your mind.\n- Match your verb to the **very first subject** (e.g., 'Emily... is').",
        "Chose 'is' instead of 'am' for the subject 'I', getting distracted by the phrase 'as well as my cousin'.",
        "Chose the plural 'are' instead of 'is' for 'Emily', because of the extra phrase 'together with her brothers'."
        ],
      },
    },
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (3/10 = 30%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [],
      },
    },
  ],
  // naurahumaira
  "cmptyivvp000314gmr7d5ai51": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (20/25 = 80%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"reported-speech":3,"subordinator":2,"participle-clauses":2},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [
        "When you see speech marks being removed, treat it as a signal to take one step back in time:\n- Change present tense to past tense (e.g., **is** becomes **was**).\n- Change past tense to past perfect (e.g., **did** becomes **had done**).\n- Watch out for time words too, like changing **now** to **then**.",
        "NauraHumaira kept the present tense 'is feeling' instead of shifting it back to the past tense 'was feeling'.",
        "She used the simple past 'did' instead of taking a step back to the past perfect 'had done'."
        ],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (10/15 = 67%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "Before moving on to the next question, do a quick 5-second scan of your written answer. Check that the **very first letter** is a capital, any standalone **'I'** is capitalized, and people's names start with big letters.",
        "NauraHumaira forgot to capitalize the pronoun 'I' and the proper name 'Mrs Lim'.",
        "She missed the capital letters for the name 'Mr Phua'."
        ],
      },
    },
  ],
  // omi
  "cmqjq81ni0017utjdartsk52u": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (7/15 = 47%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"noun-phrase":2,"participle-clauses":2,"subordinator":1},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [
        "When rewriting sentences, take a moment to check your spelling against the original question.\n- **Trace the words** with your finger as you copy them to make sure no letters are missed or swapped.\n- Double-check words with tricky double letters or vowel pairs, like **'submitted'** or **'thirsty'**.",
        "Omi accidentally added an extra 'm' to spell 'submmitted' instead of 'submitted'.",
        "Omi misspelled 'mother' as 'motther' and wrote 'brought' instead of 'bought'."
        ],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (19/260 = 7%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"connectors-tenses":5,"countable/uncountable":3,"subject-verb-agreement":3},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [],
      },
    },
  ],
  // pei
  "cmpupjw830029105bqopzb0t3": [
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (9/30 = 30%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [
        "Treat vocabulary questions like a detective game:\n- Always **underline the clue words** in the sentence before looking at the options.\n- Ask yourself: **'Does my choice make sense with the clues I underlined?'**",
        "Pei chose 'slowly' for a bus stopping, but the clue 'causing everyone to fall forward' points to 'abruptly'.",
        "He chose 'gushing' for a leaking tap, but the clue 'little drops' means it was 'dripping'."
        ],
      },
    },
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (2/5 = 40%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"subordinator":3,"noun-phrase":3},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [],
      },
    },
  ],
  // rizqi
  "cmptyxf6y000j14gm905pad52": [
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (8/10 = 80%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [
        "Treat vocabulary questions like a detective game. Always look for **clue words** in the sentence before making a choice. For example, if a sentence mentions 'leftovers and wastage', that is a big hint that the meal was huge or **lavish**.",
        "He chose 'immature' instead of 'impulsive' for an act done without checking the truth first.",
        "He picked 'humble' for the feast, missing the clues about 'leftovers and wastage' which point to a 'lavish' meal."
        ],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (6/10 = 60%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "Phrasal verbs can be tricky because changing one small word changes the whole meaning. Try to learn them as a complete set. When you see a starting verb like **kick**, **set**, or **look**, pause and read the whole sentence to see which preposition gives the exact meaning you need.",
        "He chose 'kick off' instead of 'kick in' for medication starting to work.",
        "He picked 'set up' rather than 'set in' to describe fatigue taking hold."
        ],
      },
    },
  ],
  // ryan-kho
  "cmptmu3x5009xzgzx9esqs7i8": [
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (21/52 = 40%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (17/49 = 35%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"subject-verb-agreement":4,"pronouns":3,"idiomatic-prepositions":3},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When you see a blank right after a strong verb or adjective, it is usually testing a fixed pairing.\n- Read the whole phrase aloud to see if it sounds right.\n- Memorise common pairings like **'keen on'**, **'confide in'**, and **'congratulate on'** as single chunks of meaning.",
        "Ryan_Kho picked 'keen of' instead of the correct pairing 'keen on'.",
        "He picked 'confided with' instead of the correct phrase 'confided in'."
        ],
      },
    },
  ],
  // saarah1
  "cmplwi5iv0005timm7o6h8ty0": [
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (4/5 = 80%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [
        "When you see vocabulary questions with words that look similar, test each option in the sentence to see which one sounds like natural English.\n- **Look for clue words** in the sentence (like 'emergency' or 'thunderstorm') that hint at the exact meaning needed.\n- **Read the whole sentence aloud** in your head with your chosen word to check if it forms a common phrase.",
        "Saarah1 picked 'vague' instead of 'poor' to describe bad visibility during a thunderstorm.",
        "She wrote 'put attention' instead of the common English phrase 'give attention' or 'pay attention'."
        ],
      },
    },
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (2/5 = 40%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"subordinator":6},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [],
      },
    },
  ],
  // shadow-demon
  "cmpnkrb4c001hn6wks6oisdiu": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (1/5 = 20%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"substitution-inversion":6},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [],
      },
    },
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (1/5 = 20%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [
        "When you see a blank, look for the **hidden clues** in the same sentence or the sentence before it.\n- Highlight connector words like **'also'**, **'therefore'**, or **'so that'**—they tell you if the sentence is adding information, showing a result, or giving a reason.\n- Ask yourself: 'Does my word fit perfectly with the clues around it?'",
        "Shadow wrote 'While' instead of 'Besides', missing the clue word 'also' later in the sentence which shows information is being added.",
        "Shadow wrote 'held' instead of 'placed', missing the logical clue that the guide has to put the model into the blind person's hands so they can feel it."
        ],
      },
    },
  ],
  // shayane
  "cmpuoa41n001d105bxxo78i02": [
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (4/10 = 40%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"subject-verb-agreement":3,"countable/uncountable":3,"idiomatic-prepositions":3},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When learning new verbs or nouns, try to memorize the preposition that goes with them as a pair (e.g., **'congratulate on'**, **'conclusion about'**). For time phrases, remember that **'since'** is used for a starting point in the past.",
        "Shayane chose 'of' instead of 'on' for the phrase 'congratulated on'.",
        "Shayane used 'since' instead of 'about' when describing a conclusion."
        ],
      },
    },
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (2/10 = 20%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [
        "When two words seem similar, look at the clues around the blank. For example, a garden **'yields'** (produces) crops, while a farmer **'reaps'** (harvests) them. Try plugging your choice back into the sentence to see if it sounds natural.",
        "Shayane picked 'defeated' instead of 'stumped' to describe being confused by a clue.",
        "Shayane chose 'reaps' instead of 'yields' for what a garden produces."
        ],
      },
    },
  ],
  // shriv8209j
  "cmpl9m4f40002xwmmj0zm2fkn": [
    {
      label: "Synthesis / Transformation — focused practice",
      rationale: "Top miss area (22/40 = 55%). Drilled where your sub-topic gaps are biggest.",
      topic: "Synthesis / Transformation" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"reported-speech":3,"subordinator":2,"noun-phrase":2},
      count: 6,
      topicRecap: {
        heading: "Synthesis / Transformation — what to look out for",
        watchOut: [
        "When you see reporting words, treat them as a signal to check your time and pointer words:\n- **'yesterday'** changes to **'the previous day'**\n- **'next week'** changes to **'the following week'**\n- **'this'** changes to **'that'**",
        "SHRIV8209J kept 'yesterday' instead of changing it to 'the previous day'.",
        "SHRIV8209J left 'next week' as is, rather than shifting it to 'the following week'."
        ],
      },
    },
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (1/10 = 10%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [],
      },
    },
  ],
  // tylerng
  "cmokaegzx0005wkxzxu2qcn2m": [
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (19/35 = 54%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (25/60 = 42%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When you see phrases like **'together with'**, **'as well as'**, or **'along with'**, try crossing them out lightly with your pencil. This helps you spot the true main subject so you can choose the correct singular or plural verb.",
        "He saw 'brothers' right before the blank and chose the plural 'are', missing that the main subject is the singular 'Emily'.",
        "He chose 'is' by looking at 'my cousin', forgetting that the main subject at the start of the sentence is 'I', which pairs with 'am'."
        ],
      },
    },
  ],
  // umarm
  "cmpuhv13p0001818swyt565lx": [
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (7/10 = 70%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [],
      },
    },
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (4/10 = 40%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When learning new verbs, pay attention to the little words (prepositions) that follow them. Try to memorise them as a complete phrase (e.g., **'break out in a sweat'** or **'look to someone'**).",
        "He picked 'put down' instead of 'put off' for cancelling or postponing a party.",
        "He chose 'looked into' instead of 'looked to' when referring to seeking support from an older brother."
        ],
      },
    },
  ],
  // winterark312
  "cmp6mtgj50003k9u71g0n8pnh": [
    {
      label: "Grammar MCQ — focused practice",
      rationale: "Top miss area (15/80 = 19%). Drilled where your sub-topic gaps are biggest.",
      topic: "Grammar MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {"idiomatic-prepositions":4,"connectors-tenses":4,"countable/uncountable":3},
      count: 10,
      topicRecap: {
        heading: "Grammar MCQ — what to look out for",
        watchOut: [
        "When you see **a verb followed by a preposition**, treat it as a single vocabulary word.\n- **'warmed up'** → always pairs with **'to'** when talking about people.\n- **'fell'** → use **'out'** for arguments, and **'apart'** for things breaking.",
        "Winterark312 chose 'fell apart' instead of 'fell out' to describe friends having a misunderstanding.",
        "He picked 'warmed up with' instead of 'warmed up to' when describing getting comfortable with classmates."
        ],
      },
    },
    {
      label: "Vocabulary MCQ — focused practice",
      rationale: "Top miss area (19/120 = 16%). Drilled where your sub-topic gaps are biggest.",
      topic: "Vocabulary MCQ" as "Grammar MCQ" | "Vocabulary MCQ" | "Synthesis / Transformation",
      subTopicWeights: {},
      count: 10,
      topicRecap: {
        heading: "Vocabulary MCQ — what to look out for",
        watchOut: [],
      },
    },
  ],
};
