"use client";

import Link from "next/link";
import { SharesPage } from "@/components/account/shares/shares-page";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { SettingsPageHeader, settingsLink } from "@/components/settings/panel";

export default function AccountSharesPage() {
  const { session } = useAuth();

  return (
    <>
      <SettingsPageHeader
        title="Shares"
        description={
          <>
            Links to apps running on your computer, opened with{" "}
            <span className="font-mono">whk share</span>. A link works while the command runs.{" "}
            <Link href="/docs/share" className={settingsLink}>
              About sharing
            </Link>
          </>
        }
      />
      <SharesPage accessToken={session?.access_token ?? null} />
    </>
  );
}
