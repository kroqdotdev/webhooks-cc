import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ConvexAuthProvider } from "@/components/providers/convex-auth-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: {
    default: "webhooks.cc - Inspect webhooks instantly",
    template: "%s | webhooks.cc",
  },
  description:
    "The fastest way to debug webhooks. Get a URL in one click, inspect requests in real-time, forward to localhost.",
  metadataBase: new URL("https://webhooks.cc"),
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://webhooks.cc",
    siteName: "webhooks.cc",
    title: "webhooks.cc - Inspect webhooks instantly",
    description:
      "The fastest way to debug webhooks. Get a URL in one click, inspect requests in real-time, forward to localhost.",
  },
  twitter: {
    card: "summary_large_image",
    title: "webhooks.cc - Inspect webhooks instantly",
    description:
      "The fastest way to debug webhooks. Get a URL in one click, inspect requests in real-time, forward to localhost.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                const stored = localStorage.getItem('theme');
                const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                const isDark = stored === 'dark' || (stored !== 'light' && prefersDark);
                if (isDark) document.documentElement.classList.add('dark');
              })();
            `,
          }}
        />
      </head>
      <body className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} font-sans`}>
        <ThemeProvider>
          <ConvexAuthProvider>{children}</ConvexAuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
