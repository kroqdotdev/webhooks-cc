import type { Metadata } from "next";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Install CLI, SDK, and MCP Server",
  description:
    "Install the webhooks.cc CLI, TypeScript SDK, and MCP server for local webhook debugging, CI testing, and AI agent workflows.",
  path: "/installation",
});

export default function InstallationLayout({ children }: { children: React.ReactNode }) {
  return children;
}
