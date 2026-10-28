import { SiteHeader } from "@/components/nav/site-header";

export default function CompareLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      {children}
    </>
  );
}
