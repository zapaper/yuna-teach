import Link from "next/link";

export const metadata = {
  title: "About Us | MarkForYou.com",
  description: "Why we built MarkForYou — a parent-made tool for Singapore primary school parents.",
};

export default function AboutPage() {
  return (
    <div className="bg-background text-on-surface font-body min-h-screen">
      {/* ── TopNavBar ── */}
      <nav className="fixed top-0 w-full z-50 bg-background/80 backdrop-blur-md border-b border-surface-container">
        <div className="flex justify-between items-center h-16 lg:h-20 px-6 max-w-7xl mx-auto">
          <Link href="/" className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="MarkForYou Logo" className="h-8 w-8 lg:h-10 lg:w-10 object-contain rounded-lg" src="/logo_t.png" />
            <span className="text-lg lg:text-xl font-bold text-primary tracking-tight font-headline">MarkForYou.com</span>
          </Link>
          <div className="hidden md:flex items-center gap-8 font-medium text-sm">
            <Link className="text-on-surface-variant hover:text-tertiary transition-colors" href="/">Home</Link>
            <Link className="text-on-surface-variant hover:text-tertiary transition-colors" href="/login">Login</Link>
            <Link href="/signup" className="px-6 py-2.5 rounded-full bg-secondary text-white font-bold hover:shadow-lg transition-all text-sm">
              Try Free
            </Link>
          </div>
          <div className="md:hidden flex items-center gap-3">
            <Link href="/login" className="text-xs text-on-surface-variant hover:text-tertiary transition-colors font-medium">Login</Link>
            <Link href="/signup" className="px-4 py-2 rounded-full bg-secondary text-white font-bold hover:shadow-lg transition-all text-xs">
              Try Free
            </Link>
          </div>
        </div>
      </nav>

      <main className="pt-16 lg:pt-20">
        <section className="py-14 lg:py-20 px-6 warm-gradient">
          <div className="max-w-3xl mx-auto">
            <span className="inline-block font-headline text-base md:text-lg font-extrabold text-tertiary tracking-[0.2em] mb-3">ABOUT US</span>
            <h1 className="font-headline text-3xl md:text-5xl font-extrabold text-primary leading-tight mb-8 text-balance">
              Built by parents, at the dining table.
            </h1>

            <div className="space-y-6 text-base md:text-lg text-on-surface-variant leading-relaxed">
              <p>
                We built MarkForYou after marking our own kids&apos; papers and hunting for more appropriate practices at 11pm on a Sunday.
              </p>
              <p>
                Between tuition bills, endless assessment books, and searching for &ldquo;one more similar question,&rdquo; we were spending more time on admin than actually helping our kids learn. Every tool we tried was built by a company for a school. None were built for the parent sitting at the dining table with a red pen and a cup of kopi-O.
              </p>
              <p>
                So we made our own. MarkForYou does the marking and the &ldquo;what&apos;s next?&rdquo; — you get to be the parent again.
              </p>
              <p>
                We are still in the building phase, training our AI model with more and more top school papers. At this stage, your feedback is most appreciated.
              </p>
              <p className="font-bold text-primary">
                — The MarkForYou team, Singapore
              </p>
            </div>

            <div className="mt-12 flex flex-wrap gap-4">
              <Link href="/signup" className="px-10 py-4 bg-tertiary text-white font-bold rounded-full soft-glow hover:scale-105 transition-transform text-lg">
                Try now free
              </Link>
              <Link href="/" className="px-10 py-4 bg-white text-tertiary font-bold rounded-full border-2 border-tertiary hover:bg-tertiary hover:text-white transition-colors text-lg">
                Back to home
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="bg-surface-container-low pt-10 pb-8 px-6 border-t border-surface-container">
        <div className="max-w-7xl mx-auto text-center text-xs text-on-surface-variant/60">
          <p>© 2025 MarkForYou.com. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
