import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import {
  DEFAULT_OG_IMAGE_PATH,
  DEFAULT_PAGE_DESCRIPTION,
  DEFAULT_PAGE_TITLE,
  SITE_NAME,
  SITE_URL,
} from "@/lib/seo";
import { JsonLd, organizationSchema } from "@/lib/schemas";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

const googleSiteVerification =
  process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION || process.env.GOOGLE_SITE_VERIFICATION;
const bingSiteVerification =
  process.env.NEXT_PUBLIC_BING_SITE_VERIFICATION || process.env.BING_SITE_VERIFICATION;

export const metadata: Metadata = {
  title: {
    default: DEFAULT_PAGE_TITLE,
    template: "%s | webhooks.cc",
  },
  description: DEFAULT_PAGE_DESCRIPTION,
  metadataBase: new URL(SITE_URL),
  alternates: {
    canonical: "/",
    types: {
      "application/rss+xml": `${SITE_URL}/feed.xml`,
    },
  },
  applicationName: SITE_NAME,
  openGraph: {
    type: "website",
    locale: "en_US",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: DEFAULT_PAGE_TITLE,
    description: DEFAULT_PAGE_DESCRIPTION,
    images: [DEFAULT_OG_IMAGE_PATH],
  },
  twitter: {
    card: "summary_large_image",
    title: DEFAULT_PAGE_TITLE,
    description: DEFAULT_PAGE_DESCRIPTION,
    images: [DEFAULT_OG_IMAGE_PATH],
  },
  robots: {
    index: true,
    follow: true,
  },
  verification:
    googleSiteVerification || bingSiteVerification
      ? {
          ...(googleSiteVerification ? { google: googleSiteVerification } : {}),
          ...(bingSiteVerification ? { other: { "msvalidate.01": bingSiteVerification } } : {}),
        }
      : undefined,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link
          rel="alternate"
          type="application/rss+xml"
          title="webhooks.cc Blog"
          href="/feed.xml"
        />
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
        <JsonLd data={organizationSchema()} />
      </head>
      <body className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} font-sans`}>
        <noscript>
          <div style={{ padding: "1rem", fontFamily: "system-ui, sans-serif", lineHeight: 1.5 }}>
            <strong>webhooks.cc</strong>: Webhook testing tools with CLI, TypeScript SDK, and MCP
            server. Start at{" "}
            <a href="https://webhooks.cc/docs" style={{ textDecoration: "underline" }}>
              /docs
            </a>
            .
          </div>
        </noscript>
        {children}
      </body>
    </html>
  );
}
