import type { Metadata } from "next";
import Link from "next/link";
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
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          REST API Docs
        </Link>
      </FloatingNavbar>
      <div className="pt-28">
        <ScalarViewer />
      </div>
    </div>
  );
}
