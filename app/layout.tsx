import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Brivviant | مساحة الفريق",
  description: "إدارة التاسكات ووقت العمل والتسليمات لفريق Brivviant Studios.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl">
      <body className="antialiased">{children}</body>
    </html>
  );
}
