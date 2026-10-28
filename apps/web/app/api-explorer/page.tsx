import { createPageMetadata } from "@/lib/seo";
import { SiteHeader } from "@/components/nav/site-header";
import { BackButton } from "@/components/nav/back-button";
import { ScalarViewer } from "@/components/docs/scalar-viewer";

export const metadata = createPageMetadata({
  title: "API Explorer",
  description:
    "Interactive REST API reference for webhooks.cc. Try endpoints, inspect schemas, and generate code snippets.",
  path: "/api-explorer",
  noIndex: true,
});

export default function ApiExplorerPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader>
        <BackButton />
      </SiteHeader>
      <main className="flex-1">
        <h1 className="sr-only">API Explorer</h1>
        <ScalarViewer />
      </main>
    </div>
  );
}
