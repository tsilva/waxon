import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flashcarder",
  description: "Fast free-text flashcard review",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
