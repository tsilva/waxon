import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { Providers } from "./Providers";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  ),
  title: "waxon",
  description: "Fast free-text flashcard review",
  manifest: "/brand/web-seo/site.webmanifest",
  icons: {
    icon: [
      {
        url: "/favicon.ico",
        sizes: "48x48",
        type: "image/x-icon",
      },
      {
        url: "/brand/web-seo/favicon/favicon-16.png",
        sizes: "16x16",
        type: "image/png",
      },
      {
        url: "/brand/web-seo/favicon/favicon-32.png",
        sizes: "32x32",
        type: "image/png",
      },
      {
        url: "/brand/web-seo/favicon/favicon-48.png",
        sizes: "48x48",
        type: "image/png",
      },
    ],
    apple: [
      {
        url: "/brand/web-seo/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  openGraph: {
    title: "waxon",
    description: "Fast free-text flashcard review",
    images: [
      {
        url: "/brand/web-seo/og-image-1200x630.png",
        width: 1200,
        height: 630,
        alt: "waxon",
      },
    ],
  },
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#fef9ed",
};

const googleAnalyticsId = "G-25GH510YWE";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://microsoft.ai" crossOrigin="" />
      </head>
      <body>
        <Providers>{children}</Providers>
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${googleAnalyticsId}`}
          strategy="lazyOnload"
        />
        <Script id="google-analytics" strategy="lazyOnload">
          {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', '${googleAnalyticsId}');
            `}
        </Script>
      </body>
    </html>
  );
}
