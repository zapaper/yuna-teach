import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, Inter } from "next/font/google";
import "./globals.css";
import ChunkErrorReloader from "@/components/ChunkErrorReloader";
import OfflineOverlay from "@/components/OfflineOverlay";

// Inline pre-paint redirect for the Capacitor iOS shell. WKWebView
// injects `window.Capacitor` before any HTML is parsed; checking
// for it in a synchronous <script> in <head> lets us redirect
// straight to /login BEFORE the marketing page paints. Without
// this script the iOS app cold-launched onto the marketing page
// for ~300ms before the React-side NativeLandingBouncer fired,
// which the user described as "briefly shows homepage before
// going to login page." Web users (no `window.Capacitor`) fall
// through unchanged.
//
// Only fires when location.pathname is exactly "/" — every other
// route is reached intentionally and shouldn't be bumped to login.
const NATIVE_HOME_REDIRECT_SCRIPT = `
(function(){
  try {
    var w = window;
    if (!w.Capacitor || typeof w.Capacitor.isNativePlatform !== 'function') return;
    if (!w.Capacitor.isNativePlatform()) return;
    if (w.location.pathname !== '/' && w.location.pathname !== '') return;
    w.location.replace('/login');
  } catch (e) { /* fall through to React-side bouncer */ }
})();
`;

// Self-hosted via Next so the body text doesn't render as Times New
// Roman for ~150ms while Google Fonts loads. Both families end up as
// CSS variables that globals.css references.
//
// display: "optional" eliminates the visible swap on cold load — the
// browser waits ~100ms for the local (cached) font; if it's not ready
// it shows the size-adjusted fallback for that session. On modern
// broadband + self-hosted next/font, the local font is ALWAYS ready
// in time, so users see Jakarta from first paint. With "swap" they
// were seeing system-fallback → Jakarta swap on every cold load.
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-jakarta",
  display: "optional",
});
const inter = Inter({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-inter",
  display: "optional",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export const metadata: Metadata = {
  title: "MarkForYou.com | Empowering Your Child's Learning Journey",
  description: "Targeted practice to accelerate your child's mastery of Math, Science and English.",
  metadataBase: new URL("https://markforyou.com"),
  openGraph: {
    title: "MarkForYou.com",
    description: "Targeted practice to accelerate your child's mastery of Math, Science and English.",
    siteName: "MarkForYou.com",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`scroll-smooth ${jakarta.variable} ${inter.variable}`}>
      <head>
        {/* iOS-only synchronous redirect — runs before any paint.
            See NATIVE_HOME_REDIRECT_SCRIPT comment above. */}
        <script dangerouslySetInnerHTML={{ __html: NATIVE_HOME_REDIRECT_SCRIPT }} />
        {/* Material Symbols stays on the CDN — it's an icon font and the
            initial render typically doesn't depend on it. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* Material Symbols (icon font). Was display=swap which let every
            <span class="material-symbols-outlined">lock</span> briefly
            render as the LITERAL TEXT "lock" / "person" / "mail" in a
            system font before the icon font arrived — the "funny font"
            flash on cold loads. display=block keeps the text invisible
            for up to 3s while the font loads (icon-font-FOUT standard
            mitigation); on modern broadband with browser cache the
            font is virtually always ready in time. */}
        <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block" rel="stylesheet" />
      </head>
      <body className="min-h-screen">
        <ChunkErrorReloader />
        <OfflineOverlay />
        {children}
      </body>
    </html>
  );
}
