import { DocsSidebar } from "@/components/docs/sidebar";
import { DocsBreadcrumbs } from "@/components/docs/breadcrumbs";
import { SearchModal } from "@/components/docs/search-modal";
import { SiteHeader } from "@/components/nav/site-header";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <SiteHeader />

      <div className="px-4">
        <div className="max-w-7xl mx-auto flex">
          <DocsSidebar />
          <main className="flex-1 min-w-0" data-pagefind-body>
            <div className="px-6 py-10 md:px-10">
              <DocsBreadcrumbs />
              {children}
            </div>
          </main>
        </div>
      </div>

      <SearchModal />
    </div>
  );
}
