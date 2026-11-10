import type { Metadata } from "next";
import { SiteHeader } from "@/components/nav/site-header";
import { ReportForm } from "@/components/tunnels/report-form";
import { turnstileSiteKey } from "@/lib/turnstile";

export const metadata: Metadata = {
  title: "Report a preview",
  description:
    "Tell webhooks.cc about a shared preview used for phishing, malware, or illegal or abusive content.",
  alternates: { canonical: "/report" },
  // A form, not an answer to a search; its links may still be followed.
  robots: { index: false, follow: true },
};

// The Turnstile key is read on each request, not baked into the build.
export const dynamic = "force-dynamic";

export default async function ReportPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const url = typeof params.url === "string" ? params.url.slice(0, 2000) : "";
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto max-w-xl px-6 py-10 md:px-10">
        <h1 className="mb-4 text-3xl font-bold md:text-4xl">Report a preview</h1>
        <p className="text-sm text-muted-foreground">
          Tell us about a preview shared through webhooks.cc that tricks people, spreads malware or
          shows illegal or abusive content. Reports go to webhooks.cc, not to the person who shared
          the preview. Someone at webhooks.cc reads every report and can take a preview down at
          once.
        </p>
        <ReportForm url={url} siteKey={turnstileSiteKey()} />
      </main>
    </div>
  );
}
