import type { Metadata } from "next";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Installation",
  description:
    "Install the webhooks.cc CLI or SDK to capture, inspect, and forward webhooks in local development.",
  path: "/installation",
});

export default function InstallationLayout({ children }: { children: React.ReactNode }) {
  return children;
}
