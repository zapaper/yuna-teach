import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export const metadata: Metadata = {
  title: "Mark for You",
  description: "Let AI help with your child's learning gaps.",
  metadataBase: new URL("https://markforyou.com"),
  openGraph: {
    title: "Mark for You",
    description: "Let AI help with your child's learning gaps.",
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
        <div className="mx-auto max-w-lg lg:max-w-none min-h-screen bg-white shadow-sm">
          {children}
        </div>
      </body>
    </html>
  );
}
