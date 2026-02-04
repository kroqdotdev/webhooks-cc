import Link from "next/link";
import { DocsSidebar } from "@/components/docs/sidebar";
import { ThemeToggle } from "@/components/ui/theme-toggle";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b-2 border-foreground shrink-0 bg-background sticky top-0 z-50">
        <div className="container mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="font-bold text-lg">
              webhooks.cc
            </Link>
            <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground border-2 border-foreground px-2 py-0.5">
              Docs
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Dashboard
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Sidebar + Content */}
      <div className="flex flex-1">
        <DocsSidebar />
        <main className="flex-1 min-w-0 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-6 py-10 md:px-10">{children}</div>
        </main>
      </div>
    </div>
  );
}
