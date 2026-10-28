import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowRight, EyeOff } from "lucide-react";
import { SiteHeader } from "@/components/nav/site-header";
import { RequestDetail } from "@/components/dashboard/request-detail";
import { getWebProviderInfo } from "@/lib/provider-catalog";
import { snapshotToRequest } from "@/lib/request-share";
import { getSharedRequest } from "@/lib/supabase/request-shares";

// A revoked link must stop working at once, so nothing here is cached.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
}

// The title and description show up in chat and ticket unfurls, so they never
// include the request's path or contents.
export const metadata: Metadata = {
  title: "Shared webhook request",
  description: "A captured webhook request, shared read-only from webhooks.cc.",
  robots: { index: false, follow: false },
  openGraph: {
    title: "Shared webhook request",
    description: "A captured webhook request, shared read-only from webhooks.cc.",
  },
};

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function SharedRequestPage({ params }: PageProps) {
  const { token } = await params;
  const shared = await getSharedRequest(token);
  if (!shared) notFound();

  const { snapshot } = shared;
  const hidden = [...snapshot.redactedHeaders, ...snapshot.redactedQuery];
  const providerLabel = snapshot.detectedProvider
    ? (getWebProviderInfo(snapshot.detectedProvider)?.label ?? snapshot.detectedProvider)
    : null;

  return (
    <div className="min-h-screen">
      <SiteHeader />

      <main className="max-w-6xl mx-auto px-4 pt-10 pb-16">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-bold caps text-muted-foreground mb-1">Shared request</p>
            <h1 className="text-2xl font-bold">
              {snapshot.detectedEvent
                ? `${providerLabel ? `${providerLabel} ` : ""}${snapshot.detectedEvent}`
                : "Captured webhook"}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              A read-only copy made on {formatDate(shared.createdAt)}. The link stops working on{" "}
              {formatDate(shared.expiresAt)}, or sooner if its owner revokes it.
            </p>
          </div>
          <Link
            href="/"
            className="ui-btn-outline py-1.5! px-3! text-xs inline-flex items-center gap-1.5"
          >
            Capture your own webhooks
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>

        {(hidden.length > 0 || snapshot.bodyTruncated || snapshot.bodyNotUtf8) && (
          <div className="mb-4 rounded-md border-strong border-line bg-muted px-3 py-2 text-xs text-muted-foreground space-y-1">
            {hidden.length > 0 && (
              <p className="flex items-start gap-1.5">
                <EyeOff className="h-3.5 w-3.5 shrink-0 mt-px" />
                <span>
                  Hidden by the person who shared it:{" "}
                  <span className="font-mono">{hidden.join(", ")}</span>
                </span>
              </p>
            )}
            {snapshot.bodyTruncated && (
              <p>The body was cut to its first 256 KB when the link was made.</p>
            )}
            {snapshot.bodyNotUtf8 && <p>The body was not UTF-8 text; this shows its text form.</p>}
          </div>
        )}

        <div className="h-[70vh] min-h-[420px] overflow-hidden rounded-lg border-strong border-line bg-background shadow-raised">
          <RequestDetail request={snapshotToRequest(snapshot, token)} />
        </div>

        <div className="mt-8 ui-card ui-card-static flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-bold">Debug webhooks like this, for free</h2>
            <p className="text-sm text-muted-foreground">
              webhooks.cc captures webhooks and emails, sends signed test payloads, generates
              payload types, and shares a request with one link.
            </p>
          </div>
          <Link
            href="/"
            className="ui-btn-primary py-2! px-4! text-sm inline-flex items-center gap-1.5"
          >
            Get a webhook URL
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </main>
    </div>
  );
}
