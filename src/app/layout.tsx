import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Yuna Teach - Spelling Test",
  description: "Help primary school students practice for spelling tests and 听写",
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
