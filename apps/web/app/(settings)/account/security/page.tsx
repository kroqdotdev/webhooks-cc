"use client";

import { TwoFactor } from "@/components/account/two-factor";
import { SettingsPageHeader } from "@/components/settings/panel";

export default function SecurityPage() {
  return (
    <>
      <SettingsPageHeader
        title="Security"
        description="Two-factor sign-in for this account. Change your password under Profile."
      />
      <TwoFactor />
    </>
  );
}
