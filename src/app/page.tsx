import Link from "next/link";

export default function HomePage() {
  return (
    <div className="bg-background text-on-surface font-body selection:bg-tertiary-container">

      {/* ── TopNavBar ── */}
      <nav className="fixed top-0 w-full z-50 bg-background/80 backdrop-blur-md border-b border-surface-container">
        <div className="flex justify-between items-center h-16 lg:h-20 px-6 max-w-7xl mx-auto">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="MarkForYou Logo" className="h-8 w-8 lg:h-10 lg:w-10 object-contain rounded-lg" src="/logo_t.png" />
            <span className="text-lg lg:text-xl font-bold text-primary tracking-tight font-headline">MarkForYou.com</span>
          </div>
          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-8 font-medium text-sm">
            <a className="text-on-surface-variant hover:text-tertiary transition-colors" href="#demo-video">How it Works</a>
            <Link className="text-on-surface-variant hover:text-tertiary transition-colors" href="/login">Login</Link>
            <Link href="/signup" className="px-6 py-2.5 rounded-full bg-secondary text-white font-bold hover:shadow-lg transition-all text-sm">
              Try Free
            </Link>
          </div>
          {/* Mobile nav */}
          <div className="md:hidden flex items-center gap-3">
            <Link href="/login" className="text-xs text-on-surface-variant hover:text-tertiary transition-colors font-medium">Login</Link>
            <Link href="/signup" className="px-4 py-2 rounded-full bg-secondary text-white font-bold hover:shadow-lg transition-all text-xs">
              Try Free
            </Link>
          </div>
        </div>
      </nav>

      <main className="pt-16 lg:pt-20">

        {/* ── Hero Section ── */}
        <section className="relative pt-10 pb-16 md:pt-24 md:pb-32 px-6 warm-gradient overflow-hidden">
          <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-12 items-center">
            <div className="relative z-10">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-tertiary-container text-on-tertiary-container font-semibold text-xs mb-6 uppercase tracking-wider">
                <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>favorite</span>
                Built for Parents, By Parents
              </div>
              <h1 className="font-headline text-3xl md:text-6xl font-extrabold text-primary leading-tight mb-5 text-balance">
                Stop marking. <span className="text-tertiary">Start coaching.</span>
              </h1>
              <p className="text-on-surface-variant text-base md:text-xl leading-relaxed mb-4 max-w-xl">
                MarkForYou instantly marks your child&apos;s written homework, spots their weak topics and builds the next custom practice automatically. Built by Singapore parents who were tired of marking.
              </p>
              <p className="text-on-surface-variant text-sm md:text-base font-semibold mb-8 max-w-xl">
                Primary 4-6. Math, Science and English. More coming.
              </p>
              <div className="flex flex-wrap gap-4">
                <Link href="/signup" className="w-full sm:w-auto text-center px-10 py-4 bg-tertiary text-white font-bold rounded-full soft-glow hover:scale-105 transition-transform text-lg">
                  Try now free
                </Link>
                <a href="#demo-video" className="w-full sm:w-auto text-center px-10 py-4 bg-white text-primary font-bold rounded-full border-2 border-primary/10 hover:border-primary/30 hover:scale-105 transition-all text-lg">
                  Watch a 30-second demo
                </a>
              </div>
            </div>
            <div className="relative">
              <div className="relative z-10 rounded-3xl overflow-hidden soft-glow">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt="Mother and daughter learning together" className="w-full aspect-[4/3] object-cover" src="/girlmom.jpg" />
              </div>
            </div>
          </div>
        </section>

        {/* ── Problem & Empathy Section ── */}
        <section className="py-16 lg:py-24 bg-white px-6">
          <div className="max-w-4xl mx-auto text-center mb-10 lg:mb-16">
            <h2 className="font-headline text-2xl md:text-4xl font-extrabold text-primary mb-4 lg:mb-6">
              Do you and your child struggle with Primary School Math, Science or English?
            </h2>
            <p className="text-on-surface-variant text-base lg:text-lg">We understand the late nights and the frustration of &ldquo;endless drilling.&rdquo;</p>
          </div>
          {/* Mobile: bullet list */}
          <div className="max-w-xl mx-auto lg:hidden mb-4">
            <ul className="space-y-4 text-base text-primary font-medium">
              <li className="flex items-start gap-3">
                <span className="material-symbols-outlined text-tertiary text-xl mt-0.5">psychology_alt</span>
                <span>Endless drilling but unsure where are your child&apos;s <strong>weak areas</strong>?</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="material-symbols-outlined text-tertiary text-xl mt-0.5">filter_alt</span>
                <span>Unsure how to let your child <strong>practice on similar questions</strong>?</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="material-symbols-outlined text-tertiary text-xl mt-0.5">chat_bubble</span>
                <span>Getting feedback that is lacking <strong>step-by-step explanation</strong>?</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="material-symbols-outlined text-tertiary text-xl mt-0.5">timer_off</span>
                <span>Child <strong>unmotivated by long tuitions</strong>?</span>
              </li>
            </ul>
          </div>
          {/* Desktop: icon cards */}
          <div className="max-w-7xl mx-auto hidden lg:grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="p-8 bg-surface-container-low rounded-3xl border border-surface-container-high text-center flex flex-col items-center">
              <span className="material-symbols-outlined text-tertiary text-4xl mb-6">psychology_alt</span>
              <p className="font-medium text-primary leading-snug">Endless drilling but unsure where are your child&apos;s <strong>weak areas</strong>?</p>
            </div>
            <div className="p-8 bg-surface-container-low rounded-3xl border border-surface-container-high text-center flex flex-col items-center">
              <span className="material-symbols-outlined text-tertiary text-4xl mb-6">filter_alt</span>
              <p className="font-medium text-primary leading-snug">Unsure how to let your child <strong>practice on similar questions</strong>?</p>
            </div>
            <div className="p-8 bg-surface-container-low rounded-3xl border border-surface-container-high text-center flex flex-col items-center">
              <span className="material-symbols-outlined text-tertiary text-4xl mb-6">chat_bubble</span>
              <p className="font-medium text-primary leading-snug">Getting feedback that is lacking <strong>step-by-step explanation</strong>?</p>
            </div>
            <div className="p-8 bg-surface-container-low rounded-3xl border border-surface-container-high text-center flex flex-col items-center">
              <span className="material-symbols-outlined text-tertiary text-4xl mb-6">timer_off</span>
              <p className="font-medium text-primary leading-snug">Child <strong>unmotivated by long tuitions</strong>?</p>
            </div>
          </div>
        </section>

        {/* ── Solution Section ── */}
        <section className="py-16 lg:py-24 bg-surface-container-lowest px-6 overflow-hidden">
          <div className="max-w-7xl mx-auto flex flex-col lg:flex-row items-center gap-10 lg:gap-16">
            <div className="w-full lg:w-1/2">
              <div className="relative">
                <div className="absolute -inset-4 bg-secondary/5 rounded-[3rem] -rotate-2"></div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt="Child learning independently" className="relative z-10 rounded-3xl soft-glow w-full aspect-video object-cover" src="/boyself2.png" />
                <div className="absolute -top-4 -right-4 lg:-top-6 lg:-right-6 bg-secondary text-white px-4 lg:px-6 py-2 lg:py-3 rounded-full font-bold text-xs lg:text-sm shadow-lg z-20">
                  Independent Learner
                </div>
              </div>
            </div>
            <div className="w-full lg:w-1/2">
              <h2 className="font-headline text-2xl md:text-5xl font-extrabold text-primary mb-6 lg:mb-8 leading-tight">
                MarkForYou is designed to address your child&apos;s learning needs at his own pace.
              </h2>
              <p className="text-base lg:text-lg text-on-surface-variant mb-8 lg:mb-10 leading-relaxed">
                Targeted and personalised, <span className="font-bold text-secondary">bite-sized practices</span> with instant detailed feedback. We move away from stress and towards confidence.
              </p>
              <div className="flex flex-col md:flex-row items-start lg:items-center gap-8 lg:gap-12">
                {/* Owl — desktop only */}
                <div className="hidden lg:flex flex-shrink-0 lg:w-1/3 justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img alt="Helpful Owl" className="h-48 w-48 object-contain" src="/owlright_t.png" />
                </div>
                <div className="space-y-8 lg:space-y-10 flex-1">
                  <div className="flex items-start gap-4">
                    <div className="w-10 h-10 rounded-full bg-secondary-container flex-shrink-0 flex items-center justify-center text-secondary">
                      <span className="material-symbols-outlined text-[20px]">verified</span>
                    </div>
                    <div>
                      <h4 className="font-bold text-primary mb-1">Empowering your child</h4>
                      <p className="text-on-surface-variant text-sm">Building self-reliance through instant success and clear explanations.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-4">
                    <div className="w-10 h-10 rounded-full bg-secondary-container flex-shrink-0 flex items-center justify-center text-secondary">
                      <span className="material-symbols-outlined text-[20px]">school</span>
                    </div>
                    <div>
                      <h4 className="font-bold text-primary mb-1">Focus on being the coach</h4>
                      <p className="text-on-surface-variant text-sm">We handle the marking while you provide the support and encouragement.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Features Bento Grid ── */}
        <section className="py-16 lg:py-24 bg-white px-6" id="features">
          <div className="max-w-7xl mx-auto">
            <div className="text-center mb-10 lg:mb-16">
              <h2 className="font-headline text-3xl lg:text-4xl font-extrabold text-primary">Everything you need for mastery</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8">
              <div className="bg-surface-container-low p-8 lg:p-10 rounded-3xl border border-surface-container-high flex flex-col items-center text-center h-full">
                <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center text-tertiary mb-6 lg:mb-8 shadow-sm">
                  <span className="material-symbols-outlined text-[32px]">auto_fix_high</span>
                </div>
                <h3 className="font-headline text-xl lg:text-2xl font-bold text-primary mb-3 lg:mb-4">Personalised bite-size practices</h3>
                <p className="text-on-surface-variant leading-relaxed text-sm lg:text-base">Take a quick practice quiz tailored to your child&apos;s learning gaps while waiting for the bus.</p>
              </div>
              <div className="bg-primary text-white p-8 lg:p-10 rounded-3xl flex flex-col items-center text-center h-full shadow-xl">
                <div className="w-16 h-16 bg-white/10 rounded-2xl flex items-center justify-center text-tertiary-fixed mb-6 lg:mb-8">
                  <span className="material-symbols-outlined text-[32px]">edit_note</span>
                </div>
                <h3 className="font-headline text-xl lg:text-2xl font-bold mb-3 lg:mb-4">Grades MCQ and written open-ended questions</h3>
                <p className="text-white/80 leading-relaxed text-sm lg:text-base">Simulate real exam settings. Instant marking for even hand-written assignments (including messy ones). Master science key words and concepts and math heuristics.</p>
              </div>
              <div className="bg-secondary-container/30 p-8 lg:p-10 rounded-3xl border border-secondary/10 flex flex-col items-center text-center h-full">
                <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center text-secondary mb-6 lg:mb-8 shadow-sm">
                  <span className="material-symbols-outlined text-[32px]">dataset</span>
                </div>
                <h3 className="font-headline text-xl lg:text-2xl font-bold text-primary mb-3 lg:mb-4">Unlimited practice with instant feedback</h3>
                <p className="text-on-surface-variant leading-relaxed text-sm lg:text-base">Instant marking and feedback with detailed explanation. 3,000 questions drawn from top school past year papers and in-house generation.</p>
              </div>
            </div>
          </div>
        </section>

        {/* ── Demo Video Section ── */}
        <section className="py-16 lg:py-24 bg-surface-container-low px-6" id="demo-video">
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-8 lg:mb-12">
              <h2 className="font-headline text-2xl md:text-4xl font-extrabold text-primary mb-4">How it works</h2>
            </div>
            <div className="relative aspect-video rounded-3xl overflow-hidden shadow-2xl bg-black">
              <video
                className="w-full h-full object-cover"
                controls
                preload="metadata"
                poster="/democover.png"
              >
                <source src="/Markforyou.mp4" type="video/mp4" />
              </video>
            </div>
          </div>
        </section>

        {/* ── CTA Section ── */}
        <section className="py-16 lg:py-24 px-6">
          <div className="max-w-5xl mx-auto bg-tertiary-container rounded-[3rem] p-8 md:p-20 text-center relative overflow-hidden soft-glow">
            {/* Owl — mobile: top center */}
            <div className="lg:hidden flex justify-center mb-6">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt="Flying Owl" className="h-24 w-auto object-contain opacity-90" src="/owlfly_t.png" />
            </div>
            {/* Owl — desktop: bottom left */}
            <div className="absolute -left-12 bottom-0 hidden lg:block z-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt="Flying Owl" className="h-48 w-auto object-contain opacity-90" src="/owlfly_t.png" />
            </div>
            <div className="absolute top-0 right-0 w-64 h-64 bg-tertiary/5 rounded-full -mr-32 -mt-32"></div>
            <div className="relative z-10">
              <h2 className="font-headline text-2xl md:text-5xl font-extrabold text-primary mb-5 lg:mb-6">Ready to see your child smile while learning?</h2>
              <p className="text-on-tertiary-container text-base md:text-xl mb-8 lg:mb-10 max-w-2xl mx-auto">
                Join the MarkForYou.com family and transform study time from a struggle into a shared victory.
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4 lg:gap-6">
                <Link href="/signup" className="w-full sm:w-auto px-12 py-5 bg-tertiary text-white font-extrabold rounded-full text-lg hover:bg-on-tertiary-container transition-colors shadow-lg">
                  Start Your Free Trial
                </Link>
                <p className="text-on-tertiary-container font-semibold italic text-sm">No credit card required to start.</p>
              </div>
            </div>
          </div>
        </section>

      </main>

      {/* ── Footer ── */}
      <footer className="bg-surface-container-low pt-14 lg:pt-20 pb-10 px-6 border-t border-surface-container">
        {/* Mobile footer */}
        <div className="lg:hidden max-w-xl mx-auto flex flex-col gap-10 mb-10">
          <div>
            <div className="flex items-center gap-3 mb-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt="MarkForYou Logo" className="h-8 w-8 object-contain opacity-80" src="/logo_t.png" />
              <span className="text-lg font-bold text-primary">MarkForYou.com</span>
            </div>
            <p className="text-on-surface-variant text-sm leading-relaxed mb-5">Redefining personalised education through warm, AI-powered targeted practice that makes parents&apos; lives easier.</p>
          </div>
          {/* Links — 2 col grid */}
          <div className="grid grid-cols-2 gap-6">
            <div>
              <h4 className="font-bold text-primary mb-4">Product</h4>
              <ul className="space-y-3 text-sm text-on-surface-variant">
                <li><a className="hover:text-tertiary transition-colors" href="#demo-video">How it Works</a></li>
              </ul>
            </div>
          </div>
        </div>

        {/* Desktop footer */}
        <div className="max-w-7xl mx-auto hidden lg:grid grid-cols-1 md:grid-cols-4 gap-12 mb-16">
          <div className="col-span-1 md:col-span-1">
            <div className="flex items-center gap-3 mb-6">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt="MarkForYou Logo" className="h-8 w-8 object-contain opacity-80" src="/logo_t.png" />
              <span className="text-xl font-bold text-primary">MarkForYou.com</span>
            </div>
            <p className="text-on-surface-variant text-sm leading-relaxed mb-6">Redefining personalised education through warm, AI-powered targeted practice that makes parents&apos; lives easier.</p>
          </div>
          <div>
            <h4 className="font-bold text-primary mb-6">Product</h4>
            <ul className="space-y-4 text-sm text-on-surface-variant">
              <li><a className="hover:text-tertiary transition-colors" href="#demo-video">How it Works</a></li>
            </ul>
          </div>
        </div>

        <div className="max-w-7xl mx-auto pt-8 border-t border-surface-container text-center text-xs text-on-surface-variant/60">
          <p>© 2025 MarkForYou.com. All rights reserved.</p>
        </div>
      </footer>

    </div>
  );
}
