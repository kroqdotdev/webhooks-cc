import { SiteHeader } from "@/components/nav/site-header";

export default function EmailTestingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      {children}
    </>
  );
}
