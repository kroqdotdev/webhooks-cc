"use client";

import Link from "next/link";
import { ShareLinks } from "@/components/account/share-links";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { SettingsPageHeader, settingsLink } from "@/components/settings/panel";

export default function ShareLinksPage() {
  const { session } = useAuth();

  return (
    <>
      <SettingsPageHeader
        title="Share links"
        description={
          <>
            Read-only copies of requests you shared. Anyone with a link can open it until it expires
            or you revoke it, even after the request itself is deleted.{" "}
            <Link href="/docs/dashboard-features#share-a-request" className={settingsLink}>
              About share links
            </Link>
          </>
        }
      />
      <ShareLinks accessToken={session?.access_token ?? null} />
    </>
  );
}
