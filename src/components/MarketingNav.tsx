import Link from "next/link";

// Shared top-of-page nav for the marketing surfaces (/, /about, /faq,
// /privacy, /terms). Kept structurally identical to the homepage's
// inline nav so brand sizing, button shapes and palette read the same
// across every public page. The homepage doesn't use this component
// because it has a special "How it Works" anchor link that other
// pages don't need.
export default function MarketingNav() {
  return (
    <nav className="fixed top-0 w-full z-50 bg-background/80 backdrop-blur-md border-b border-surface-container">
      <div className="flex justify-between items-center h-16 lg:h-20 px-6 max-w-7xl mx-auto">
        <Link href="/" className="flex items-center gap-2 lg:gap-3 min-w-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="MarkForYou Logo" className="h-8 w-8 lg:h-10 lg:w-10 object-contain rounded-lg shrink-0" src="/logo_t.png" />
          <span className="text-base sm:text-lg lg:text-xl font-bold text-primary tracking-tight font-headline truncate">
            MarkForYou<span className="hidden sm:inline">.com</span>
          </span>
        </Link>
        {/* Desktop */}
        <div className="hidden md:flex items-center gap-3 font-medium text-base shrink-0">
          <Link className="px-5 py-2.5 rounded-full border-2 border-primary text-primary font-bold hover:bg-primary hover:text-white transition-colors whitespace-nowrap" href="/login">Login</Link>
          <Link href="/signup" className="px-6 py-2.5 rounded-full bg-secondary text-white font-bold hover:shadow-lg transition-all whitespace-nowrap">
            Try Free
          </Link>
        </div>
        {/* Mobile */}
        <div className="md:hidden flex items-center gap-2 shrink-0">
          <Link href="/login" className="px-3 py-2 rounded-full border-2 border-primary text-primary font-bold text-sm hover:bg-primary hover:text-white transition-colors whitespace-nowrap">Login</Link>
          <Link href="/signup" className="px-3 py-2 rounded-full bg-secondary text-white font-bold text-sm hover:shadow-lg transition-all whitespace-nowrap">
            Try Free
          </Link>
        </div>
      </div>
    </nav>
  );
}
