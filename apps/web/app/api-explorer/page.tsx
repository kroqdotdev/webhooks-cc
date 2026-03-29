import type { Metadata } from "next";
import { AppHeader } from "@/components/nav/app-header";
import { ScalarViewer } from "@/components/docs/scalar-viewer";

export const metadata: Metadata = {
  title: "API Explorer — webhooks.cc",
  description:
    "Interactive API reference for the webhooks.cc REST API. Try endpoints, inspect schemas, and generate code snippets.",
};

export default function ApiExplorerPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <AppHeader showBackButton />
      <div className="flex-1">
        <ScalarViewer />
      </div>
    </div>
  );
}
