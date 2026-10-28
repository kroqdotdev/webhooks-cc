import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Connect an App",
  description: "Let an app or AI agent use your webhooks.cc account.",
  path: "/oauth/authorize",
  noIndex: true,
});

export default function OAuthAuthorizeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
