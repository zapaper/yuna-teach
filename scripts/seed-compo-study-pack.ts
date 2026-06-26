// Seed two CompoAttempt rows for the PSLE Chinese O1 + O2 study-pack
// model essays, then trigger analyseCompoAttempt on each so the kid /
// admin can view them in /admin/compo with full wrong-words + critique
// + recommendations + phrase-swap UI.
//
// Both essays are seeded as TEXT-ONLY rows (no image upload) — the
// analyseCompoAttempt orchestrator was extended to detect this and
// skip the OCR stage, going straight to wrong-words + critique +
// recommend + elevate.
//
// Idempotent: if a row with the same label already exists, the script
// updates the ocrText / metadata and re-triggers analyse instead of
// creating a duplicate.
//
// Run: npx tsx scripts/seed-compo-study-pack.ts

import { prisma } from "../src/lib/db";
import { analyseCompoAttempt } from "../src/lib/compo-analysis";

const ESSAYS: Array<{
  label: string;
  optionType: "option1" | "option2";
  studentTopic: string;
  ocrText: string;
  note: string;
}> = [
  {
    label: "📘 Master《一份特别的友谊》(O1 study-pack)",
    optionType: "option1",
    studentTopic: "更加了解我的朋友 / 助人为乐 / 友谊珍贵",
    note: "Master Option-1 essay. Designed to flex across 9 of 10 past PSLE prompts via closing-line swap.",
    ocrText: [
      "「患难见真情。」每当我看到书桌上那张写着「好朋友」的小卡片，那段日子的点点滴滴便像一部老电影，在我脑海里慢慢放映。",
      "那是六年级开学不久的事。一天上午，老师把一个瘦小的男生带进了教室。「这是阿强，从马来西亚转学过来。他的华文比较弱，希望大家多多帮助他。」全班同学好奇地看着他，只见他低着头，怯生生地坐在角落的位子上。",
      "下课了，同学们三五成群地玩耍，阿强却孤零零地坐在座位上发呆。有几个调皮的男生甚至故意学他的口音，指指点点地发出嘲笑声。我看在眼里，心里很不是滋味。助人为乐——这四个字是妈妈从小教我的；可是上前去帮他，会不会被同学嘲笑？我心里像有两个小人在打架。",
      "最终，我深吸了一口气，走到阿强面前，递给他一颗糖：「你愿意做我的朋友吗？」阿强惊讶地抬起头，眼睛慢慢亮了起来，紧握着那颗糖，小声说：「真的吗？」那一刻，我看到他闪着泪花的眼睛里写满了感激。",
      "从那天起，我每天放学留下来教他华文。一开始，他连最简单的成语都听不懂，我急得满头大汗，差点就想说：「算了吧！」可是望着他孜孜不倦地一笔一画抄写笔记的背影，我又找回了耐心。我把成语画成图，用故事一个个讲给他听。日子一天天过去，阿强的华文也一天天进步。",
      "那次月考成绩公布时，阿强飞也似的冲过来，激动地把成绩单高高地举起：「85 分！我考到 85 分！」他眼眶红红的，激动得说不出话来。班主任在全班面前重重地拍了拍我的肩膀：「你是同学们的好榜样，老师为你感到骄傲！」同学们也纷纷向我投来赞赏的目光。",
      "放学后，阿强从书包里取出一张精心制作的小卡片，郑重其事地递到我手里。卡片上画着我们两人手拉手站在一起，旁边写着：「谢谢你，我最好的朋友。」我看着卡片，心里五味杂陈——这薄薄的一张纸，装满的却是沉甸甸的友谊。",
      "捧着那张小卡片走在回家的路上，我深深地明白了：真正的友谊不分国籍，也不分成绩；伸出援手的瞬间，世界就多了一份温暖。这件事就像一盏明灯，永远照亮着我前进的方向。",
    ].join("\n\n"),
  },
  {
    label: "💧 Backbone《那道伤疤》(O2 safety study-pack)",
    optionType: "option2",
    studentTopic: "安全意识 / 不可粗心大意 / 守规则",
    note: "Backbone O2 safety/carelessness essay. Cycling scenario used here; structure flexes to any safety picture (e-scooter, phone-walking, stroller, hide-and-seek door, borrowed-item damage).",
    ocrText: [
      "爸爸常说：「小心驶得万年船。」然而那时的我，却把这句金玉良言当成了耳边风，从未真正放在心上。",
      "那是一个星期天的傍晚，金黄色的夕阳像一个慈祥的老爷爷，温柔地洒在公园的小径上。我刚吃完晚饭，就兴致勃勃地骑上心爱的脚踏车，准备去公园见朋友。临出门前，爸爸叫住了我，从架子上取下我的头盔：「戴上头盔，安全第一！」",
      "我接过头盔，心里却嫌它又重又闷。「不就骑几分钟吗？又不去什么险路，哪有那么巧的事？」我心里嘀咕着，趁爸爸转身去厨房的瞬间，偷偷把头盔塞在了门口的鞋柜后面，便一溜烟地骑出了门。",
      "公园里有一段长长的下坡。看着同学们站在坡下挥手等我，我心里痒痒的——何不来个风驰电掣的下坡，让他们对我刮目相看呢？我握紧把手，狠狠地一蹬，车子像离弦的箭一般冲了下去。风在耳边「呼呼」作响，速度越来越快。「哇——」同学们的惊呼在耳边响起，我心里得意洋洋，仿佛已经是赛车手了。",
      "就在我陶醉于这种快感时，前轮「砰」地撞上了一块凸起的石头！只听见「咣当」一声巨响，车把瞬间一歪，我整个人被狠狠地甩了出去，重重地摔在了水泥地上。",
      "我的额头火辣辣地疼，鲜血像断了线的珠子，「滴答、滴答」地染红了一大片。我想撑起身子，可是双腿像灌了铅一样，根本动弹不得；我想喊救命，喉咙里却仿佛被什么堵住，只挤出一声呜咽。难道我就要这样一蹶不振了吗？同学们都吓得脸色发白，有的尖叫，有的哭，有的赶紧拨打 995。",
      "爸爸赶到医院时，看着我缠满纱布的头，眼眶一下子就红了，却没有责骂一句。他握住我的手，声音哽咽地说：「你终于明白了吧？」我重重地点了点头，眼泪和后悔一起涌了出来。",
      "那道伤疤如今还留在我的额头上。每当我照镜子时，它都仿佛在轻声告诫我：安全永远是第一位的，规则不是用来违反的，更不能心存侥幸。世上没有后悔药，只有挂在嘴边的「小心」二字。经一事，长一智——这次惨痛的教训，将成为我一辈子最珍贵的人生财富。",
    ].join("\n\n"),
  },
];

(async () => {
  console.log(`\nSeeding ${ESSAYS.length} compo study-pack entries...\n`);
  for (const e of ESSAYS) {
    // Find-or-create by label (idempotent).
    const existing = await prisma.compoAttempt.findFirst({ where: { label: e.label } });
    let row;
    if (existing) {
      console.log(`UPDATE  ${existing.id}  ${e.label}`);
      row = await prisma.compoAttempt.update({
        where: { id: existing.id },
        data: {
          optionType: e.optionType,
          studentTopic: e.studentTopic,
          ocrText: e.ocrText,
          // Wipe prior analysis so the re-run is fresh.
          wrongWords: undefined,
          critique: undefined,
          recommendations: undefined,
          status: "uploaded",
          errorMessage: null,
          analysedAt: null,
        },
      });
    } else {
      console.log(`CREATE  ${e.label}`);
      row = await prisma.compoAttempt.create({
        data: {
          label: e.label,
          optionType: e.optionType,
          studentTopic: e.studentTopic,
          ocrText: e.ocrText,
          // No image paths — the orchestrator's text-seeded branch handles
          // this and skips OCR.
          compositionImagePaths: [],
          status: "uploaded",
        },
      });
      console.log(`        id=${row.id}`);
    }

    console.log(`        triggering analyseCompoAttempt...`);
    try {
      await analyseCompoAttempt(row.id);
      const after = await prisma.compoAttempt.findUnique({
        where: { id: row.id },
        select: { status: true, critique: true, recommendations: true },
      });
      const overall = (after?.critique as { overallScore?: number } | null)?.overallScore;
      const swaps = (after?.recommendations as { elevatedDraftSwaps?: unknown[] } | null)?.elevatedDraftSwaps?.length;
      console.log(`        ✓ status=${after?.status}  critique=${overall ?? "?"}/40  swaps=${swaps ?? 0}`);
      console.log(`        URL: https://www.markforyou.com/admin/compo/${row.id}\n`);
    } catch (err) {
      console.error(`        ✗ analyse failed: ${(err as Error).message}\n`);
    }
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
