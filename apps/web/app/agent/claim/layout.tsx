import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Connect an Agent",
  description: "Connect a registered AI agent to your webhooks.cc account.",
  path: "/agent/claim",
  noIndex: true,
});

export default function AgentClaimLayout({ children }: { children: React.ReactNode }) {
  return children;
}
