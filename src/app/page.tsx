import Link from "next/link";
import NativeLandingBouncer from "@/components/NativeLandingBouncer";
import MarketingNav from "@/components/MarketingNav";
import FeatureCarousel from "@/components/FeatureCarousel";
import QuoteCarousel from "@/components/QuoteCarousel";

// Quote text supports **bold** markdown markers. QuoteCarousel parses
// them into <strong> spans. Used to emphasise the share-worthy phrases
// without rewriting the surrounding prose.
const QUOTES = [
  {
    text: "MarkForYou takes the process every parent already does — buy test papers, hand them to your child, mark them, tag the mistakes, search for more practice — and **simplifies all of it**. That frees up my time to focus on the thing that actually matters: **my child's learning journey**.",
    name: "Melissa",
    attribution: "P6 Mum",
  },
  {
    text: "I really like that I can **choose the topics** I want my son to work on — and I'm also **reminded to review his weak topics** after he's done.",
    name: "PY",
    attribution: "P6 Mum",
  },
  {
    text: "As a P5 parent, MarkForYou gives me a clear snapshot of exactly where my child is struggling — **by topic, not just by grade**. We can zero in on those weak areas. Honestly, one of the **smartest tools to have for PSLE prep**!",
    name: "Elaine",
    attribution: "P5 Mum",
  },
  {
    text: "**Marking accurately handwritten work is really important.** It replicates what my child actually does in a **real exam setting**.",
    name: "Peter",
    attribution: "P4 & P6 Father",
  },
  {
    text: "I absolutely love the **revision function**. The AI **compiles my child's mistakes in a single platform** — I no longer have to amass stacks of torn-out pages or worry about losing them!",
    name: "Jessica",
    attribution: "P5 Mum",
  },
];

const FEATURES = [
  {
    src: "/marking_combined.png",
    alt: "Handwritten answers marked with partial credit",
    title: "Marks handwritten work — even messy ones",
    description: "Reads handwriting and awards partial marks the way a teacher would.",
  },
  {
    src: "/explanation.png",
    alt: "AI explanation accepting alternative correct answers",
    title: "Explains every answer — in detail",
    description: "Step-by-step working. Accepts correct answers that aren't in the answer key.",
  },
  {
    src: "/weaktopics.png",
    alt: "Weak topics dashboard with focused practice",
    title: "Pinpoints weak topics",
    description: "Tells you which topics are weak and creates a focused practice on each.",
  },
  {
    src: "/accuracy2.png",
    alt: "Marking accuracy benchmarked against top AI models",
    title: "Marking accuracy you can trust",
    description: "Aligned with MOE rubrics. Benchmarked against the top AI models.",
  },
];

export default function HomePage() {
  return (
    <div className="bg-background text-on-surface font-body selection:bg-secondary-container">
      {/* iOS Capacitor only — redirects the app's cold-launch from
          the marketing page straight to /login. No-op on web. */}
      <NativeLandingBouncer />

      <MarketingNav />

      <main className="pt-16 lg:pt-20">

        {/* ── Hero ────────────────────────────────────────────── */}
        <section className="relative pt-8 pb-10 md:pt-16 md:pb-14 px-6 warm-gradient overflow-hidden">
          <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-12 items-center">
            <div className="relative z-10">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-secondary-container text-on-secondary-container font-semibold text-xs mb-6 uppercase tracking-wider">
                <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>favorite</span>
                Built for Parents, By Parents
              </div>
              <h1 className="font-headline text-3xl md:text-6xl font-extrabold text-primary leading-tight mb-5 text-balance">
                Stop marking. <span className="text-secondary">Start coaching.</span>
              </h1>
              <p className="text-on-surface-variant text-base md:text-xl leading-relaxed mb-4 max-w-xl">
                MarkForYou <strong className="font-bold text-primary">instantly marks</strong> your child&apos;s <strong className="font-bold text-primary">written homework</strong>, <strong className="font-bold text-primary">spots their weak topics</strong> and builds the next custom practice automatically.<span className="hidden sm:inline"> Built by Singapore parents who were tired of marking.</span>
              </p>
              <p className="text-on-surface-variant text-sm md:text-base font-semibold mb-8 max-w-xl">
                Primary 4-6. Math, Science, English, Chinese. <span className="text-secondary">Marking aligned with MOE scoring rubrics.</span>
              </p>
              <div className="flex flex-wrap gap-4">
                <Link href="/signup" className="w-full sm:w-auto text-center px-8 lg:px-10 py-4 bg-secondary text-white font-bold rounded-full soft-glow hover:scale-105 transition-transform text-lg whitespace-nowrap">
                  Try now free
                </Link>
                <a href="#how-it-works" className="w-full sm:w-auto text-center px-8 lg:px-10 py-4 bg-white text-secondary font-bold rounded-full border-2 border-secondary hover:bg-secondary hover:text-white transition-colors text-lg whitespace-nowrap">
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
        {/* All 5 quotes in a single swipe carousel — no featured-on-top
            layout. Same swipe + arrow + dot UX as the feature carousel. */}
        <section className="py-12 lg:py-20 bg-surface-container-low px-6">
          <div className="max-w-6xl mx-auto">
            <div className="text-center mb-8 lg:mb-12">
              <h2 className="font-headline text-3xl lg:text-5xl font-extrabold text-primary text-balance">Hear from Real Parents</h2>
            </div>
            <QuoteCarousel items={QUOTES} />
          </div>
        </section>

        {/* ── Value Prop ─────────────────────────────────────── */}
        {/* 4 features, each backed by a real product screenshot. White
            cards on a soft grey ground; image sits in an aspect-ratio
            holder so different source sizes still align cleanly. */}
        <section className="py-12 lg:py-20 bg-surface-container-low px-6">
          <div className="max-w-7xl mx-auto">
            <div className="text-center mb-10 lg:mb-14">
              <span className="inline-block font-headline text-base md:text-lg font-extrabold text-secondary tracking-[0.2em] mb-3">WHY MARKFORYOU</span>
              <h2 className="font-headline text-3xl md:text-5xl font-extrabold text-primary mb-4 leading-tight text-balance">
                Built by parents who were tired of marking.
              </h2>
              <p className="text-base lg:text-lg text-on-surface-variant max-w-2xl mx-auto">
                Instantly marks handwritten work and generates focused practices on your child&apos;s weak areas.
              </p>
            </div>

            <FeatureCarousel items={FEATURES} />
          </div>
        </section>

        {/* ── How it Works ───────────────────────────────────── */}
        {/* Single question-answer headline + stat strip + demo video.
            The 3-step card strip was retired — the value-prop carousel
            above already covers what each piece does. */}
        <section className="py-12 lg:py-20 bg-white px-6" id="how-it-works">
          <div className="max-w-6xl mx-auto">
            <div className="text-center mb-8 lg:mb-12 max-w-4xl mx-auto">
              <span className="inline-block font-headline text-base md:text-lg font-extrabold text-secondary tracking-[0.2em] mb-3">HOW IT WORKS</span>
              <h2 className="font-headline text-2xl md:text-3xl lg:text-4xl font-extrabold text-primary mb-5 leading-tight text-balance">
                A <span className="text-secondary">10-minute</span> quiz on <span className="text-secondary">mobile</span>, or a full exam-style <span className="text-secondary">handwritten paper</span>?
              </h2>
              <p className="text-base lg:text-xl text-on-surface-variant leading-relaxed">
                <strong className="text-primary font-bold">Either way, your choice.</strong> Both will be instantly marked against <strong className="text-primary font-bold">MOE scoring rubrics</strong>, with <strong className="text-primary font-bold">step-by-step explanation</strong>.
              </p>
            </div>

            {/* Stat strip */}
            <div className="flex flex-wrap justify-center items-center gap-x-6 gap-y-2 text-sm md:text-base font-bold text-primary mb-8 lg:mb-12">
              <span>8,000+ questions</span>
              <span className="text-secondary">&bull;</span>
              <span>Math, Science, English, Chinese</span>
              <span className="text-secondary">&bull;</span>
              <span>MOE rubric-aligned marking</span>
              <span className="text-secondary">&bull;</span>
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
              <span className="inline-block font-headline text-base md:text-lg font-extrabold text-secondary tracking-[0.2em] mb-3">FAQ</span>
              <h2 className="font-headline text-3xl lg:text-5xl font-extrabold text-primary">Common questions</h2>
            </div>
            <div className="space-y-3">
              {[
                { q: "What subjects and levels are covered?", a: "We currently support Primary 4 to 6 English, Mathematics, Science and Chinese, all strictly aligned with the latest MOE syllabus." },
                { q: "How much does it cost?", a: "MarkForYou is currently FREE during our beta period. Our priority is ensuring the best experience for families before we introduce pricing." },
                { q: "How does the AI marking work?", a: "Students complete quizzes directly on their device or on printed worksheets. Our AI is trained to read handwriting, understand MOE scoring rubrics, and marks within seconds." },
              ].map((faq, i) => (
                <details key={i} className="group bg-white rounded-2xl border border-surface-container-high shadow-sm">
                  <summary className="flex items-center justify-between gap-4 px-6 py-4 cursor-pointer list-none font-headline text-base lg:text-lg font-bold text-primary hover:text-secondary transition-colors">
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
              <Link href="/faq" className="text-sm font-bold text-secondary hover:text-primary transition-colors">
                View all FAQs &rarr;
              </Link>
            </div>
          </div>
        </section>

        {/* ── CTA ────────────────────────────────────────────── */}
        <section className="py-12 lg:py-20 px-6 bg-surface-container-low">
          <div className="max-w-2xl mx-auto text-center">
            <p className="text-on-surface text-base md:text-xl mb-8 lg:mb-10">
              Try now and see your child&apos;s homework marked instantly, weak spots identified and next steps recommended. FREE, no credit card required.
            </p>
            <Link href="/signup" className="inline-block px-12 py-5 bg-secondary text-white font-extrabold rounded-full text-lg hover:opacity-90 transition-opacity shadow-lg">
              Try now FREE
            </Link>
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
                <li><a className="hover:text-secondary transition-colors" href="#how-it-works">How it Works</a></li>
              </ul>
            </div>
            <div>
              <h4 className="font-bold text-primary mb-4">Company</h4>
              <ul className="space-y-3 text-sm text-on-surface-variant">
                <li><Link className="hover:text-secondary transition-colors" href="/about">About Us</Link></li>
                <li><Link className="hover:text-secondary transition-colors" href="/faq">FAQ</Link></li>
                <li><a className="hover:text-secondary transition-colors" href="mailto:hello@markforyou.com">Contact Us</a></li>
                <li><Link className="hover:text-secondary transition-colors" href="/privacy">Privacy</Link></li>
                <li><Link className="hover:text-secondary transition-colors" href="/terms">Terms</Link></li>
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
              <li><a className="hover:text-secondary transition-colors" href="#how-it-works">How it Works</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-bold text-primary mb-6">Company</h4>
            <ul className="space-y-4 text-sm text-on-surface-variant">
              <li><Link className="hover:text-secondary transition-colors" href="/about">About Us</Link></li>
              <li><a className="hover:text-secondary transition-colors" href="mailto:hello@markforyou.com">Contact Us</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-bold text-primary mb-6">Legal</h4>
            <ul className="space-y-4 text-sm text-on-surface-variant">
              <li><Link className="hover:text-secondary transition-colors" href="/privacy">Privacy Policy</Link></li>
              <li><Link className="hover:text-secondary transition-colors" href="/terms">Terms of Use</Link></li>
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
