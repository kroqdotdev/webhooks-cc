import { SiteHeader } from "@/components/nav/site-header";

export default function ForTeamsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      {children}
    </>
  );
}
