import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FloatingNavbar } from "@/components/nav/floating-navbar";
import { ScalarViewer } from "@/components/docs/scalar-viewer";

export const metadata: Metadata = {
  title: "API Explorer — webhooks.cc",
  description:
    "Interactive API reference for the webhooks.cc REST API. Try endpoints, inspect schemas, and generate code snippets.",
};

export default function ApiExplorerPage() {
  return (
    <div className="min-h-screen">
      <FloatingNavbar>
        <Link
          href="/docs/api"
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Docs
        </Link>
      </FloatingNavbar>
      <div className="pt-28">
        <ScalarViewer />
      </div>
    </div>
  );
}
