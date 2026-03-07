import type { Metadata } from "next";
import Image from "next/image";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mark for You",
  description: "Let AI do the heavy-lifting",
  metadataBase: new URL("https://markforyou.com"),
  openGraph: {
    title: "Mark for You",
    description: "Let AI do the heavy-lifting",
    siteName: "Mark for You",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50">
        <div className="mx-auto max-w-lg min-h-screen bg-white shadow-sm">
          {/* Branding bar */}
          <div className="flex items-center gap-3 px-4 py-2" style={{ backgroundColor: "#b8daf0" }}>
            <Image src="/logo.png" alt="Mark for You" width={40} height={40} className="rounded-full" />
            <div>
              <h1 className="text-sm font-bold text-slate-800 leading-tight">Mark for You</h1>
              <p className="text-[11px] text-slate-600">Let AI do the heavy-lifting</p>
            </div>
          </div>
          {children}
        </div>
      </body>
    </html>
  );
}
