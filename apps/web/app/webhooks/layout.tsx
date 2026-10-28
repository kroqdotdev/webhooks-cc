import { SiteHeader } from "@/components/nav/site-header";

export default function WebhooksLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      {children}
    </>
  );
}
