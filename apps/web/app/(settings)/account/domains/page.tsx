"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { DomainsPanel, type RoutableEndpoint } from "@/components/settings/domains-panel";
import { SettingsPageHeader } from "@/components/settings/panel";
import { useAccountProfile } from "@/components/settings/use-account-profile";
import { fetchDashboardEndpoints } from "@/lib/dashboard-api";
import { planEntitlements } from "@/lib/entitlements";

export default function DomainsPage() {
  const { session } = useAuth();
  const accessToken = session?.access_token ?? null;
  const { profile } = useAccountProfile();
  const [endpoints, setEndpoints] = useState<RoutableEndpoint[]>([]);

  useEffect(() => {
    if (!accessToken) return;
    void fetchDashboardEndpoints(accessToken)
      .then((response) =>
        setEndpoints(
          response.owned
            .filter((endpoint) => endpoint.emailAddress)
            .map((endpoint) => ({
              id: endpoint.id,
              name: endpoint.name ?? null,
              slug: endpoint.slug,
            }))
        )
      )
      .catch(() => setEndpoints([]));
  }, [accessToken]);

  return (
    <>
      <SettingsPageHeader
        title="Domains"
        description="Your own domains that receive mail into your endpoints."
      />
      {profile && (
        <DomainsPanel
          accessToken={accessToken}
          endpoints={endpoints}
          canAdd={planEntitlements(profile.plan).customDomains > 0}
        />
      )}
    </>
  );
}
