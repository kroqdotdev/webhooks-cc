import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Claim Agent Credential",
  description: "Claim an API credential for a registered AI agent.",
  path: "/agent/claim",
  noIndex: true,
});

export default function AgentClaimLayout({ children }: { children: React.ReactNode }) {
  return children;
}
