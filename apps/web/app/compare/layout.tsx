import { FloatingNavbar } from "@/components/nav/floating-navbar";
import { BackButton } from "@/components/nav/back-button";

export default function CompareLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <FloatingNavbar>
        <BackButton />
        <span className="text-xs font-bold caps text-muted-foreground border-strong border-line rounded-md px-2 py-0.5">
          Compare
        </span>
      </FloatingNavbar>
      {children}
    </>
  );
}
