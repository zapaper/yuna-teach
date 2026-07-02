// Chinese Oral Coach — theme catalogue.
//
// Mirrors the English 20-item catalogue (10 years × 2 days). Each
// Chinese theme uses the same picture as its English counterpart
// (same imageR2Path); the SBC prompts are Chinese translations of
// the English 描述 / 意见 / 经历 questions.
//
// Marks split (PSLE 华文 Paper 3 Oral, 2026):
//   朗读 (Reading Aloud): 10 marks
//   会话 (SBC):           30 marks
//   Total:                40
//
// Same scoring "buckets" as the English module — pronunciation /
// fluency / expressiveness for 朗读 (scored 0-100% each, average
// mapped to /10); Q1/Q2/Q3 for 会话 (scored 0-100% each, average
// mapped to /30).
//
// Passages: placeholders for now (marked with TODO); real PSLE
// Chinese 朗读 passages will be swapped in from the yanzimandarin
// sample-topics corpus (see the passages-research agent output).

export type OralThemeZh = {
  id: string;              // "YYYY_D" — same shape as the English catalogue
  year: string;
  day: 1 | 2;
  theme: string;           // 3-6 char Chinese label shown in the picker
  blurb: string;           // one-sentence Chinese description of the scene
  category: string;        // used for the badge chip
  /** R2 object path for the stimulus picture. Shared with the English module. */
  imageR2Path: string;
  /** Reading Aloud passage — Simplified Chinese, ~100-140 characters. */
  passage: string;
  /** Whether the passage is a real PSLE / sample passage vs a placeholder. */
  passageAuthentic: boolean;
  prompts: {
    describe: string;    // Q1 描述 — comment on the picture
    opinion: string;     // Q2 表达意见 — opinion / agreement
    experience: string;  // Q3 分享经历 — personal experience
  };
  isAuthentic: boolean;    // whether the *English* source was an authentic PSLE paper
};

export const ORAL_THEMES_ZH: OralThemeZh[] = [
  {
    id: "2025_1", year: "2025", day: 1, theme: "排队与秩序", category: "社会",
    blurb: "冰淇淋车前排着长长的队伍 —— 谈守秩序与新加坡人的排队文化。",
    imageR2Path: "oral-coach/pictures/2025_oral_day1_stimulus.jpg",
    passage:
      "TODO: authentic PSLE passage on queuing / orderliness — sample from yanzimandarin corpus.",
    passageAuthentic: false,
    prompts: {
      describe: "这是不是一个适合卖冰淇淋的好地方?为什么?",
      opinion: "你愿不愿意为了买东西排很长的队?为什么?",
      experience: "你觉得新加坡人有秩序吗?请说明原因。",
    },
    isAuthentic: true,
  },
  {
    id: "2025_2", year: "2025", day: 2, theme: "小贩中心", category: "文化",
    blurb: "小贩中心里人们吃饭买食物 —— 谈本地饮食文化。",
    imageR2Path: "oral-coach/pictures/2025_oral_day2_stimulus.jpg",
    passage:
      "TODO: authentic PSLE passage on hawker culture.",
    passageAuthentic: false,
    prompts: {
      describe: "你觉得图片里的人为什么选择在小贩中心吃饭?",
      opinion: "你比较喜欢家里煮的饭菜,还是买外面的食物?为什么?",
      experience: "你觉得小孩子应不应该学做饭?为什么?",
    },
    isAuthentic: true,
  },
  {
    id: "2024_1", year: "2024", day: 1, theme: "户外活动", category: "健康",
    blurb: "一家人在新加坡公园里骑脚踏车 —— 谈户外活动与公德心。",
    imageR2Path: "oral-coach/pictures/2024_oral_day1_stimulus.jpg",
    passage: "TODO: passage on enjoying the outdoors.",
    passageAuthentic: false,
    prompts: {
      describe: "你觉得这个公园适合家人一起度过周末吗?为什么?",
      opinion: "你喜不喜欢在户外度过自由时间?为什么?",
      experience: "你觉得新加坡人在公共空间使用公园的时候够不够体谅别人?为什么?",
    },
    isAuthentic: false,
  },
  {
    id: "2024_2", year: "2024", day: 2, theme: "感谢劳动者", category: "社区",
    blurb: "学生向学校清洁员表达感谢 —— 谈欣赏与尊重。",
    imageR2Path: "oral-coach/pictures/2024_oral_day2_stimulus.jpg",
    passage: "TODO: passage on appreciating community helpers.",
    passageAuthentic: false,
    prompts: {
      describe: "你觉得学生为什么要送贺卡给清洁员?",
      opinion: "你愿不愿意花时间去帮助社区里的老人?为什么?",
      experience: "你觉得感谢我们社区里做日常工作的人重要吗?为什么?",
    },
    isAuthentic: false,
  },
  {
    id: "2023_1", year: "2023", day: 1, theme: "参观展览", category: "学习",
    blurb: "小学生兴奋地看着展览中的互动机器人 —— 谈学习与探索。",
    imageR2Path: "oral-coach/pictures/2023_oral_day1_stimulus.jpg",
    passage: "TODO: passage on visiting exhibitions.",
    passageAuthentic: false,
    prompts: {
      describe: "你有没有兴趣参观图片里的这个展览?为什么?",
      opinion: "请你介绍新加坡的一个你去过或想去的名胜景点。",
      experience: "你觉得学校假期够不够长?为什么?",
    },
    isAuthentic: false,
  },
  {
    id: "2023_2", year: "2023", day: 2, theme: "珍贵的回忆", category: "价值观",
    blurb: "祖父与孙女翻看旧照片 —— 谈回忆与珍藏。",
    imageR2Path: "oral-coach/pictures/2023_oral_day2_stimulus.jpg",
    passage: "TODO: passage on memories and keepsakes.",
    passageAuthentic: false,
    prompts: {
      describe: "你觉得爷爷和小女孩为什么喜欢一起看相册?",
      opinion: "请你说说一件你很珍惜的物品,以及你珍惜它的原因。",
      experience: "你喜不喜欢用照片记录你的生活?为什么?",
    },
    isAuthentic: false,
  },
  {
    id: "2022_1", year: "2022", day: 1, theme: "环保回收", category: "环保",
    blurb: "组屋底层放着回收桶 —— 谈爱护环境与做好本分。",
    imageR2Path: "oral-coach/pictures/2022_oral_day1_stimulus.jpg",
    passage: "TODO: passage on recycling and environment.",
    passageAuthentic: false,
    prompts: {
      describe: "你觉得这个组屋底层适合放回收桶吗?为什么?",
      opinion: "你比较喜欢把旧东西直接丢掉,还是回收?为什么?",
      experience: "你觉得保护环境重不重要?为什么?",
    },
    isAuthentic: false,
  },
  {
    id: "2022_2", year: "2022", day: 2, theme: "使用电子产品", category: "健康",
    blurb: "小孩玩平板电脑忽略了课本 —— 谈自律与平衡。",
    imageR2Path: "oral-coach/pictures/2022_oral_day2_stimulus.jpg",
    // Authentic PSLE-adjacent passage (pslenotes.sg 第12篇, ~168 chars).
    passage:
      "网络已经成了生活的一部分。可是,许多孩子长时间使用手机,过于依赖电子产品。他们不仅视力受影响,有时还会接触到不良内容,甚至在玩游戏时遇到网络欺凌。为了解决这个问题,社会服务机构推出了特别的亲子工具盒。这能帮助家长和孩子控制使用手机的时间,并教导大家如何安全上网。只要培养良好的数码习惯,就能安全地在网络世界里学习。",
    passageAuthentic: true,
    prompts: {
      describe: "你觉得图片里的孩子应不应该在这个时候玩平板?为什么?",
      opinion: "你觉得功课时间到了却还想玩电子产品,是不是很难克制?为什么?",
      experience: "你觉得小学生有没有必要有一份每日的时间表?为什么?",
    },
    isAuthentic: false,
  },
  {
    id: "2021_1", year: "2021", day: 1, theme: "作息与睡眠", category: "健康",
    blurb: "疲惫的学生走在上学路上 —— 谈休息与作息规律。",
    imageR2Path: "oral-coach/pictures/2021_oral_day1_stimulus.jpg",
    passage: "TODO: passage on sleep and rest.",
    passageAuthentic: false,
    prompts: {
      describe: "你觉得图片里的学生睡得够不够?为什么?",
      opinion: "你觉得早上起床上学困不困难?为什么?",
      experience: "你觉得新加坡人是不是普遍休息得够?为什么?",
    },
    isAuthentic: false,
  },
  {
    id: "2021_2", year: "2021", day: 2, theme: "爱护宠物", category: "价值观",
    blurb: "小男孩在公园里照顾他的小狗 —— 谈责任与关爱。",
    imageR2Path: "oral-coach/pictures/2021_oral_day2_stimulus.jpg",
    passage: "TODO: passage on caring for pets.",
    passageAuthentic: false,
    prompts: {
      describe: "你觉得图片里的小男孩是不是一个负责任的宠物主人?为什么?",
      opinion: "你有没有宠物,或者你想不想要一只宠物?为什么?",
      experience: "你觉得养宠物能不能培养孩子好的品德?为什么?",
    },
    isAuthentic: false,
  },
  {
    id: "2020_1", year: "2020", day: 1, theme: "邻里情谊", category: "社区",
    blurb: "邻居在组屋走廊分享一顿饭 —— 谈邻里关系。",
    imageR2Path: "oral-coach/pictures/2020_oral_day1_stimulus.jpg",
    passage: "TODO: passage on neighbourhood ties.",
    passageAuthentic: false,
    prompts: {
      describe: "你觉得这个组屋走廊适合举办邻里聚餐吗?为什么?",
      opinion: "你和邻居来不来往?为什么?",
      experience: "你觉得邻居之间应不应该互相认识?为什么?",
    },
    isAuthentic: false,
  },
  {
    id: "2020_2", year: "2020", day: 2, theme: "学校表演", category: "学校",
    blurb: "学生们在学校舞台上表演 —— 谈课外活动与展示自我。",
    imageR2Path: "oral-coach/pictures/2020_oral_day2_stimulus.jpg",
    passage: "TODO: passage on school performances.",
    passageAuthentic: false,
    prompts: {
      describe: "你觉得观众看这个表演开不开心?为什么?",
      opinion: "你比较想上台表演还是在后台帮忙?为什么?",
      experience: "你觉得学校为学生举办音乐会和表演重不重要?为什么?",
    },
    isAuthentic: false,
  },
  {
    id: "2019_1", year: "2019", day: 1, theme: "热爱阅读", category: "学习",
    blurb: "学生们在学校图书馆坐在懒骨头上看书 —— 谈阅读的乐趣。",
    imageR2Path: "oral-coach/pictures/2019_oral_day1_stimulus.jpg",
    passage: "TODO: passage on reading and libraries.",
    passageAuthentic: false,
    prompts: {
      describe: "你觉得这个图书馆是学生看书的好地方吗?为什么?",
      opinion: "你常不常去学校的图书馆?为什么?",
      experience: "你觉得小孩子有没有必要经常看书?为什么?",
    },
    isAuthentic: false,
  },
  {
    id: "2019_2", year: "2019", day: 2, theme: "负责任", category: "价值观",
    blurb: "学生把东西留在组屋走廊 —— 谈自我责任与照顾自己的东西。",
    imageR2Path: "oral-coach/pictures/2019_oral_day2_stimulus.jpg",
    passage: "TODO: passage on being responsible.",
    passageAuthentic: false,
    prompts: {
      describe: "你觉得那个学生为什么把东西留在桌子上?",
      opinion: "你会不会常常把自己的东西弄丢?为什么?",
      experience: "你觉得小孩子有没有必要学会照顾自己的东西?为什么?",
    },
    isAuthentic: false,
  },
  {
    id: "2018_1", year: "2018", day: 1, theme: "选择课外活动", category: "学校",
    blurb: "学生在体育馆里参与各种课外活动 —— 谈发展兴趣。",
    imageR2Path: "oral-coach/pictures/2018_oral_day1_stimulus.jpg",
    passage: "TODO: passage on choosing activities.",
    passageAuthentic: false,
    prompts: {
      describe: "图片里的活动,你最想参加哪一样?为什么?",
      opinion: "选择课外活动时你会考虑什么?为什么?",
      experience: "你觉得学生参与课外活动重不重要?为什么?",
    },
    isAuthentic: false,
  },
  {
    id: "2018_2", year: "2018", day: 2, theme: "公开演讲", category: "技能",
    blurb: "学生对着麦克风演讲 —— 谈自信与表达能力。",
    imageR2Path: "oral-coach/pictures/2018_oral_day2_stimulus.jpg",
    passage: "TODO: passage on public speaking.",
    passageAuthentic: false,
    prompts: {
      describe: "你觉得这个学生对着这么多人说话容不容易?为什么?",
      opinion: "你比较喜欢对着一大群人说话还是对着几个朋友说话?为什么?",
      experience: "你觉得小孩子有没有必要学会在众人面前自信地表达自己?为什么?",
    },
    isAuthentic: false,
  },
  {
    id: "2017_1", year: "2017", day: 1, theme: "感谢老师", category: "社区",
    blurb: "学生们把亲手做的贺卡送给老师 —— 谈感恩与尊敬。",
    imageR2Path: "oral-coach/pictures/2017_oral_day1_stimulus.jpg",
    passage: "TODO: passage on appreciating teachers.",
    passageAuthentic: false,
    prompts: {
      describe: "你觉得这些学生为什么送贺卡给老师?",
      opinion: "你比较喜欢送亲手做的礼物,还是买来的礼物?为什么?",
      experience: "你觉得感谢那些帮助过我们的人重不重要?为什么?",
    },
    isAuthentic: false,
  },
  {
    id: "2017_2", year: "2017", day: 2, theme: "干净的教室", category: "学校",
    blurb: "学生们一起打扫教室 —— 谈爱护公物与合作。",
    imageR2Path: "oral-coach/pictures/2017_oral_day2_stimulus.jpg",
    passage: "TODO: passage on classroom cleanliness.",
    passageAuthentic: false,
    prompts: {
      describe: "你觉得这些学生为什么自己动手打扫教室?",
      opinion: "你在家或者在学校常常帮忙打扫吗?为什么?",
      experience: "你觉得新加坡的清洁员的工作轻不轻松?为什么?",
    },
    isAuthentic: false,
  },
  {
    id: "2016_1", year: "2016", day: 1, theme: "热心的同学", category: "社区",
    blurb: "学生帮同班同学捡起掉落的东西 —— 谈助人为乐。",
    imageR2Path: "oral-coach/pictures/2016_oral_day1_stimulus.jpg",
    passage: "TODO: passage on supportive friends.",
    passageAuthentic: false,
    prompts: {
      describe: "你觉得这个帮忙的学生是一个好朋友吗?为什么?",
      opinion: "你愿不愿意帮一个你不太熟的同学?为什么?",
      experience: "你觉得新加坡人普遍愿不愿意帮助别人?为什么?",
    },
    isAuthentic: false,
  },
  {
    id: "2016_2", year: "2016", day: 2, theme: "健康饮食", category: "家庭",
    blurb: "一家人一起做饭 —— 谈饮食习惯与家庭。",
    imageR2Path: "oral-coach/pictures/2016_oral_day2_stimulus.jpg",
    passage: "TODO: passage on cooking and eating well.",
    passageAuthentic: false,
    prompts: {
      describe: "你觉得图片里的孩子做菜做得开不开心?为什么?",
      opinion: "你自己有没有试过做食物或零食?为什么?",
      experience: "你觉得小孩子培养健康的饮食习惯重不重要?为什么?",
    },
    isAuthentic: false,
  },
];

export const CATEGORY_STYLES_ZH: Record<string, { bg: string; text: string; ring: string }> = {
  社会:  { bg: "bg-indigo-50",  text: "text-indigo-700",  ring: "ring-indigo-200" },
  文化:  { bg: "bg-amber-50",   text: "text-amber-700",   ring: "ring-amber-200"  },
  健康:  { bg: "bg-rose-50",    text: "text-rose-700",    ring: "ring-rose-200"   },
  社区:  { bg: "bg-emerald-50", text: "text-emerald-700", ring: "ring-emerald-200"},
  学习:  { bg: "bg-sky-50",     text: "text-sky-700",     ring: "ring-sky-200"    },
  价值观:{ bg: "bg-purple-50",  text: "text-purple-700",  ring: "ring-purple-200" },
  环保:  { bg: "bg-lime-50",    text: "text-lime-700",    ring: "ring-lime-200"   },
  学校:  { bg: "bg-cyan-50",    text: "text-cyan-700",    ring: "ring-cyan-200"   },
  技能:  { bg: "bg-fuchsia-50", text: "text-fuchsia-700", ring: "ring-fuchsia-200"},
  家庭:  { bg: "bg-orange-50",  text: "text-orange-700",  ring: "ring-orange-200" },
};

export function getOralThemeZh(id: string): OralThemeZh | undefined {
  return ORAL_THEMES_ZH.find((t) => t.id === id);
}
