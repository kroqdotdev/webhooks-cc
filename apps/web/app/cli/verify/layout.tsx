import type { Metadata } from "next";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "CLI Device Verification",
  description: "Authorize a webhooks.cc CLI login session with your one-time device code.",
  path: "/cli/verify",
  noIndex: true,
});

export default function CliVerifyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
