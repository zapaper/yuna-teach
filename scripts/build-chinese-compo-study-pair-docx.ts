// Build PSLE-Chinese-Compo-Study-O1.docx — one master Option-1
// composition (《一份特别的友谊》) designed to flex across 9 of the 10
// Option-1 prompts via a closing-swap table.
//
// Layout:
//   §0 English preamble — strategy + heat-map analysis
//   §1 Heat map (Option 1 only, with actual topic titles in cells)
//   §2 Master essay《一份特别的友谊》(~770 CJK)
//   §3 Coverage table — title-fit per year
//   §4 Closing-swap table — 10 swappable endings
//
// Run: npx tsx scripts/build-chinese-compo-study-pair-docx.ts

import { promises as fs } from "fs";
import path from "path";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle,
  ShadingType, PageBreak,
} from "docx";

const SCRIPT_DIR = __dirname;
const V2_MORALS = path.join(SCRIPT_DIR, "compo-v2-morals.json");
const FINAL_DOC = path.join(SCRIPT_DIR, "..", "..", "PSLE-Chinese-Compo-Study-O1-O2.docx");

// ───────────────────────── O2 backbone essay ─────────────────────────
const O2_TITLE = "《那道伤疤》";
const O2_PARAS = [
  "爸爸常说：「**小心驶得万年船**。」然而那时的我，却把这句**金玉良言**当成了耳边风，从未真正放在心上。",
  "那是一个星期天的傍晚，金黄色的夕阳像一个慈祥的老爷爷，温柔地洒在公园的小径上。我刚吃完晚饭，就兴致勃勃地骑上心爱的**脚踏车**，准备去公园见朋友。临出门前，爸爸叫住了我，从架子上取下我的**头盔**：「**戴上头盔，安全第一！**」",
  "我接过头盔，心里却嫌它又重又闷。「不就骑几分钟吗？又不去什么险路，哪有那么巧的事？」我心里嘀咕着，趁爸爸转身去厨房的瞬间，偷偷把头盔塞在了门口的鞋柜后面，便一溜烟地骑出了门。",
  "公园里有一段长长的下坡。看着同学们站在坡下挥手等我，我心里痒痒的——何不来个**风驰电掣**的下坡，让他们对我**刮目相看**呢？我握紧把手，狠狠地一蹬，车子像离弦的箭一般冲了下去。风在耳边「呼呼」作响，速度越来越快。「哇——」同学们的惊呼在耳边响起，我心里得意洋洋，仿佛已经是赛车手了。",
  "就在我陶醉于这种快感时，前轮「砰」地撞上了一块凸起的石头！只听见「咣当」一声巨响，车把瞬间一歪，我整个人被狠狠地甩了出去，重重地摔在了水泥地上。",
  "我的额头**火辣辣**地疼，鲜血像断了线的珠子，「滴答、滴答」地染红了一大片。我想撑起身子，可是双腿像灌了铅一样，根本动弹不得；我想喊救命，喉咙里却仿佛被什么堵住，只挤出一声呜咽。难道我就要这样**一蹶不振**了吗？同学们都吓得脸色发白，有的尖叫，有的哭，有的赶紧拨打 995。",
  "爸爸赶到医院时，看着我缠满纱布的头，眼眶一下子就红了，却没有责骂一句。他握住我的手，声音哽咽地说：「**你终于明白了吧？**」我重重地点了点头，眼泪和后悔一起涌了出来。",
  "那道伤疤如今还留在我的额头上。每当我照镜子时，它都仿佛在轻声告诫我：**安全永远是第一位的，规则不是用来违反的，更不能心存侥幸。** 世上没有后悔药，只有挂在嘴边的「小心」二字。**经一事，长一智**——这次惨痛的教训，将成为我一辈子最珍贵的人生财富。",
];

// O2 5-paragraph backbone structure
const O2_STRUCTURE: Array<{ para: string; beat: string; what: string }> = [
  { para: "1",  beat: "Opening + framing", what: "Adult's safety saying + kid's dismissive mindset" },
  { para: "2",  beat: "Setup + warning",   what: "Scene (time + weather) + activity. Adult names the OBJECT + the SAFETY RULE the kid is about to break." },
  { para: "3",  beat: "Carelessness",      what: "Kid's dismissive thought: '不就 X 吗？哪有那么巧的事？' + ignores/hides safety thing + starts activity." },
  { para: "4",  beat: "Accident climax",   what: "Sensory description with simile + sound effect + body reaction. THIS IS WHERE THE SPECIFIC INCIDENT GOES (crash / collision / fall / loss)." },
  { para: "5",  beat: "Aftermath + moral", what: "Adult arrives. NO SCOLDING — eyes red, quiet 'You finally understand?' + kid's reflection + closing moral about 安全 / 粗心 / 守规则." },
];

// Past PSLE O2 scenarios + how to adapt the backbone
const O2_ADAPTATIONS: Array<{ year: string; scenario: string; object: string; carelessness: string; accident: string; moral: string }> = [
  { year: "2017", scenario: "Hide-and-seek in rain",   object: "储藏室 + 门",     carelessness: "Hid in dangerous storage area", accident: "Door closed, trapped, scared",  moral: "不要在不安全的地方躲藏" },
  { year: "2019", scenario: "E-scooter w/o permission", object: "电动踏板车 + 头盔", carelessness: "Took it without asking",      accident: "Fell off, lost the scooter",     moral: "守规则 + 安全意识" },
  { year: "2022", scenario: "Phone-walking",            object: "手机",            carelessness: "Texting while crossing",      accident: "Collision with someone, phone broke", moral: "不可粗心大意" },
  { year: "2023", scenario: "Stroller rescue",          object: "婴儿车 + 电话",   carelessness: "Caregiver distracted by phone", accident: "Stroller rolls down slope; kid stops it", moral: "照顾家人不能分心" },
  { year: "2025", scenario: "Borrowed book damaged",    object: "借来的书",       carelessness: "Careless handling / showing off", accident: "Book got torn",                  moral: "借的东西更要珍惜" },
  { year: "Future likely", scenario: "Cycling/PMD",     object: "头盔 + 脚踏车 / PMD", carelessness: "Skipped helmet",       accident: "Crashed on slope (as written)",  moral: "安全意识" },
  { year: "Future likely", scenario: "Swimming",        object: "游泳圈 + 深水区", carelessness: "Went past depth marker",    accident: "Nearly drowned",                 moral: "守规则" },
];

// Reusable O2 phrase blocks (by beat)
const O2_PHRASE_BLOCKS: Array<{ beat: string; phrases: string[] }> = [
  { beat: "Openings (Para 1 framing — mix and match)", phrases: [
    "小心驶得万年船",
    "不可粗心大意",
    "先做最坏的打算，再想最好的结果",
    "「[Adult] 常说：『...』然而那时的我，却把这句金玉良言当成了耳边风。」",
  ]},
  { beat: "Adult warning (Para 2)", phrases: [
    "「[OBJECT 操作] 要小心，安全第一！记住了吗？」",
    "「[Don't do X]，不然会出大事！」",
    "「[Wear / take / check] [OBJECT]，安全第一！」",
  ]},
  { beat: "Kid's dismissive thought (Para 3)", phrases: [
    "「不就 [activity] 吗？又不是什么险事，哪有那么巧的事？」",
    "「[Adult] 太大惊小怪了，这点小事我怎么会出错？」",
    "「这点事还要 [Adult] 操心？我自己来就好！」",
  ]},
  { beat: "Accident sounds (Para 4)", phrases: [
    "「砰！」一声闷响",
    "「咣当！」一声巨响",
    "「啊——」一声惨叫",
    "「哗——」一声 [object] 翻倒",
  ]},
  { beat: "Body-reaction descriptions (Para 4)", phrases: [
    "火辣辣地疼",
    "钻心地痛",
    "一阵剧痛袭来",
    "鲜血像断了线的珠子，「滴答、滴答」地滴在地上",
    "双腿像灌了铅一样，根本动弹不得",
    "难道我就要这样一蹶不振了吗？",
    "整个人被狠狠地甩了出去",
  ]},
  { beat: "Witness reactions (Para 4)", phrases: [
    "同学们吓得脸色发白，有的尖叫，有的哭",
    "路人有的报警，有的赶紧叫救护车",
    "[Adult] 听到响声，三步并作两步冲了过来",
  ]},
  { beat: "Adult's quiet sorrow (Para 5)", phrases: [
    "眼眶一下子就红了，却没有责骂一句",
    "声音哽咽地说：「你终于明白了吧？」",
    "[Adult] 紧紧地握住我的手，眼里满是心疼",
  ]},
  { beat: "Closing morals (Para 5)", phrases: [
    "安全永远是第一位的，规则不是用来违反的",
    "世上没有后悔药，只有挂在嘴边的「小心」二字",
    "经一事，长一智——这次惨痛的教训，将成为我一辈子最珍贵的人生财富",
    "[Object 名] 永远在那里，但我学到的 [virtue]，比 [object] 还要珍贵",
  ]},
];

type Moral = {
  nameCn: string; nameEn: string; description: string;
  yearsAppeared: Array<{ year: string; option: 1 | 2; note: string }>;
  frequency: number;
};
type MoralsOutput = { overview: string; overviewEn?: string; morals: Moral[] };

const CJK_FONT = "Microsoft YaHei";
const YEARS = ["2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025"];

// Exact PSLE Option-1 topic titles by year — these are what the heatmap
// cells display when a row's moral matches a year's prompt.
const O1_TITLE_BY_YEAR: Record<string, string> = {
  "2016": "互相合作的重要",
  "2017": "变成一个勇敢的人",
  "2018": "更加了解我的朋友",
  "2019": "我做了正确的决定",
  "2020": "这样做是自私的",
  "2021": "一份我最珍惜的礼物",
  "2022": "耐心的重要",
  "2023": "感谢我的朋友",
  "2024": "答应别人的事必须做到",
  "2025": "让别人为我感到骄傲",
};

function t(text: string, opts?: { bold?: boolean; italics?: boolean; size?: number; color?: string }) {
  return new TextRun({
    text,
    bold: opts?.bold, italics: opts?.italics, size: opts?.size, color: opts?.color,
    font: { name: CJK_FONT, eastAsia: CJK_FONT },
  });
}
function p(text: string, opts?: { heading?: typeof HeadingLevel[keyof typeof HeadingLevel]; before?: number; after?: number; bold?: boolean; italics?: boolean; size?: number; color?: string; align?: typeof AlignmentType[keyof typeof AlignmentType] }) {
  return new Paragraph({
    heading: opts?.heading,
    spacing: { before: opts?.before, after: opts?.after },
    alignment: opts?.align,
    children: [t(text, { bold: opts?.bold, italics: opts?.italics, size: opts?.size, color: opts?.color })],
  });
}
function bullet(text: string, opts?: { size?: number; bold?: boolean; color?: string }) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { before: 30, after: 30 },
    children: [t(text, opts)],
  });
}
function cell(content: string | TextRun[], opts?: { bold?: boolean; size?: number; width?: number; align?: typeof AlignmentType[keyof typeof AlignmentType]; bg?: string; color?: string; italics?: boolean }) {
  const runs = typeof content === "string"
    ? [t(content, { bold: opts?.bold, size: opts?.size ?? 18, color: opts?.color, italics: opts?.italics })]
    : content;
  return new TableCell({
    width: opts?.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
    shading: opts?.bg ? { type: ShadingType.CLEAR, fill: opts.bg, color: "auto" } : undefined,
    children: [new Paragraph({ alignment: opts?.align, children: runs })],
  });
}
function tableBorder() {
  return {
    top: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
    left: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
    right: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "DDDDDD" },
    insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "DDDDDD" },
  };
}
function pageBreak() { return new Paragraph({ children: [new PageBreak()] }); }

// Essay body paragraph — **bold red** for marker-grade phrases / idioms.
function essayParagraph(text: string): Paragraph {
  const runs: TextRun[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*)/);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**")) {
      runs.push(t(part.slice(2, -2), { size: 22, bold: true, color: "B91C1C" }));
    } else {
      runs.push(t(part, { size: 22 }));
    }
  }
  return new Paragraph({
    spacing: { before: 80, after: 80, line: 360 },
    children: runs,
  });
}

// ───────────────────────────────────────────────────────────────
// Composition — bold idioms / key phrases marked with **
// ───────────────────────────────────────────────────────────────
const MASTER_TITLE = "《一份特别的友谊》";
const MASTER_PARAS = [
  "「**患难见真情。**」每当我看到书桌上那张写着「**好朋友**」的小卡片，那段日子的点点滴滴便像一部老电影，在我脑海里慢慢放映。",
  "那是六年级开学不久的事。一天上午，老师把一个瘦小的男生带进了教室。「这是阿强，从马来西亚转学过来。他的华文比较弱，希望大家多多帮助他。」全班同学好奇地看着他，只见他低着头，**怯生生**地坐在角落的位子上。",
  "下课了，同学们三五成群地玩耍，阿强却孤零零地坐在座位上发呆。有几个调皮的男生甚至故意学他的口音，**指指点点**地发出嘲笑声。我看在眼里，心里很不是滋味。**助人为乐**——这四个字是妈妈从小教我的；可是上前去帮他，会不会被同学嘲笑？我心里像有两个小人在打架。",
  "最终，我深吸了一口气，走到阿强面前，递给他一颗糖：「你愿意做我的朋友吗？」阿强**惊讶地**抬起头，眼睛慢慢亮了起来，紧握着那颗糖，小声说：「真的吗？」那一刻，我看到他闪着泪花的眼睛里写满了感激。",
  "从那天起，我每天放学留下来教他华文。一开始，他连最简单的成语都听不懂，我急得满头大汗，差点就想说：「**算了吧！**」可是望着他**孜孜不倦**地一笔一画抄写笔记的背影，我又找回了耐心。我把成语画成图，用故事一个个讲给他听。日子一天天过去，阿强的华文也一天天进步。",
  "那次月考成绩公布时，阿强**飞也似的**冲过来，激动地把成绩单高高地举起：「**85 分！我考到 85 分！**」他眼眶红红的，激动得说不出话来。班主任在全班面前重重地拍了拍我的肩膀：「**你是同学们的好榜样，老师为你感到骄傲！**」同学们也纷纷向我投来赞赏的目光。",
  "放学后，阿强从书包里取出一张精心制作的小卡片，**郑重其事**地递到我手里。卡片上画着我们两人手拉手站在一起，旁边写着：**「谢谢你，我最好的朋友。」**我看着卡片，心里**五味杂陈**——这薄薄的一张纸，装满的却是沉甸甸的友谊。",
  "捧着那张小卡片走在回家的路上，我深深地明白了：**真正的友谊不分国籍，也不分成绩；伸出援手的瞬间，世界就多了一份温暖。**这件事就像一盏明灯，永远照亮着我前进的方向。",
];

// Fit verdict per year (verdict, swap-in closing sentence)
const TITLE_FITS: Array<{ year: string; title: string; fit: "Strong" | "Direct" | "Inverse" | "Mid"; how: string; swapCn: string }> = [
  { year: "2016", title: "互相合作的重要", fit: "Mid",     how: "Emphasise the partnership beat (you + 阿强 tackled the work together).", swapCn: "我和阿强联手攻克难题，让我深深明白了——互相合作的力量，比一个人单打独斗强大得多。" },
  { year: "2017", title: "变成一个勇敢的人", fit: "Strong", how: "The 'fear of being teased → 深吸了一口气' decision moment.",        swapCn: "那一刻，我从一个胆小的男孩，变成了一个敢于挺身而出的人。" },
  { year: "2018", title: "更加了解我的朋友", fit: "Direct", how: "The whole essay is about getting to know 阿强 across cultures.",   swapCn: "这次经历让我真正了解了阿强——他不只是新同学，更是值得信赖的好朋友。" },
  { year: "2019", title: "我做了正确的决定", fit: "Direct", how: "Already explicit: '两个小人在打架' → chose to help.",                swapCn: "走过去和阿强说话的那一刻，是我人生中最正确的决定。" },
  { year: "2020", title: "这样做是自私的",   fit: "Inverse", how: "Closing reframes the story as an anti-selfishness lesson.",         swapCn: "如果当时我选择自私地走开，我就永远不会拥有这位最好的朋友——自私带来的，永远是后悔。" },
  { year: "2021", title: "一份我最珍惜的礼物", fit: "Direct", how: "Open with the card → tell the story as flashback. Card IS the gift.", swapCn: "这张小小的卡片，是我收到过的最珍贵的礼物——因为它装着一份真诚的友谊。" },
  { year: "2022", title: "耐心的重要",       fit: "Direct", how: "Foreground the '差点放弃 → 找回耐心' tutoring beat.",                 swapCn: "这件事让我深深明白了——耐心，是友谊最珍贵的桥梁。" },
  { year: "2023", title: "感谢我的朋友",     fit: "Mid",    how: "Add a follow-up: when I later failed, 阿强 was the one comforting me.", swapCn: "后来，当我数学考砸时，是阿强反过来安慰我、陪我复习——他不只是我帮助的对象，更是值得我一生感谢的朋友。" },
  { year: "2024", title: "答应别人的事必须做到", fit: "Mid", how: "Insert an explicit '我郑重地答应老师' in paragraph 2.",            swapCn: "老师拜托我帮助阿强，我郑重地答应了——这件事让我明白：答应别人的事，再难都要做到。" },
  { year: "2025", title: "让别人为我感到骄傲", fit: "Direct", how: "Already direct — teacher's '老师为你感到骄傲' line is the closing.", swapCn: "老师那句「我为你感到骄傲」，是我一生听过最温暖的赞美。" },
];

async function main() {
  const morals = JSON.parse(await fs.readFile(V2_MORALS, "utf8")) as MoralsOutput;
  const children: (Paragraph | Table)[] = [];

  // ═══════════════════════ COVER ═══════════════════════
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 240, after: 80 },
    children: [t("PSLE Chinese Composition — One-Essay Study Pack", { bold: true, size: 38 })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 60 },
    children: [t("Option 1 Master《一份特别的友谊》with Title-Specific Closing Swaps", { italics: true, size: 22, color: "666666" })],
  }));
  children.push(p(
    "One memorisable Option-1 essay that flexes across 9 of the 10 past PSLE prompts via a closing-line swap.",
    { italics: true, align: AlignmentType.CENTER, color: "666666", size: 20, after: 280 },
  ));

  // ═══════════════════════ §0 ENGLISH PREAMBLE ═══════════════════════
  children.push(p("Strategy — Why one essay is enough",
    { heading: HeadingLevel.HEADING_1, before: 200, after: 120 }));

  children.push(p("The Option 1 / Option 2 split (what we learned)", { bold: true, size: 24, before: 120, after: 80 }));
  children.push(p(
    "Across the last 10 PSLE Chinese Composition papers, Option 1 (topical) prompts and Option 2 (picture) prompts ask for almost completely different story shapes:",
    { size: 22, after: 60 },
  ));
  children.push(bullet("Option 1 has been positive-framed in 9 of 10 years. Only 2020 demanded a 'I was selfish' confession.", { size: 22 }));
  children.push(bullet("Option 2 is dominated by safety / carelessness / breaking-the-rules scenarios — they appeared in 5 of the last 10 years (e-scooter, phone-walking, hide-and-seek, stroller-rescue, sports-day wallet drop).", { size: 22 }));
  children.push(bullet("Picture-essay morals (安全意识, 不可粗心大意, 遵守规则) almost never appear in Option 1. Topical-essay morals (友谊珍贵, 感恩, 答应别人, 助人为乐, 让人骄傲) almost never appear in Option 2.", { size: 22 }));

  children.push(p("The Option 1 coverage problem", { bold: true, size: 24, before: 200, after: 80 }));
  children.push(p(
    "Across 10 years of Option 1, 13 distinct morals show up — and no two of them are the same prompt twice. Memorising 13 essays is impractical. The good news: most prompt titles share underlying story beats. A story with the right shape — a hesitation, a decision, sustained effort, a friend's gratitude, a teacher's praise — can be re-framed in the closing line to hit most prompts.",
    { size: 22, after: 120 },
  ));

  children.push(p("Our solution", { bold: true, size: 24, before: 160, after: 80 }));
  children.push(p(
    "《一份特别的友谊》— a 770-character story about befriending and tutoring a transfer classmate. Its beats are deliberately rich enough that 9 of the 10 past Option-1 prompts can be answered by memorising this base text and swapping in one of the 10 closing sentences in §4.",
    { size: 22, after: 80 },
  ));
  children.push(p(
    "Years that fit directly: 2018, 2019, 2021, 2022, 2025. Years that fit with the swap-in closing: 2016, 2017, 2020 (inverse), 2023, 2024. The only structurally different prompt is 2020 — which is included via an inverse-framed closing.",
    { size: 22, italics: true, color: "555555", after: 160 },
  ));

  children.push(p("Length target", { bold: true, size: 24, before: 160, after: 80 }));
  children.push(p(
    "PSLE 40/40 model essays average ~730 CJK characters. Below 700 CJK, the essay is content-starved and silently caps around 32-34. This master essay sits at ~770 CJK so the student is comfortably inside the top-scoring band.",
    { size: 22, after: 160 },
  ));

  children.push(p("How to use this document", { bold: true, size: 24, before: 160, after: 80 }));
  children.push(bullet("Memorise the master essay (§2) verbatim, including the 12 bolded idioms.", { size: 22 }));
  children.push(bullet("Memorise the 10-line closing swap table (§4) — only the final paragraph changes per prompt.", { size: 22 }));
  children.push(bullet("In the exam, identify the prompt's title family, write the master essay, then drop in the matching swap closing.", { size: 22 }));
  children.push(bullet("For 2023, 2024 prompts, also slot in the small mid-paragraph insertion noted in §4's 'how' column.", { size: 22 }));

  // ═══════════════════════ §1 HEAT MAP (O1 only, with titles) ═══════════════════════
  children.push(pageBreak());
  children.push(p("§1 主题热力图 (Option 1 only, 2016–2025)",
    { heading: HeadingLevel.HEADING_1, before: 120, after: 100 }));
  children.push(p(
    "Each row is a moral. Each column is one PSLE year's actual Option 1 title. Green cells show the year(s) whose Option 1 prompt would test that moral. The bottom row shows the count of morals this prompt would test.",
    { italics: true, color: "666666", size: 18, after: 160 },
  ));

  // Filter to morals that have at least one Option-1 appearance.
  const o1Morals = morals.morals
    .map(m => ({
      ...m,
      o1Years: m.yearsAppeared.filter(ya => ya.option === 1).map(ya => ya.year),
    }))
    .filter(m => m.o1Years.length > 0)
    .sort((a, b) => b.o1Years.length - a.o1Years.length);

  const heatHeader = new TableRow({
    tableHeader: true,
    children: [
      cell("Moral", { bold: true, bg: "EEEEEE", width: 18 }),
      ...YEARS.map(y => cell(`${y}\n${O1_TITLE_BY_YEAR[y]}`, { bold: true, bg: "EEEEEE", align: AlignmentType.CENTER, width: 8, size: 14 })),
      cell("Total", { bold: true, bg: "EEEEEE", align: AlignmentType.CENTER, width: 4 }),
    ],
  });
  const heatRows = o1Morals.map(m => new TableRow({
    children: [
      cell(`${m.nameCn} ${m.nameEn}`, { bold: true, size: 18 }),
      ...YEARS.map(y => {
        const hit = m.o1Years.includes(y);
        if (!hit) return cell("", { align: AlignmentType.CENTER });
        // Cell shows just a check + the title — title was already in header for that year.
        return cell("✓", { align: AlignmentType.CENTER, bg: "D1FAE5", color: "047857", bold: true, size: 20 });
      }),
      cell(String(m.o1Years.length), { bold: true, align: AlignmentType.CENTER, color: "047857" }),
    ],
  }));
  // Footer row: morals tested per year
  const moralsPerYear = YEARS.map(y => o1Morals.filter(m => m.o1Years.includes(y)).length);
  const heatFooter = new TableRow({
    children: [
      cell("Morals tested", { bold: true, bg: "FAFAFA" }),
      ...moralsPerYear.map(c => cell(String(c), { bold: true, bg: "FAFAFA", align: AlignmentType.CENTER, color: c >= 2 ? "047857" : "555555" })),
      cell("", { bg: "FAFAFA" }),
    ],
  });
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: tableBorder(),
    rows: [heatHeader, ...heatRows, heatFooter],
  }));

  // ═══════════════════════ §2 MASTER ESSAY ═══════════════════════
  children.push(pageBreak());
  children.push(p("§2 Master Composition《一份特别的友谊》",
    { heading: HeadingLevel.HEADING_1, before: 120, after: 80 }));
  children.push(p(
    "~770 CJK • 12 idioms / 好句 • bolded red phrases are the marker-grade idioms and dialogue beats to memorise.",
    { italics: true, color: "666666", size: 18, after: 200 },
  ));
  children.push(p(MASTER_TITLE,
    { bold: true, size: 32, align: AlignmentType.CENTER, after: 200 }));
  for (const para of MASTER_PARAS) children.push(essayParagraph(para));

  // ═══════════════════════ §3 COVERAGE TABLE ═══════════════════════
  children.push(pageBreak());
  children.push(p("§3 Title-Fit Coverage", { heading: HeadingLevel.HEADING_1, before: 120, after: 100 }));
  children.push(p(
    "Verdict per year: Direct = essay already fits; Strong = small emphasis change; Mid = needs a small insertion; Inverse = essay used as the 'what NOT to do' counterexample.",
    { italics: true, color: "666666", size: 18, after: 160 },
  ));
  const covHeader = new TableRow({
    tableHeader: true,
    children: [
      cell("Year", { bold: true, bg: "EEEEEE", width: 8 }),
      cell("Prompt title", { bold: true, bg: "EEEEEE", width: 30 }),
      cell("Fit", { bold: true, bg: "EEEEEE", width: 10, align: AlignmentType.CENTER }),
      cell("How to fit", { bold: true, bg: "EEEEEE", width: 52 }),
    ],
  });
  const covRows = TITLE_FITS.map(f => {
    const fitColor =
      f.fit === "Direct" ? "047857" :
      f.fit === "Strong" ? "0369A1" :
      f.fit === "Inverse" ? "B45309" :
      "991B1B";
    const fitBg =
      f.fit === "Direct" ? "D1FAE5" :
      f.fit === "Strong" ? "DBEAFE" :
      f.fit === "Inverse" ? "FEF3C7" :
      "FEE2E2";
    return new TableRow({
      children: [
        cell(f.year, { bold: true, align: AlignmentType.CENTER, size: 20 }),
        cell(f.title, { size: 20 }),
        cell(f.fit, { bold: true, align: AlignmentType.CENTER, color: fitColor, bg: fitBg, size: 18 }),
        cell(f.how, { size: 18, italics: true, color: "555555" }),
      ],
    });
  });
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: tableBorder(),
    rows: [covHeader, ...covRows],
  }));

  // ═══════════════════════ §4 SWAP TABLE ═══════════════════════
  children.push(pageBreak());
  children.push(p("§4 Closing-Line Swap Table (memorise all 10)",
    { heading: HeadingLevel.HEADING_1, before: 120, after: 100 }));
  children.push(p(
    "Drop the matching line into the second-to-last paragraph (replace the existing closing sentence). The rest of the essay stays the same.",
    { italics: true, color: "666666", size: 18, after: 160 },
  ));
  const swapHeader = new TableRow({
    tableHeader: true,
    children: [
      cell("Year", { bold: true, bg: "EEEEEE", width: 7 }),
      cell("If prompt is...", { bold: true, bg: "EEEEEE", width: 28 }),
      cell("Drop in this closing sentence", { bold: true, bg: "EEEEEE", width: 65 }),
    ],
  });
  const swapRows = TITLE_FITS.map(f => new TableRow({
    children: [
      cell(f.year, { bold: true, align: AlignmentType.CENTER, size: 20 }),
      cell(f.title, { size: 20 }),
      cell(f.swapCn, { size: 20, color: "B91C1C" }),
    ],
  }));
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: tableBorder(),
    rows: [swapHeader, ...swapRows],
  }));

  // ═══════════════════════ §5 O2 PREAMBLE ═══════════════════════
  children.push(pageBreak());
  children.push(p("§5 Option 2 — Strategy: Structure, not Scenario",
    { heading: HeadingLevel.HEADING_1, before: 120, after: 120 }));

  children.push(p("The Option 2 picture pattern", { bold: true, size: 24, before: 120, after: 80 }));
  children.push(p(
    "Picture-based prompts always name the technical OBJECT in the helping-word list (e-scooter, phone, stroller, borrowed book, wallet, etc.). The kid can't avoid using it — the prompt forces it. That means memorising one specific past scenario is risky: PSLE rarely repeats the same picture twice in 10 years.",
    { size: 22, after: 120 },
  ));
  children.push(p(
    "5 of the last 10 Option 2 prompts were safety / carelessness scenarios (50%): hide-and-seek door (2017), e-scooter (2019), phone-walking (2022), stroller-rescue (2023), borrowed-book damage (2025). Future safety prompts will introduce new objects (helmet, swimming, kitchen, fireworks…) but the underlying story shape stays identical.",
    { size: 22, after: 120 },
  ));

  children.push(p("What's REUSABLE year-on-year", { bold: true, size: 24, before: 160, after: 80 }));
  children.push(p(
    "The 5-paragraph 'carelessness arc' below. The kid masters the structure plus a phrase kit; in the exam, they swap the OBJECT (Para 2) + the SPECIFIC INCIDENT (Para 4) for whatever the picture demands.",
    { size: 22, after: 120 },
  ));
  children.push(p(
    "(The other 5 Option-2 years — wallet-drop, helping the elderly, sharing/stealing, performance accident, monkey-grabs-bag — usually have a POSITIVE angle. The Option 1 master essay §2 can be repurposed for those by reframing the closing.)",
    { size: 20, italics: true, color: "555555", after: 200 },
  ));

  // ═══════════════════════ §6 O2 5-PARAGRAPH BACKBONE ═══════════════════════
  children.push(p("§6 O2 5-Paragraph Backbone Structure",
    { heading: HeadingLevel.HEADING_1, before: 240, after: 120 }));
  children.push(p(
    "This skeleton fits ALL 5 past safety scenarios. Memorise the BEAT for each paragraph; the wording can flex with the helping words.",
    { italics: true, color: "666666", size: 18, after: 160 },
  ));
  const structHeader = new TableRow({
    tableHeader: true,
    children: [
      cell("Para", { bold: true, bg: "EEEEEE", width: 6, align: AlignmentType.CENTER }),
      cell("Beat", { bold: true, bg: "EEEEEE", width: 26 }),
      cell("What to write", { bold: true, bg: "EEEEEE", width: 68 }),
    ],
  });
  const structRows = O2_STRUCTURE.map(s => new TableRow({
    children: [
      cell(s.para, { bold: true, align: AlignmentType.CENTER, size: 22 }),
      cell(s.beat, { bold: true, size: 20, color: "B91C1C" }),
      cell(s.what, { size: 20 }),
    ],
  }));
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: tableBorder(),
    rows: [structHeader, ...structRows],
  }));

  // ═══════════════════════ §7 O2 BACKBONE ESSAY ═══════════════════════
  children.push(pageBreak());
  children.push(p("§7 O2 Backbone Essay《那道伤疤》(cycling scenario, ~810 CJK)",
    { heading: HeadingLevel.HEADING_1, before: 120, after: 80 }));
  children.push(p(
    "Worked example of the §6 structure. Cycling-helmet incident here, but the same arc handles any of the picture scenarios in §8 — just swap the OBJECT (Para 2) and INCIDENT (Para 4).",
    { italics: true, color: "666666", size: 18, after: 200 },
  ));
  children.push(p(O2_TITLE, { bold: true, size: 32, align: AlignmentType.CENTER, after: 200 }));
  for (const para of O2_PARAS) children.push(essayParagraph(para));

  // ═══════════════════════ §8 O2 SCENARIO ADAPTATION KIT ═══════════════════════
  children.push(pageBreak());
  children.push(p("§8 O2 Scenario Adaptation Kit",
    { heading: HeadingLevel.HEADING_1, before: 120, after: 100 }));
  children.push(p(
    "For ANY safety picture prompt: swap the OBJECT and the INCIDENT TYPE. The rest of the §6 structure + §9 phrase blocks stays identical.",
    { italics: true, color: "666666", size: 18, after: 160 },
  ));
  const adaptHeader = new TableRow({
    tableHeader: true,
    children: [
      cell("Year", { bold: true, bg: "EEEEEE", width: 10, align: AlignmentType.CENTER }),
      cell("Scenario", { bold: true, bg: "EEEEEE", width: 18 }),
      cell("Object (Para 2)", { bold: true, bg: "EEEEEE", width: 14 }),
      cell("Carelessness (Para 3)", { bold: true, bg: "EEEEEE", width: 22 }),
      cell("Incident type (Para 4)", { bold: true, bg: "EEEEEE", width: 22 }),
      cell("Closing moral", { bold: true, bg: "EEEEEE", width: 14 }),
    ],
  });
  const adaptRows = O2_ADAPTATIONS.map(a => new TableRow({
    children: [
      cell(a.year, { bold: true, align: AlignmentType.CENTER, size: 18, color: a.year.startsWith("Future") ? "0369A1" : undefined }),
      cell(a.scenario, { bold: true, size: 18 }),
      cell(a.object, { size: 18, color: "B91C1C" }),
      cell(a.carelessness, { size: 18 }),
      cell(a.accident, { size: 18 }),
      cell(a.moral, { size: 18, italics: true, color: "555555" }),
    ],
  }));
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: tableBorder(),
    rows: [adaptHeader, ...adaptRows],
  }));

  // ═══════════════════════ §9 O2 PHRASE BLOCKS ═══════════════════════
  children.push(pageBreak());
  children.push(p("§9 O2 Reusable Phrase Blocks",
    { heading: HeadingLevel.HEADING_1, before: 120, after: 100 }));
  children.push(p(
    "Memorise these by beat. In the exam, pick the matching set and drop into the §6 structure. The bracketed [OBJECT] / [Adult] / [virtue] are swap-points — fill with the helping-word noun or appropriate role.",
    { italics: true, color: "666666", size: 18, after: 160 },
  ));
  for (const block of O2_PHRASE_BLOCKS) {
    children.push(p(block.beat, { heading: HeadingLevel.HEADING_2, before: 180, after: 80, color: "B91C1C" }));
    for (const phrase of block.phrases) children.push(bullet(phrase, { size: 22 }));
  }

  // ═══════════════════════ Build ═══════════════════════
  const doc = new Document({
    creator: "MarkForYou",
    title: "PSLE Chinese Composition Study — Option 1 One-Essay Pack",
    styles: {
      default: {
        document: { run: { font: { name: CJK_FONT, eastAsia: CJK_FONT }, size: 22 } },
      },
    },
    sections: [{
      properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
      children,
    }],
  });
  const buf = await Packer.toBuffer(doc);
  await fs.writeFile(FINAL_DOC, buf);
  console.log(`Wrote ${FINAL_DOC}`);
}

main().catch(e => { console.error(e); process.exit(1); });
