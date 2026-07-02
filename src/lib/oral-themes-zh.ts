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
      "炎热的下午，公园里人山人海，入口处停着一辆冰淇淋车。这里绝对是卖冰淇淋的好地方，因为天气闷热，人们都需要吃甜品消暑。冰淇淋车前很快排起了一条长长的人龙。虽然队伍很长，但大家都没有怨言，而是耐心地等待。前面的顾客离开后，后面的人便自动走上前，整个过程井然有序，没有人插队。看到这一幕，我不禁感叹，排队已经成了生活中不可或缺的一部分。无论是在小贩中心买食物，还是在巴士站等车，国人总是习惯排队。这种排队文化体现了大家对公共秩序的遵守，也展现了对别人的尊重。让我们继续保持这个好习惯，做一个守秩序的好公民。",
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
      "每到用餐时间，邻里的小贩中心总是人山人海，热闹非凡。有的摊位前排起了长龙，食客们耐心地等待着香喷喷的鸡饭；有的人正津津有味地吃着热腾腾的叻沙，额头上还冒着汗珠。一家大小围坐在桌旁，一边品尝美食，一边有说有笑，气氛温馨。人们喜欢在小贩中心吃饭，不仅因为食物种类繁多、价格大众化，更因为这里充满了浓浓的人情味。不同种族的人坐在一起，共享地道美食，展现了我国独特的饮食文化。小贩中心承载着大家的美好回忆，是生活中不可或缺的一部分。让我们好好珍惜这份宝贵的文化遗产，让熟悉的生活气息延续下去。",
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
    passage: "周末早晨，阳光明媚，我们一家人来到公园骑脚踏车。这里的风景迷人，绿树成荫，非常适合一家大小来放松身心。我们在脚踏车道上愉快地骑行，享受着家庭时光。然而，在休息时，我注意到草地上散落着空塑料瓶，显然是有人野餐后没有清理。不远处，还有人在人群中骑得飞快，险些撞倒散步的老人。看到这一幕，我十分惋惜。公园是我们共同的休闲场所，缺乏公德心的行为不仅破坏了环境，也给其他人带来安全隐患。我们在享受户外活动的同时，更应该时刻保持公德心。让我们从自己做起，爱护环境，遵守规则，让公园成为大家都能安心游玩的好去处。",
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
    passage: "每天清晨走进校园，我们总能看到各个角落干干净净的，这都要归功于默默工作的清洁工人。上个星期，几个同学亲手制作了一张精美的感谢卡，送给负责打扫食堂的王阿姨。王阿姨接过卡片时，脸上露出了惊喜的笑容，眼眶也微微泛红。她每天天还没亮就开始打扫，却很少有人对她道谢。同学们的小小举动，不仅肯定了她的付出，也让她感受到了温暖。这件事让我深受启发。清洁工人用汗水换来了我们舒适的学习环境。他们不仅需要感谢，更值得我们发自内心的尊重与欣赏。让我们从今天起，珍惜他们的劳动成果，主动对身边的劳动者表达谢意吧。",
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
    passage: "周末，学校组织我们去科学馆参观一场别开生面的科技展览。展厅里热闹非凡，最吸引我的是一台智能互动机器人。它不仅能和大家流利地交流，还能根据指令做出各种有趣的动作，甚至解答许多科学难题。同学们兴奋地围在机器人身旁，好奇地观察着它的一举一动，惊叹于科技的神奇力量。看着这台聪明的机器人，我不禁陷入了沉思。科技的发展真是日新月异，它不仅改变了我们的生活，也为我们打开了探索未知世界的大门。要想在未来驾驭这些高科技，我们现在就必须努力学习，培养自己的创新精神。科学的世界充满无限可能，让我们保持好奇心，勇敢地去探索和发现吧！",
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
    passage: "周末下午，阳光洒在客厅的沙发上。我和爷爷并排坐着，一起翻看一本厚厚的旧相册。爷爷指着一张黑白照片，告诉我那是他年轻时的生活场景。看着照片里笑容灿烂的爷爷，我仿佛也回到了那个年代。接着，我们又翻到我刚学走路时的照片，爷爷摸摸我的头，眼中满是慈爱。我终于明白，为什么我们这么喜欢一起看相册。每一张照片不仅记录了过去的点点滴滴，更把两代人的心紧紧连在一起。相册就像一台时光机，保存着我们最珍贵的回忆。时光飞逝，岁月虽然无法重来，但美好的瞬间却能永远留在心中。让我们多陪伴家人，用心珍藏每一段温馨的家庭记忆。",
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
    passage: "每天放学回家，我都会经过组屋底层的回收桶。这个回收桶是为了方便居民环保而设立的。可是，我经常看到桶外堆满了普通垃圾，有吃剩的饭盒，还有散发臭味的塑料袋。有些人贪图方便，连纸箱都不折叠就直接塞在洞口，导致别人无法把物品放进去。看到这一幕，我感到十分无奈。爱护环境不应该只是一句口号，而是需要我们在生活中付诸行动。如果我们连正确分类垃圾这样的小事都做不好，又怎么能保护美丽的地球呢？组屋底层是大家共同的生活空间，保持整洁是每个人的责任。让我们从自己做起，做好本分，正确使用回收桶，为环保尽一份力。",
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
    passage: "清晨的街道上，学生们背着书包匆匆赶往学校。然而，人群中总有几个同学脚步沉重，走着走着就打起哈欠，看起来无精打采。我的同学小明就是这样。最近，他总是在课堂上打瞌睡，根本无法专心听课。原来，他每天晚上都熬夜玩手机，或者赶着做功课，导致睡眠严重不足。看到他疲惫的样子，我体会到了充足睡眠的重要性。如果我们长时间作息不规律，不仅会降低学习效率，还会损害身体健康。机器运转久了都需要休息，更何况是正在成长的我们呢？因此，我们必须养成早睡早起的好习惯。让我们合理安排时间，按时作息，每天精神抖擞地迎接新的挑战。",
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
    passage: "周末的傍晚，公园里总是有许多人带着宠物散步。我常常看到一个小男孩带着小狗来到这里。他不仅给小狗系上牵引绳，还随身带着水壶和塑料袋。当小狗在草地上奔跑后，他会耐心地喂它喝水。如果小狗排便了，他也会立刻用塑料袋清理干净，绝不给别人添麻烦。看着他认真的样子，我觉得他真是一个负责任的主人。养宠物不只是因为它们可爱，或者为了好玩，而是需要付出精力去照顾它们，并承担起应有的责任。宠物就像家人一样，需要我们的关爱与陪伴。每一个生命都值得被用心对待。希望大家在养宠物之前，都能明白责任的重量，做一个有爱心的主人。",
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
    passage: "周末的傍晚，组屋走廊传来阵阵饭菜香，原来是邻居们正在举办一场温馨的聚餐。大家把桌椅搬到宽敞的走廊上，摆满了各自拿手的家常菜。张阿姨端来咖喱鸡，李叔叔准备了炒米粉。大人们一边品尝美食，一边愉快地聊天，孩子们则在一旁开心地玩耍。宽敞通风的走廊，成了大家交流感情的好地方。看着这热闹的场景，我感到十分温暖。在忙碌的生活中，人们往往早出晚归，很少和邻居打招呼。这样简单的聚餐，不仅拉近了彼此的距离，也让大家变成了互相关心的朋友。远亲不如近邻，让我们多走出家门，和邻居交流互动，共同建立一个充满人情味的社区。",
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
    passage: "学校礼堂里灯光闪烁，一年一度的才艺表演终于拉开了序幕。舞台上，同学们正在呈献精彩的舞蹈。每一个动作，都展现了他们在课外活动中付出的汗水与努力。台下的观众看得津津有味，不时爆发出热烈的掌声。看着大家脸上洋溢着灿烂的笑容，我知道观众们一定非常开心。他们不仅被精彩的演出深深吸引，更被同学们在台上那份自信和活力所打动。这让我明白，课外活动不仅能让我们学习新技能，还能培养团队精神。我们在排练中克服困难，最终才能在众人面前勇敢地展示自我。让我们积极参与课外活动，发掘潜能，勇敢地站在舞台上发光发热吧！",
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
    passage: "走进学校的图书馆，一阵淡淡的书香扑面而来，这里是同学们最喜欢的好去处。明亮的角落里摆放着五颜六色的懒骨头坐垫。休息时间一到，大家便来到这里，挑选喜爱的故事书。有的同学舒服地靠在懒骨头上，全神贯注地阅读；有的则和好朋友并肩坐着，分享书中的趣事。在这个温馨的环境里，大家仿佛插上了想象的翅膀，在知识的海洋中自由翱翔。图书馆不仅是安静的学习场所，更是充满乐趣的乐园。舒服的座位和丰富的藏书，让阅读变成了一件轻松愉快的事，帮助我们舒缓课业压力。阅读能开阔眼界，丰富生活。让我们每天抽出一点时间，一起享受阅读的快乐吧！",
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
    passage: "在我们的日常生活中，经常会看到一些不负责任的行为。比如，有些同学在组屋走廊或楼下的桌椅上休息，离开时却把书本、水壶甚至垃圾留在桌子上。他们或许是急着去玩耍，或许是以为别人会帮忙收拾，完全忘记了自己应该承担的责任。这样的行为不仅给邻居带来不便，也反映出我们没有好好照顾自己的物品。把个人物品随处乱放，不仅容易遗失，还会破坏公共环境的整洁。如果我们连自己的东西都管理不好，又怎么能让人相信我们是一个有责任感的人呢？因此，我们应该从小养成好习惯，离开前仔细检查一遍，做一个对自己和他人负责任的人。",
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
    passage: "新学年的早晨，学校体育馆里热闹非凡，课外活动展台前挤满了学生。篮球场上，队员们正挥洒汗水，展现球技；角落里，美术社的同学正专心画画。面对琳琅满目的选择，许多人感到眼花缭乱。有的人选择自己擅长的运动，有的则想尝试全新的挑战。其实，课外活动不仅能让我们锻炼身体，还能发掘隐藏的才华。在参与的过程中，我们能培养兴趣爱好，结交好朋友，并学会团队合作。因此，选择课外活动时应该跟随自己的内心。只要找到热爱的项目并坚持下去，我们的校园生活一定会更加丰富多彩。",
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
    passage: "站在台上，面对着台下无数的观众，对着麦克风发表演讲，绝对不是一件容易的事。许多同学在台下有说有笑，可是一旦站上舞台，就会紧张得手心出汗。记得我第一次参加演讲比赛时，看着台下一双双注视我的眼睛，脑海里顿时一片空白。原本背得滚瓜烂熟的讲稿忘得一干二净，最后只能结结巴巴地把话说完。那次经历让我明白，要在众人面前从容地表达想法，不仅需要充分的准备，更需要战胜内心的恐惧。自信和良好的表达能力并不是天生的，而是通过不断练习培养出来的。让我们勇敢迈出第一步，把握每次上台发言的机会，克服胆怯，成为充满自信的人。",
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
    passage: "一年一度的教师节即将来临，校园里洋溢着温馨的气氛。下课后，几个同学围在桌前，专心致志地制作贺卡。他们有的在卡纸上画上美丽的图案，有的用心地写下祝福语。为了给老师一个惊喜，大家还折了精美的纸星星贴在上面。当他们双手把这份心意递给老师时，老师的脸上露出了欣慰的笑容。看着这一幕，我不禁想到，老师每天辛勤地教导我们，不仅传授知识，还关心我们的成长。亲手制作的贺卡，虽然不如买来的礼物贵重，却包含了同学们对老师深深的感恩与尊敬。让我们把感激化作实际行动，专心听讲，用好成绩来回报老师的付出吧。",
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
    passage: "每天早晨，走进明亮整洁的教室，我们的心情总是特别舒畅。然而，这份干净并不是理所当然的。记得上周五放学后，大家决定一起大扫除。同学们立刻分工合作，有的扫地，有的擦窗户，有的把桌椅排得整整齐齐。虽然忙得满头大汗，但看到焕然一新的教室，大家脸上都露出了笑容。在这过程中，我们不仅学会了配合，也体会到了劳动的辛苦。这让我明白，教室是共同学习的地方，公物需要用心爱护。如果乱丢垃圾或在桌上乱画，不仅破坏环境，也增加了别人的负担。因此，让我们从自己做起，齐心协力保持卫生，营造美好的学习家园。",
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
    passage: "在校园生活中，每天都有令人感动的事情发生。记得有一天放学，小明正急忙收拾书包。一不小心，他的文具盒掉在地上，彩色笔散落一地。他急得不知所措。这时，准备离开的小华看到了。他毫不犹豫地放下书包，蹲下身子，耐心地帮小明把地上的东西一件件捡起来，放回盒子里。小明连声道谢，小华只是微笑着摆手。看着这一幕，我心里感到十分温暖。小华虽然只做了一件小事，但他展现出的热心，正是好朋友最珍贵的品质。真正的朋友，不仅能分享快乐，更会在别人遇到困难时伸出援手。让我们都向小华学习，多关心同学，让校园充满温情。",
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
    passage: "周末的傍晚，厨房里传来阵阵欢笑声，我们一家人正围在一起准备晚餐。以前我们家总习惯点外卖，食物往往重油重盐，不够健康。最近，爸爸提议周末全家一起做饭。今天，我负责洗菜，妈妈切肉，爸爸大显身手炒菜。看着新鲜食材在锅里翻滚，闻着扑鼻的饭菜香，我感到无比开心。这不仅让我学到了烹饪技巧，更体会到了合作的乐趣。相比起外面的快餐，自己做的饭菜少油少盐，营养更加均衡。一家人边做边聊，让普通的晚餐变得特别温馨。健康的饮食习惯需要从生活中慢慢培养。让我们多花点时间，和家人一起走进厨房，享受健康美味的时光吧！",
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
