import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, Inter } from "next/font/google";
import "./globals.css";

// Self-hosted via Next so the body text doesn't render as Times New
// Roman for ~150ms while Google Fonts loads. Both families end up as
// CSS variables that globals.css references.
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-jakarta",
  display: "swap",
});
const inter = Inter({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-inter",
  display: "swap",
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
        {/* Material Symbols stays on the CDN — it's an icon font and the
            initial render typically doesn't depend on it. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap" rel="stylesheet" />
      </head>
      <body className="min-h-screen">
        {children}
      </body>
    </html>
  );
}
