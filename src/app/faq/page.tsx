import Link from "next/link";

const faqs = [
  {
    q: "What subject and level does this cover?",
    a: "MarkForYou currently covers Primary 4\u20136 English, Math and Science, aligned to MOE syllabus.",
  },
  {
    q: "What is MarkForYou?",
    a: "MarkForYou is an AI-powered assistant for parents with primary school students in Singapore. Parents can assign quiz/practices/exam papers and our AI instantly marks handwritten answers and provide next steps — so you can stop marking and start coaching.",
  },
  {
    q: "How does AI marking work?",
    a: "Students complete quizzes on their device by writing answers on a digital canvas (for open-ended questions) or tapping options (for MCQ). Our AI reads their handwriting and grades within seconds.",
  },
  {
    q: "Is the AI marking accurate?",
    a: "Our AI achieves high accuracy for most question types, and even considers alternative solutions if the solution adheres to MOE scoring rubrics. Nonetheless, parents can review and adjust marks on the review page. We continuously improve the AI based on feedback.",
  },
  {
    q: "How much does it cost?",
    a: "MarkForYou is currently FREE during our beta period. We want to make sure it works well for families before introducing any pricing.",
  },
  {
    q: "How do I get started?",
    a: "Sign up as a parent, add your child as a student, and generate your first quiz — it takes less than 2 minutes. No credit card required.",
  },
  {
    q: "How are the questions set?",
    a: "The questions are a mix of top school past-year papers and AI expert-generated questions. As our AI model gets better, we will be replacing all the questions over time with AI expert-generated questions.",
  },
  {
    q: "How difficult are the questions?",
    a: "The difficulty is pegged to top schools standard. We make sure that the expert-generated questions are pegged at similar difficulty, and always adhering to MOE syllabus.",
  },
  {
    q: "How are the questions in quizzes / practices drawn? Is it random?",
    a: "It is randomised, but prioritised for questions not seen by the student before. As we expand our question bank (now 3,000+), there should hopefully be no more repeats.",
  },
  {
    q: "Some of the questions test concepts not yet taught by the school.",
    a: "We adjust the questions to match the syllabus taught by month and by level (e.g. WA1 Primary 4). However, as each school teaches modules differently, it is not a perfect system. Please use \"skip\" for questions testing concepts not yet taught. The scores will be adjusted, and parents can see which questions are skipped.",
  },
  {
    q: "I noticed some of the questions or answers are wrong. How do I highlight this?",
    a: "Both parent and student can \"flag\" a question for review. We will look into flagged questions and make adjustments.",
  },
  {
    q: "Can we have adjustable difficulty for the questions?",
    a: "Yes, this feature will be coming soon.",
  },
  {
    q: "[Spelling] What is this function for?",
    a: "Both student and parent can scan their latest spelling/\u542C\u5199. It will generate the spelling list, provide the meaning, example, and pinyin. Students can test themselves without bothering their parents.",
  },
  {
    q: "Can my child practise specific weak topics?",
    a: "Yes! The Focused Practice feature lets you create a 10-question test on any specific topic your child needs to work on. The system also auto-detects weak topics from quiz results.",
  },
  {
    q: "Does my child need their own device?",
    a: "Your child can use any device with a browser — phone, tablet, or computer. A tablet with a stylus works best for handwriting questions, but a finger on a phone screen works too.",
  },
  {
    q: "How is my child's data protected?",
    a: "We take data privacy seriously. Student data is only accessible to the linked parent account. We do not share or sell any personal information.",
  },
];

export default function FAQPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-[#eff6ff] to-white">
      {/* Header */}
      <header className="px-6 py-5 flex items-center justify-between max-w-4xl mx-auto">
        <Link href="/" className="font-headline text-xl font-extrabold text-[#003366]">
          MarkForYou
        </Link>
        <Link href="/signup" className="px-4 py-2 rounded-xl bg-[#003366] text-white text-sm font-bold hover:bg-[#001e40] transition-colors">
          Sign Up Free
        </Link>
      </header>

      {/* Content */}
      <main className="max-w-3xl mx-auto px-6 py-10 lg:py-16">
        <div className="text-center mb-10 lg:mb-14">
          <h1 className="font-headline text-3xl lg:text-4xl font-extrabold text-[#001e40] mb-3">
            Frequently Asked Questions
          </h1>
          <p className="text-lg text-[#43474f]">Everything you need to know about MarkForYou</p>
        </div>

        <div className="space-y-4">
          {faqs.map((faq, i) => (
            <details key={i} className="group bg-white rounded-2xl border border-[#e5eeff] shadow-sm">
              <summary className="flex items-center justify-between gap-4 px-6 py-5 cursor-pointer list-none font-headline text-base lg:text-lg font-bold text-[#001e40] hover:text-[#003366] transition-colors">
                {faq.q}
                <span className="material-symbols-outlined text-[#43474f] group-open:rotate-180 transition-transform shrink-0">expand_more</span>
              </summary>
              <div className="px-6 pb-5 -mt-1">
                <p className="text-[#43474f] leading-relaxed">{faq.a}</p>
              </div>
            </details>
          ))}
        </div>

        {/* CTA */}
        <div className="mt-12 text-center">
          <p className="text-[#43474f] mb-4">Still have questions?</p>
          <a href="mailto:peter.lzy@gmail.com" className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-[#003366] text-white font-bold hover:bg-[#001e40] transition-colors">
            <span className="material-symbols-outlined text-lg">mail</span>
            Contact Us
          </a>
        </div>
      </main>
    </div>
  );
}
