import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mark for You",
  description: "Let AI do the heavy-lifting",
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
          {children}
        </div>
      </body>
    </html>
  );
}
