// PSLE 华文 Paper 3 Oral practice catalogue.
//
// Each theme carries a short 朗读 passage (~100-130 characters,
// primary-school register) and three 会话 prompts in the 2026 order:
//   Q1 描述 — describe the stimulus
//   Q2 表达意见 — opinion / agreement
//   Q3 分享经历 — personal experience
//
// Stimuli reuse the R2 Singapore photos we generated for the English
// module — the visuals are language-agnostic. imageR2Path is the
// object path inside the R2 bucket.
//
// The scoring targets 50 marks: Reading Aloud /20 + SBC /30.

export type OralThemeZhKey =
  | "zh_neighbours"
  | "zh_hawker"
  | "zh_teacher"
  | "zh_recycling"
  | "zh_reading"
  | "zh_screen_time"
  | "zh_pets"
  | "zh_outdoor"
  | "zh_appreciation"
  | "zh_cooking";

export type OralThemeZh = {
  id: OralThemeZhKey;
  theme: string;         // 3-6 character Chinese label shown in the picker
  blurb: string;         // one sentence describing the scene / focus
  category: string;      // used for the badge chip
  /** R2 object path (relative to the bucket root) for the stimulus image. */
  imageR2Path: string;
  /** Reading Aloud passage — Simplified Chinese, ~100-130 characters. */
  passage: string;
  prompts: {
    describe: string;    // Q1 描述
    opinion: string;     // Q2 表达意见
    experience: string;  // Q3 分享经历
  };
};

export const ORAL_THEMES_ZH: OralThemeZh[] = [
  {
    id: "zh_neighbours",
    theme: "睦邻友好",
    blurb: "邻居在组屋楼下一起吃饭 —— 谈邻里关系与守望相助。",
    category: "社区",
    imageR2Path: "oral-coach/pictures/2020_oral_day1_stimulus.jpg",
    passage:
      "我住在一座组屋里,楼下有一个宽敞的走廊。每逢周末,邻居们都会聚集在那里,一起吃饭、聊天。我的邻居陈阿姨热情又亲切,常常送来她亲手做的娘惹糕。我们互相帮忙,守望相助,让这里就像一个温暖的大家庭。",
    prompts: {
      describe: "请你描述一下图片里的情景。你看到了什么?",
      opinion: "你觉得邻居之间应不应该经常来往?为什么?",
      experience: "请你说一说自己和邻居之间发生过的一件事。",
    },
  },
  {
    id: "zh_hawker",
    theme: "小贩中心",
    blurb: "小贩中心里人们排队买美食 —— 谈本地饮食文化。",
    category: "文化",
    imageR2Path: "oral-coach/pictures/2025_oral_day2_stimulus.jpg",
    passage:
      "小贩中心是新加坡人生活中不可缺少的一部分。这里售卖各种各样的美食,有鸡饭、叻沙、云吞面等等。到了中午,顾客们排着长长的队伍,等着买自己喜爱的食物。摊主们熟练地烹煮着食物,笑容满面地招待每一位客人。",
    prompts: {
      describe: "图片里的小贩中心热不热闹?你看到了什么?",
      opinion: "你觉得小贩中心的美食比家里煮的好吃吗?为什么?",
      experience: "请你说说你最喜欢在小贩中心吃什么,为什么?",
    },
  },
  {
    id: "zh_teacher",
    theme: "感谢老师",
    blurb: "学生把亲手做的贺卡送给老师 —— 谈感恩与尊敬。",
    category: "感恩",
    imageR2Path: "oral-coach/pictures/2017_oral_day1_stimulus.jpg",
    passage:
      "每逢教师节,学生们都会用心地准备礼物送给老师。有的画贺卡,有的写感谢信,有的甚至折出精美的纸鹤。老师们看到这些礼物,总是笑得合不拢嘴。他们最欣慰的,不是礼物本身,而是学生那份感恩的心意。",
    prompts: {
      describe: "请描述图片里学生送贺卡的情景。",
      opinion: "你觉得除了老师之外,我们还应该感谢哪些人?为什么?",
      experience: "请你分享一次你向别人表达感谢的经历。",
    },
  },
  {
    id: "zh_recycling",
    theme: "环保回收",
    blurb: "组屋楼下有回收桶 —— 谈爱护环境的重要性。",
    category: "环保",
    imageR2Path: "oral-coach/pictures/2022_oral_day1_stimulus.jpg",
    passage:
      "地球是我们唯一的家园,保护环境是每个人的责任。为了减少垃圾,新加坡在许多地方设立了回收桶。我们可以把用过的纸张、塑料瓶和铁罐分类丢进不同的桶里。虽然这只是一个小小的举动,但如果人人都动手,就能为地球做出很大的贡献。",
    prompts: {
      describe: "图片里的人在做什么?他们为什么这么做?",
      opinion: "你觉得回收对我们的生活有什么好处?为什么?",
      experience: "请你说说你在家里或学校做过哪些环保的事情。",
    },
  },
  {
    id: "zh_reading",
    theme: "热爱阅读",
    blurb: "学生们在图书馆看书 —— 谈阅读的乐趣与好处。",
    category: "学习",
    imageR2Path: "oral-coach/pictures/2019_oral_day1_stimulus.jpg",
    passage:
      "图书馆是一个安静又充满知识的地方。每当我走进图书馆,总会被那一排排书架深深吸引。这里有神秘的科幻故事,有精彩的历史书,还有幽默的漫画。阅读不但能让我们学到新知识,还能让心情放松,让思想飞翔到更广阔的世界。",
    prompts: {
      describe: "图片里的学生们在做什么?他们看起来怎么样?",
      opinion: "你认为阅读对小学生重要吗?为什么?",
      experience: "请你介绍一本你最喜爱的书,并说说它吸引你的原因。",
    },
  },
  {
    id: "zh_screen_time",
    theme: "使用电子产品",
    blurb: "小孩玩平板忽略了书本 —— 谈平衡与自律。",
    category: "健康",
    imageR2Path: "oral-coach/pictures/2022_oral_day2_stimulus.jpg",
    passage:
      "电子产品在我们的生活中越来越普遍。它们能帮助我们学习、看新闻、和朋友聊天。可是,过度使用电子产品会让眼睛疲劳,也会影响我们的功课和睡眠。因此,我们必须懂得安排时间,做完功课后再适当地放松,让电子产品成为帮手,而不是负担。",
    prompts: {
      describe: "请你描述图片里的孩子在做什么。",
      opinion: "你同意每天使用电子产品应该有时间限制吗?为什么?",
      experience: "请你说说你自己是怎么安排使用电子产品的时间的。",
    },
  },
  {
    id: "zh_pets",
    theme: "爱护小动物",
    blurb: "小男孩在公园里照顾他的小狗 —— 谈责任与关爱。",
    category: "价值观",
    imageR2Path: "oral-coach/pictures/2021_oral_day2_stimulus.jpg",
    passage:
      "我家养了一只可爱的小狗,名叫小白。每天放学后,我都会带它到楼下的公园散步。它最喜欢在草地上追逐蝴蝶,快乐地跑来跑去。照顾小白虽然要花不少时间,但它带给我数不完的欢笑。因为有了它,我学会了要有耐心,也懂得了爱护小动物的重要。",
    prompts: {
      describe: "图片里的小男孩正在做什么?他为什么这么做?",
      opinion: "你觉得养宠物对孩子来说有哪些好处?为什么?",
      experience: "请你分享一次你和小动物相处的经历。",
    },
  },
  {
    id: "zh_outdoor",
    theme: "户外活动",
    blurb: "一家人在公园骑脚踏车 —— 谈健康的生活方式。",
    category: "健康",
    imageR2Path: "oral-coach/pictures/2024_oral_day1_stimulus.jpg",
    passage:
      "在阳光明媚的周末,我最喜欢和家人一起到公园活动。哥哥总是抢先骑上脚踏车,妹妹则拉着我的手,一起在小路上散步。空气清新,鸟儿在树上欢快地叫着。这样的时刻让我感到无比放松,也让我明白,健康的生活离不开运动和大自然的陪伴。",
    prompts: {
      describe: "图片里的一家人在做什么?他们看起来怎么样?",
      opinion: "你觉得多参与户外活动对小学生有什么帮助?为什么?",
      experience: "请你说说你最喜欢的一项户外活动,以及它带给你的乐趣。",
    },
  },
  {
    id: "zh_appreciation",
    theme: "感谢劳动者",
    blurb: "学生向食堂清洁员表达感谢 —— 谈欣赏与尊重。",
    category: "价值观",
    imageR2Path: "oral-coach/pictures/2024_oral_day2_stimulus.jpg",
    passage:
      "在我们的校园里,有一群默默付出的人。清洁员每天清扫走廊,擦洗桌椅,让我们能在干净的环境里学习。食堂的叔叔阿姨则准备可口的饭菜,让我们吃得开心。虽然他们的工作看起来平凡,却是校园生活中不可或缺的一部分。让我们记得对他们说声“谢谢”,感谢他们默默的付出。",
    prompts: {
      describe: "请描述一下图片里的情景。学生们在做什么?",
      opinion: "你觉得我们为什么应该感谢默默付出的人?",
      experience: "请你说说你曾经如何向学校里的工作人员表达感谢。",
    },
  },
  {
    id: "zh_cooking",
    theme: "学习做饭",
    blurb: "小朋友和家人一起做饭 —— 谈健康饮食与生活技能。",
    category: "家庭",
    imageR2Path: "oral-coach/pictures/2016_oral_day2_stimulus.jpg",
    passage:
      "自己动手做饭,是一件既有趣又有意义的事情。妈妈教我认识各种食材,告诉我哪些青菜有丰富的维生素,哪些食物含有太多的糖。我学会了洗菜、切菜,还试着煮出简单的番茄鸡蛋面。虽然味道还不完美,但是自己做的饭菜,吃起来总觉得格外美味。",
    prompts: {
      describe: "请你描述一下图片里的孩子在做什么?",
      opinion: "你觉得小学生学会做饭是不是一件重要的事?为什么?",
      experience: "请你分享一次你亲手做出食物的经历。",
    },
  },
];

// Same category → Tailwind palette map style as the English module.
export const CATEGORY_STYLES_ZH: Record<string, { bg: string; text: string; ring: string }> = {
  社区:  { bg: "bg-emerald-50",  text: "text-emerald-700",  ring: "ring-emerald-200"  },
  文化:  { bg: "bg-amber-50",    text: "text-amber-700",    ring: "ring-amber-200"    },
  感恩:  { bg: "bg-rose-50",     text: "text-rose-700",     ring: "ring-rose-200"     },
  环保:  { bg: "bg-lime-50",     text: "text-lime-700",     ring: "ring-lime-200"     },
  学习:  { bg: "bg-sky-50",      text: "text-sky-700",      ring: "ring-sky-200"      },
  健康:  { bg: "bg-fuchsia-50",  text: "text-fuchsia-700",  ring: "ring-fuchsia-200"  },
  价值观:{ bg: "bg-purple-50",   text: "text-purple-700",   ring: "ring-purple-200"   },
  家庭:  { bg: "bg-orange-50",   text: "text-orange-700",   ring: "ring-orange-200"   },
};

export function getOralThemeZh(id: string): OralThemeZh | undefined {
  return ORAL_THEMES_ZH.find((t) => t.id === id);
}
