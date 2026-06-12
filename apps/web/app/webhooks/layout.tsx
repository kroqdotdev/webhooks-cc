import { FloatingNavbar } from "@/components/nav/floating-navbar";
import { BackButton } from "@/components/nav/back-button";

export default function WebhooksLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <FloatingNavbar>
        <BackButton />
        <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground border-2 border-foreground px-2 py-0.5">
          Providers
        </span>
      </FloatingNavbar>
      {children}
    </>
  );
}
