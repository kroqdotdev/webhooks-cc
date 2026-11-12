import { SiteHeader } from "@/components/nav/site-header";

export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      {children}
    </>
  );
}
