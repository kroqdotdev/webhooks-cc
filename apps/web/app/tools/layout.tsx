import { SiteHeader } from "@/components/nav/site-header";

export default function ToolsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      {children}
    </>
  );
}
