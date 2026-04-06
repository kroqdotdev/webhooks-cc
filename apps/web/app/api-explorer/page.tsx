import { createPageMetadata } from "@/lib/seo";
import { AppHeader } from "@/components/nav/app-header";
import { ScalarViewer } from "@/components/docs/scalar-viewer";

export const metadata = createPageMetadata({
  title: "API Explorer",
  description:
    "Interactive REST API reference for webhooks.cc. Try endpoints, inspect schemas, and generate code snippets.",
  path: "/api-explorer",
  keywords: ["webhook api", "webhook rest api", "webhook api reference", "webhooks.cc api"],
});

export default function ApiExplorerPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <AppHeader showBackButton />
      <div className="flex-1">
        <h1 className="sr-only">API Explorer</h1>
        <ScalarViewer />
      </div>
    </div>
  );
}
