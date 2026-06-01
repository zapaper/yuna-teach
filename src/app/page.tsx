import Link from "next/link";
import NativeLandingBouncer from "@/components/NativeLandingBouncer";

export default function HomePage() {
  return (
    <div className="bg-background text-on-surface font-body selection:bg-tertiary-container">
      {/* iOS Capacitor only — redirects the app's cold-launch from
          the marketing page straight to /login. No-op on web. */}
      <NativeLandingBouncer />

      {/* ── TopNavBar ── */}
      <nav className="fixed top-0 w-full z-50 bg-background/80 backdrop-blur-md border-b border-surface-container">
        <div className="flex justify-between items-center h-16 lg:h-20 px-6 max-w-7xl mx-auto">
          <div className="flex items-center gap-2 lg:gap-3 min-w-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="MarkForYou Logo" className="h-8 w-8 lg:h-10 lg:w-10 object-contain rounded-lg shrink-0" src="/logo_t.png" />
            <span className="text-base sm:text-lg lg:text-xl font-bold text-primary tracking-tight font-headline truncate">
              MarkForYou<span className="hidden sm:inline">.com</span>
            </span>
          </div>
          <div className="hidden md:flex items-center gap-3 font-medium text-base shrink-0">
            <a className="px-5 py-2.5 rounded-full text-on-surface-variant hover:text-tertiary hover:bg-tertiary-container/50 transition-colors font-semibold whitespace-nowrap" href="#how-it-works">How it Works</a>
            <Link className="px-5 py-2.5 rounded-full border-2 border-primary text-primary font-bold hover:bg-primary hover:text-white transition-colors whitespace-nowrap" href="/login">Login</Link>
            <Link href="/signup" className="px-6 py-2.5 rounded-full bg-tertiary text-white font-bold hover:shadow-lg transition-all whitespace-nowrap">
              Try Free
            </Link>
          </div>
          <div className="md:hidden flex items-center gap-2 shrink-0">
            <Link href="/login" className="px-3 py-2 rounded-full border-2 border-primary text-primary font-bold text-sm hover:bg-primary hover:text-white transition-colors whitespace-nowrap">Login</Link>
            <Link href="/signup" className="px-3 py-2 rounded-full bg-tertiary text-white font-bold text-sm hover:shadow-lg transition-all whitespace-nowrap">
              Try Free
            </Link>
          </div>
        </div>
      </nav>

      <main className="pt-16 lg:pt-20">

        {/* ── Hero ────────────────────────────────────────────── */}
        <section className="relative pt-8 pb-10 md:pt-16 md:pb-14 px-6 warm-gradient overflow-hidden">
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
                MarkForYou <strong className="font-bold text-primary">instantly marks</strong> your child&apos;s <strong className="font-bold text-primary">written homework</strong>, <strong className="font-bold text-primary">spots their weak topics</strong> and builds the next custom practice automatically.<span className="hidden sm:inline"> Built by Singapore parents who were tired of marking.</span>
              </p>
              <p className="text-on-surface-variant text-sm md:text-base font-semibold mb-8 max-w-xl">
                Primary 4-6. Math, Science, English, Chinese. <span className="text-tertiary">Marking aligned with MOE scoring rubrics.</span>
              </p>
              <div className="flex flex-wrap gap-4">
                <Link href="/signup" className="w-full sm:w-auto text-center px-8 lg:px-10 py-4 bg-tertiary text-white font-bold rounded-full soft-glow hover:scale-105 transition-transform text-lg whitespace-nowrap">
                  Try now free
                </Link>
                <a href="#how-it-works" className="w-full sm:w-auto text-center px-8 lg:px-10 py-4 bg-white text-tertiary font-bold rounded-full border-2 border-tertiary hover:bg-tertiary hover:text-white transition-colors text-lg whitespace-nowrap">
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

        {/* ── Parent Quotes ───────────────────────────────────── */}
        {/* Moved up: parents hear other parents first. Layout is one
            featured quote, then a 4-card row below. All cards: white +
            thin neutral border + a small tertiary quote-mark icon. */}
        <section className="py-12 lg:py-20 bg-white px-6">
          <div className="max-w-6xl mx-auto">
            <div className="text-center mb-8 lg:mb-12">
              <span className="inline-block font-headline text-base md:text-lg font-extrabold text-tertiary tracking-[0.2em] mb-3">PARENTS SAY</span>
              <h2 className="font-headline text-3xl lg:text-5xl font-extrabold text-primary text-balance">What parents tell us</h2>
            </div>

            {/* Featured quote — Melissa's captures the whole problem-to-solution arc */}
            <figure className="relative bg-white border border-surface-container-high rounded-3xl p-8 md:p-12 mb-6 lg:mb-8 shadow-sm">
              <span className="material-symbols-outlined text-tertiary text-4xl lg:text-5xl mb-4 block" style={{ fontVariationSettings: "'FILL' 1" }}>format_quote</span>
              <blockquote>
                <p className="text-lg md:text-2xl text-on-surface leading-relaxed mb-6 font-medium">
                  MarkForYou takes the process every parent already does — buy test papers, hand them to your child, mark them, tag the mistakes, search for more practice — and simplifies all of it. That frees up my time to focus on the thing that actually matters: my child&apos;s learning journey.
                </p>
                <figcaption className="text-sm md:text-base font-bold text-primary">
                  — Melissa, <span className="text-on-surface-variant font-semibold">P6 Mum</span>
                </figcaption>
              </blockquote>
            </figure>

            {/* Grid of 4 supporting quotes */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6">
              <figure className="bg-white border border-surface-container-high rounded-2xl p-6 shadow-sm flex flex-col">
                <span className="material-symbols-outlined text-tertiary text-2xl mb-3" style={{ fontVariationSettings: "'FILL' 1" }}>format_quote</span>
                <blockquote className="flex-1 flex flex-col">
                  <p className="text-sm md:text-base text-on-surface leading-relaxed mb-4 flex-1">
                    As a P5 parent, MarkForYou gives me a clear snapshot of exactly where my child is struggling — by topic, not just by grade. We can zero in on those weak areas. Honestly, one of the smartest tools to have for PSLE prep!
                  </p>
                  <figcaption className="text-xs md:text-sm font-bold text-primary mt-auto">
                    — Elaine, <span className="text-on-surface-variant font-semibold">P5 Mum</span>
                  </figcaption>
                </blockquote>
              </figure>

              <figure className="bg-white border border-surface-container-high rounded-2xl p-6 shadow-sm flex flex-col">
                <span className="material-symbols-outlined text-tertiary text-2xl mb-3" style={{ fontVariationSettings: "'FILL' 1" }}>format_quote</span>
                <blockquote className="flex-1 flex flex-col">
                  <p className="text-sm md:text-base text-on-surface leading-relaxed mb-4 flex-1">
                    I really like that I can choose the topics I want my son to work on — and I&apos;m also reminded to review his weak topics after he&apos;s done.
                  </p>
                  <figcaption className="text-xs md:text-sm font-bold text-primary mt-auto">
                    — PY, <span className="text-on-surface-variant font-semibold">P6 Mum, Tiong Bahru</span>
                  </figcaption>
                </blockquote>
              </figure>

              <figure className="bg-white border border-surface-container-high rounded-2xl p-6 shadow-sm flex flex-col">
                <span className="material-symbols-outlined text-tertiary text-2xl mb-3" style={{ fontVariationSettings: "'FILL' 1" }}>format_quote</span>
                <blockquote className="flex-1 flex flex-col">
                  <p className="text-sm md:text-base text-on-surface leading-relaxed mb-4 flex-1">
                    Marking accurately handwritten work is really important. It replicates what my child actually does in a real exam setting.
                  </p>
                  <figcaption className="text-xs md:text-sm font-bold text-primary mt-auto">
                    — Peter, <span className="text-on-surface-variant font-semibold">P4 &amp; P6 Father, Hougang</span>
                  </figcaption>
                </blockquote>
              </figure>

              <figure className="bg-white border border-surface-container-high rounded-2xl p-6 shadow-sm flex flex-col">
                <span className="material-symbols-outlined text-tertiary text-2xl mb-3" style={{ fontVariationSettings: "'FILL' 1" }}>format_quote</span>
                <blockquote className="flex-1 flex flex-col">
                  <p className="text-sm md:text-base text-on-surface leading-relaxed mb-4 flex-1">
                    I absolutely love the revision function. The AI compiles my child&apos;s mistakes in a single platform — I no longer have to amass stacks of torn-out pages or worry about losing them!
                  </p>
                  <figcaption className="text-xs md:text-sm font-bold text-primary mt-auto">
                    — Jessica, <span className="text-on-surface-variant font-semibold">P5 Mum, Newton</span>
                  </figcaption>
                </blockquote>
              </figure>
            </div>
          </div>
        </section>

        {/* ── Value Prop ─────────────────────────────────────── */}
        {/* 4 features, each backed by a real product screenshot. White
            cards on a soft grey ground; image sits in an aspect-ratio
            holder so different source sizes still align cleanly. */}
        <section className="py-12 lg:py-20 bg-surface-container-low px-6">
          <div className="max-w-7xl mx-auto">
            <div className="text-center mb-10 lg:mb-14">
              <span className="inline-block font-headline text-base md:text-lg font-extrabold text-tertiary tracking-[0.2em] mb-3">WHY MARKFORYOU</span>
              <h2 className="font-headline text-3xl md:text-5xl font-extrabold text-primary mb-4 leading-tight text-balance">
                Built by parents who were tired of marking.
              </h2>
              <p className="text-base lg:text-lg text-on-surface-variant max-w-2xl mx-auto">
                You already know the drill: buy test papers, mark by hand, hunt for more practice on the weak spots. We rebuilt that loop so it runs in minutes, not hours.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 lg:gap-8">
              {/* Feature 1 — handwriting + partial credit */}
              <article className="bg-white border border-surface-container-high rounded-3xl shadow-sm overflow-hidden flex flex-col">
                <div className="aspect-[4/3] bg-surface-container-low flex items-center justify-center p-3 lg:p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img alt="Handwritten answers marked with partial credit" className="max-h-full max-w-full object-contain" src="/marking_combined.png" />
                </div>
                <div className="p-6 lg:p-8">
                  <h3 className="font-headline text-xl lg:text-2xl font-bold text-primary mb-2">Marks handwritten work — even messy</h3>
                  <p className="text-on-surface-variant text-sm lg:text-base leading-relaxed">Reads your child&apos;s writing and awards partial marks where they&apos;re earned, the way a teacher would.</p>
                </div>
              </article>

              {/* Feature 2 — explanation + non-key answers */}
              <article className="bg-white border border-surface-container-high rounded-3xl shadow-sm overflow-hidden flex flex-col">
                <div className="aspect-[4/3] bg-surface-container-low flex items-center justify-center p-3 lg:p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img alt="AI explanation accepting alternative correct answers" className="max-h-full max-w-full object-contain" src="/explanation.png" />
                </div>
                <div className="p-6 lg:p-8">
                  <h3 className="font-headline text-xl lg:text-2xl font-bold text-primary mb-2">Explains every answer — including yours</h3>
                  <p className="text-on-surface-variant text-sm lg:text-base leading-relaxed">Step-by-step working for every question. Accepts answers that aren&apos;t in the answer key but are grammatically and contextually correct.</p>
                </div>
              </article>

              {/* Feature 3 — weak topics + focused practice */}
              <article className="bg-white border border-surface-container-high rounded-3xl shadow-sm overflow-hidden flex flex-col">
                <div className="aspect-[4/3] bg-surface-container-low flex items-center justify-center p-3 lg:p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img alt="Weak topics dashboard with focused practice" className="max-h-full max-w-full object-contain" src="/weaktopics.png" />
                </div>
                <div className="p-6 lg:p-8">
                  <h3 className="font-headline text-xl lg:text-2xl font-bold text-primary mb-2">Pinpoints weak topics — and what to do next</h3>
                  <p className="text-on-surface-variant text-sm lg:text-base leading-relaxed">No more hunting for &ldquo;more like this&rdquo;. The dashboard tells you which topics are weak and queues a focused practice on each.</p>
                </div>
              </article>

              {/* Feature 4 — accuracy + MOE rubric */}
              <article className="bg-white border border-surface-container-high rounded-3xl shadow-sm overflow-hidden flex flex-col">
                <div className="aspect-[4/3] bg-surface-container-low flex items-center justify-center p-3 lg:p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img alt="Marking accuracy chart" className="max-h-full max-w-full object-contain" src="/accuracy.png" />
                </div>
                <div className="p-6 lg:p-8">
                  <h3 className="font-headline text-xl lg:text-2xl font-bold text-primary mb-2">Marking accuracy you can trust</h3>
                  <p className="text-on-surface-variant text-sm lg:text-base leading-relaxed">Aligned with MOE scoring rubrics. We track marking accuracy across every release.</p>
                </div>
              </article>
            </div>
          </div>
        </section>

        {/* ── How it Works ───────────────────────────────────── */}
        {/* 3-step strip + demo video. The features section that used to
            sit separately (3,000+ questions, handwriting, marks in
            seconds) now lives inside the step copy + stat strip. */}
        <section className="py-12 lg:py-20 bg-white px-6" id="how-it-works">
          <div className="max-w-6xl mx-auto">
            <div className="text-center mb-8 lg:mb-12">
              <span className="inline-block font-headline text-base md:text-lg font-extrabold text-tertiary tracking-[0.2em] mb-3">HOW IT WORKS</span>
              <h2 className="font-headline text-3xl lg:text-5xl font-extrabold text-primary text-balance">Three steps, no marking required</h2>
            </div>

            {/* Step cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5 lg:gap-6 mb-10 lg:mb-14">
              <div className="bg-white border border-surface-container-high rounded-2xl p-6 lg:p-8 flex flex-col items-center text-center shadow-sm">
                <span className="font-headline text-3xl font-extrabold text-tertiary mb-3">01</span>
                <span className="material-symbols-outlined text-primary text-3xl mb-4" style={{ fontVariationSettings: "'FILL' 1" }}>edit_square</span>
                <h3 className="font-headline text-lg lg:text-xl font-bold text-primary mb-2">Your child does a quiz</h3>
                <p className="text-on-surface-variant text-sm lg:text-base">Tap MCQs or write naturally on the canvas — same as in an exam.</p>
              </div>
              <div className="bg-white border border-surface-container-high rounded-2xl p-6 lg:p-8 flex flex-col items-center text-center shadow-sm">
                <span className="font-headline text-3xl font-extrabold text-tertiary mb-3">02</span>
                <span className="material-symbols-outlined text-primary text-3xl mb-4" style={{ fontVariationSettings: "'FILL' 1" }}>edit_note</span>
                <h3 className="font-headline text-lg lg:text-xl font-bold text-primary mb-2">AI marks it in seconds</h3>
                <p className="text-on-surface-variant text-sm lg:text-base">Reads handwriting. Returns step-by-step feedback and partial credit — aligned with <strong className="text-primary">MOE scoring rubrics</strong>.</p>
              </div>
              <div className="bg-white border border-surface-container-high rounded-2xl p-6 lg:p-8 flex flex-col items-center text-center shadow-sm">
                <span className="font-headline text-3xl font-extrabold text-tertiary mb-3">03</span>
                <span className="material-symbols-outlined text-primary text-3xl mb-4" style={{ fontVariationSettings: "'FILL' 1" }}>auto_fix_high</span>
                <h3 className="font-headline text-lg lg:text-xl font-bold text-primary mb-2">A 10-min drill on the weak spots</h3>
                <p className="text-on-surface-variant text-sm lg:text-base">Targeted practice generated automatically — tailored while they wait for the school bus.</p>
              </div>
            </div>

            {/* Stat strip — replaces the old separate Features section */}
            <div className="flex flex-wrap justify-center items-center gap-x-6 gap-y-2 text-sm md:text-base font-bold text-primary mb-8 lg:mb-12">
              <span>8,000+ questions</span>
              <span className="text-tertiary">&bull;</span>
              <span>Math, Science, English, Chinese</span>
              <span className="text-tertiary">&bull;</span>
              <span>MOE rubric-aligned marking</span>
              <span className="text-tertiary">&bull;</span>
              <span>Handwriting-friendly</span>
            </div>

            {/* Demo video */}
            <div className="relative aspect-video rounded-3xl overflow-hidden shadow-2xl bg-black">
              <video
                className="w-full h-full object-cover"
                controls
                preload="metadata"
                poster="/democover.png"
              >
                <source src="/MFY V3.mp4" type="video/mp4" />
              </video>
            </div>
          </div>
        </section>

        {/* ── FAQ ────────────────────────────────────────────── */}
        <section className="py-12 lg:py-20 bg-surface-container-low px-6">
          <div className="max-w-3xl mx-auto">
            <div className="text-center mb-8 lg:mb-12">
              <span className="inline-block font-headline text-base md:text-lg font-extrabold text-tertiary tracking-[0.2em] mb-3">FAQ</span>
              <h2 className="font-headline text-3xl lg:text-5xl font-extrabold text-primary">Common questions</h2>
            </div>
            <div className="space-y-3">
              {[
                { q: "What subjects and levels are covered?", a: "We currently support Primary 4 to 6 English, Mathematics, and Science, all strictly aligned with the latest MOE syllabus." },
                { q: "How much does it cost?", a: "MarkForYou is currently FREE during our beta period. Our priority is ensuring the best experience for families before we introduce pricing." },
                { q: "How does the AI marking work?", a: "Students complete quizzes directly on their device. They can tap options for MCQs or write naturally on a digital canvas for open-ended questions. Our AI is trained to read handwriting and provide a grade within seconds." },
              ].map((faq, i) => (
                <details key={i} className="group bg-white rounded-2xl border border-surface-container-high shadow-sm">
                  <summary className="flex items-center justify-between gap-4 px-6 py-4 cursor-pointer list-none font-headline text-base lg:text-lg font-bold text-primary hover:text-tertiary transition-colors">
                    {faq.q}
                    <span className="material-symbols-outlined text-on-surface-variant group-open:rotate-180 transition-transform shrink-0">expand_more</span>
                  </summary>
                  <div className="px-6 pb-4 -mt-1">
                    <p className="text-on-surface-variant leading-relaxed">{faq.a}</p>
                  </div>
                </details>
              ))}
            </div>
            <div className="text-center mt-6">
              <Link href="/faq" className="text-sm font-bold text-tertiary hover:text-primary transition-colors">
                View all FAQs &rarr;
              </Link>
            </div>
          </div>
        </section>

        {/* ── CTA ────────────────────────────────────────────── */}
        <section className="py-12 lg:py-20 px-6 bg-white">
          <div className="max-w-5xl mx-auto bg-tertiary-container rounded-[3rem] p-8 md:p-14 text-center relative overflow-hidden soft-glow">
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
              <h2 className="font-headline text-2xl md:text-5xl font-extrabold text-primary mb-5 lg:mb-6">
                Stop marking. <span className="text-tertiary">Start coaching.</span>
              </h2>
              <p className="text-on-tertiary-container text-base md:text-xl mb-8 lg:mb-10 max-w-2xl mx-auto">
                Try now and see your child&apos;s homework marked instantly, weak spots identified and next steps recommended. FREE, no credit card.
              </p>
              <div className="flex justify-center">
                <Link href="/signup" className="w-full sm:w-auto px-12 py-5 bg-tertiary text-white font-extrabold rounded-full text-lg hover:opacity-90 transition-opacity shadow-lg">
                  Try now FREE
                </Link>
              </div>
            </div>
          </div>
        </section>

      </main>

      {/* ── Footer ── */}
      <footer className="bg-surface-container-low pt-10 lg:pt-14 pb-8 px-6 border-t border-surface-container">
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
                <li><a className="hover:text-tertiary transition-colors" href="#how-it-works">How it Works</a></li>
              </ul>
            </div>
            <div>
              <h4 className="font-bold text-primary mb-4">Company</h4>
              <ul className="space-y-3 text-sm text-on-surface-variant">
                <li><Link className="hover:text-tertiary transition-colors" href="/about">About Us</Link></li>
                <li><Link className="hover:text-tertiary transition-colors" href="/faq">FAQ</Link></li>
                <li><a className="hover:text-tertiary transition-colors" href="mailto:hello@markforyou.com">Contact Us</a></li>
                <li><Link className="hover:text-tertiary transition-colors" href="/privacy">Privacy</Link></li>
                <li><Link className="hover:text-tertiary transition-colors" href="/terms">Terms</Link></li>
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
              <li><a className="hover:text-tertiary transition-colors" href="#how-it-works">How it Works</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-bold text-primary mb-6">Company</h4>
            <ul className="space-y-4 text-sm text-on-surface-variant">
              <li><Link className="hover:text-tertiary transition-colors" href="/about">About Us</Link></li>
              <li><a className="hover:text-tertiary transition-colors" href="mailto:hello@markforyou.com">Contact Us</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-bold text-primary mb-6">Legal</h4>
            <ul className="space-y-4 text-sm text-on-surface-variant">
              <li><Link className="hover:text-tertiary transition-colors" href="/privacy">Privacy Policy</Link></li>
              <li><Link className="hover:text-tertiary transition-colors" href="/terms">Terms of Use</Link></li>
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
