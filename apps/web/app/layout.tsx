import type { Metadata } from "next";
import { Geist, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import {
  DEFAULT_OG_IMAGE_PATH,
  DEFAULT_PAGE_DESCRIPTION,
  DEFAULT_PAGE_TITLE,
  SITE_NAME,
  SITE_URL,
} from "@/lib/seo";
import { JsonLd, organizationSchema } from "@/lib/schemas";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { PostHogProvider } from "@/components/providers/posthog-provider";
import { MaintenanceBanner } from "@/components/maintenance-banner";
import { AnnouncementBanner } from "@/components/announcement-banner";
import { ANNOUNCEMENTS } from "@/lib/announcements";
import { buildAuthMdUrl } from "@/lib/agent/metadata";
import { appearanceBootstrapScript, resolveUiStyleSplit } from "@/lib/ui-style";

// Font variables live on <html> so globals.css can pick the face for the active style.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
});

// Only the clean style uses Geist, so classic visitors never download it.
const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  preload: false,
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
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
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
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
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${geist.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <link
          rel="alternate"
          type="application/rss+xml"
          title="webhooks.cc Blog"
          href="/feed.xml"
        />
        {/* Proactive auth.md discovery (WorkOS agent-registration protocol). No
            registered IANA relation exists, so we use the self-descriptive
            rel="auth.md" mirroring the spec's canonical filename. */}
        <link
          rel="auth.md"
          type="text/markdown"
          title="Agent registration (auth.md)"
          href={buildAuthMdUrl()}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: appearanceBootstrapScript(resolveUiStyleSplit(process.env.UI_STYLE_SPLIT)),
          }}
        />
        {ANNOUNCEMENTS.length > 0 && (
          <script
            dangerouslySetInnerHTML={{
              __html: `(function(){var d=localStorage.getItem(${JSON.stringify(ANNOUNCEMENTS[0].id).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")});if(!d)document.documentElement.style.setProperty('--ann-h','42px')})();`,
            }}
          />
        )}
        <JsonLd data={organizationSchema()} />
      </head>
      <body className="font-sans">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:bg-background focus:border-strong focus:border-line focus:px-4 focus:py-2 focus:font-bold"
        >
          Skip to content
        </a>
        <PostHogProvider>
          <ThemeProvider>
            <noscript>
              <div
                style={{
                  padding: "1rem",
                  fontFamily: "var(--font-sans), sans-serif",
                  lineHeight: 1.5,
                }}
              >
                <strong>webhooks.cc</strong>: Webhook testing tools with CLI, TypeScript SDK, and
                MCP server. Start at{" "}
                <a href="https://webhooks.cc/docs" style={{ textDecoration: "underline" }}>
                  /docs
                </a>
                .
              </div>
            </noscript>
            <MaintenanceBanner />
            <AnnouncementBanner />
            <div id="main-content" tabIndex={-1} />
            {children}
          </ThemeProvider>
        </PostHogProvider>
      </body>
    </html>
  );
}
