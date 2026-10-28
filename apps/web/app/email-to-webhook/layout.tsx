import { SiteHeader } from "@/components/nav/site-header";

export default function EmailToWebhookLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      {children}
    </>
  );
}
