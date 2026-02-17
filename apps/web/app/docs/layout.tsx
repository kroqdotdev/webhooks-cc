import { DocsSidebar } from "@/components/docs/sidebar";
import { DocsBreadcrumbs } from "@/components/docs/breadcrumbs";
import { FloatingNavbar } from "@/components/nav/floating-navbar";
import { BackButton } from "@/components/nav/back-button";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <FloatingNavbar>
        <BackButton />
        <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground border-2 border-foreground px-2 py-0.5">
          Docs
        </span>
      </FloatingNavbar>

      {/* Sidebar + Content - mx-4 matches navbar's left-4/right-4 */}
      <div className="mx-4 pt-24">
        <div className="max-w-6xl mx-auto flex">
          <DocsSidebar />
          <main className="flex-1 min-w-0">
            <div className="max-w-3xl mx-auto px-6 py-10 md:px-10">
              <DocsBreadcrumbs />
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
