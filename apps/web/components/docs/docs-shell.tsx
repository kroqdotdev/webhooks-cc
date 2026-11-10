import { DocsSidebar } from "@/components/docs/sidebar";
import { DocsBreadcrumbs } from "@/components/docs/breadcrumbs";
import { SearchModal } from "@/components/docs/search-modal";
import { SiteHeader } from "@/components/nav/site-header";

interface DocsShellProps {
  children: React.ReactNode;
  /**
   * Whether the search index takes its pages from here. Only webhooks.cc's
   * copy is indexed: mailhooks.cc's is the same content under app/mailhooks,
   * and the results' relative links open on whichever site searched.
   */
  searchIndexed?: boolean;
  footer?: React.ReactNode;
}

/** The docs' header, sidebar and search, on both sites. */
export function DocsShell({ children, searchIndexed = false, footer }: DocsShellProps) {
  return (
    <div className="min-h-screen">
      <SiteHeader />

      <div className="px-4">
        <div className="max-w-7xl mx-auto flex">
          <DocsSidebar />
          <main className="flex-1 min-w-0" data-pagefind-body={searchIndexed || undefined}>
            <div className="px-6 py-10 md:px-10">
              <DocsBreadcrumbs />
              {children}
            </div>
          </main>
        </div>
      </div>

      {footer}
      <SearchModal />
    </div>
  );
}
