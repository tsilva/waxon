import {
  ClerkProvider,
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/nextjs";
import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "waxon",
  description: "Fast free-text flashcard review",
};

const googleAnalyticsId = "G-25GH510YWE";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <ClerkProvider>
          <header className="auth-bar" aria-label="Account">
            <Show when="signed-out">
              <div className="auth-actions">
                <SignInButton>
                  <button className="auth-action" type="button">
                    Sign in
                  </button>
                </SignInButton>
                <SignUpButton>
                  <button className="auth-action auth-action-primary" type="button">
                    Sign up
                  </button>
                </SignUpButton>
              </div>
            </Show>
            <Show when="signed-in">
              <UserButton />
            </Show>
          </header>
          {children}
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${googleAnalyticsId}`}
            strategy="afterInteractive"
          />
          <Script id="google-analytics" strategy="afterInteractive">
            {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', '${googleAnalyticsId}');
            `}
          </Script>
        </ClerkProvider>
      </body>
    </html>
  );
}
