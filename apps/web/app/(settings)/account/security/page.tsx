"use client";

import { TwoFactor } from "@/components/account/two-factor";
import { SettingsPageHeader } from "@/components/settings/panel";

export default function SecurityPage() {
  return (
    <>
      <SettingsPageHeader
        title="Security"
        description="How you sign in. Passwords and sign-in links are managed from the sign-in page."
      />
      <TwoFactor />
    </>
  );
}
