"use client";

import Link from "next/link";
import { ConnectedAgents } from "@/components/account/connected-agents";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { SettingsPageHeader, settingsLink } from "@/components/settings/panel";

export default function AgentsPage() {
  const { session } = useAuth();

  return (
    <>
      <SettingsPageHeader
        title="Connected agents"
        description={
          <>
            AI agents you approved with a code. They use the API for you, but cannot change your API
            keys, billing or account.{" "}
            <Link href="/docs/agents" className={settingsLink}>
              How agents connect
            </Link>
          </>
        }
      />
      <ConnectedAgents accessToken={session?.access_token ?? null} />
    </>
  );
}
