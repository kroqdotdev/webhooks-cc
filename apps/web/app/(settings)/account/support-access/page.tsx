"use client";

import Link from "next/link";
import { SupportAccess } from "@/components/account/support-access";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { SettingsPageHeader, settingsLink } from "@/components/settings/panel";

export default function SupportAccessPage() {
  const { session } = useAuth();
  return (
    <>
      <SettingsPageHeader
        title="Support access"
        description={
          <>
            Support never sees what you capture unless you allow it on a ticket. Every look is
            listed here.{" "}
            <Link href="/support" className={settingsLink}>
              Your tickets
            </Link>
          </>
        }
      />
      <SupportAccess token={session?.access_token ?? null} />
    </>
  );
}
