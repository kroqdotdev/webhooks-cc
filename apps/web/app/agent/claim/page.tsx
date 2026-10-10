import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { getMaintenanceTopOffset } from "@/lib/announcements";

/**
 * Where an agent sends a human to connect it to their account. The auth.md
 * v0.6 claim ceremony comes with the next release; until then this page
 * explains that links and codes from older agents no longer work. Nothing
 * from the URL is rendered.
 */
export default function AgentClaimPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <nav
        className="fixed left-4 right-4 z-50"
        style={{ top: `calc(${getMaintenanceTopOffset()} + var(--ann-h, 0px))` }}
      >
        <div className="max-w-6xl mx-auto rounded-lg border-strong border-line bg-background shadow-raised">
          <div className="px-6 h-16 flex items-center justify-between">
            <Link href="/" className="font-bold text-xl tracking-tight">
              webhooks.cc
            </Link>
            <div className="flex items-center gap-6">
              <ThemeToggle />
              <Link href="/dashboard" className="ui-btn-outline text-sm py-2 px-4 w-28 text-center">
                Dashboard
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <main className="flex-1 flex items-center justify-center px-4 pt-24">
        <div className="w-full max-w-md text-center">
          <h1 className="text-2xl font-bold mb-4">Connect an agent</h1>
          <p className="text-muted-foreground mb-4">
            Connecting an AI agent to your webhooks.cc account is being rebuilt and returns in the
            next release.
          </p>
          <p className="text-muted-foreground mb-8">
            If an agent sent you here with a link or a code, it uses an older version of the
            protocol. Ask it to update. Until then, agents can use a temporary sandbox without an
            account.
          </p>
          <Link href="/docs/agents" className="ui-btn-outline text-sm py-2 px-4 inline-block">
            How agents use webhooks.cc
          </Link>
        </div>
      </main>
    </div>
  );
}
