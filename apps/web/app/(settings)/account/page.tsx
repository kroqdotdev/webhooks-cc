"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Mail } from "lucide-react";
import { DeleteAccountDialog } from "@/components/account/delete-account-dialog";
import { Avatar } from "@/components/settings/avatar";
import {
  InlineMessage,
  Panel,
  PanelRow,
  SettingsPageHeader,
  SettingsPageSkeleton,
  settingsLink,
} from "@/components/settings/panel";
import { useAccountProfile } from "@/components/settings/use-account-profile";
import { Button } from "@/components/ui/button";
import { GitHubIcon, GoogleIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";

const NAME_MAX_LENGTH = 80;

/**
 * Links from before the settings split pointed into this page: the Polar
 * checkout returns to `?upgraded=true` and agent emails link to
 * `#connected-agents`. Send them on to the page that now holds that content.
 */
function LegacyLinkRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (searchParams.get("upgraded") === "true") {
      router.replace("/account/plan?upgraded=true");
    } else if (window.location.hash === "#connected-agents") {
      router.replace("/account/agents");
    }
  }, [router, searchParams]);

  return null;
}

function SignInMethod({ provider }: { provider: string }) {
  const icon =
    provider === "github" ? (
      <GitHubIcon className="h-4 w-4" />
    ) : provider === "google" ? (
      <GoogleIcon className="h-4 w-4" />
    ) : (
      <Mail className="h-4 w-4" aria-hidden="true" />
    );
  const label =
    provider === "github"
      ? "GitHub"
      : provider === "google"
        ? "Google"
        : provider === "email"
          ? "Email and password"
          : provider;
  return (
    <li className="flex items-center gap-2">
      {icon}
      <span>{label}</span>
    </li>
  );
}

export default function ProfilePage() {
  const { profile, setProfile, loading, accessToken, authUser } = useAccountProfile();
  const [nameDraft, setNameDraft] = useState("");
  const [savedName, setSavedName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  // Seed the field once the row arrives, and again whenever the saved name changes.
  const loadedName = profile?.name ?? "";
  const [seededFrom, setSeededFrom] = useState<string | null>(null);
  if (profile && seededFrom !== loadedName) {
    setSeededFrom(loadedName);
    setNameDraft(loadedName);
    setSavedName(loadedName);
  }

  const handleSave = async () => {
    if (!accessToken) {
      setMessage({ tone: "error", text: "Your session expired. Sign in again to save." });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/account", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: nameDraft.trim() || null }),
      });
      const data = (await res.json().catch(() => ({}))) as { name?: string | null; error?: string };
      if (!res.ok) {
        setMessage({ tone: "error", text: data.error ?? "Your name was not saved. Try again." });
        return;
      }
      const effective = data.name ?? null;
      setProfile((previous) => (previous ? { ...previous, name: effective } : previous));
      setMessage({ tone: "success", text: "Name saved." });
    } catch {
      setMessage({ tone: "error", text: "Your name was not saved. Check your connection." });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <SettingsPageSkeleton label="Loading your profile" />;
  }

  if (!profile) {
    return (
      <p className="text-sm text-muted-foreground">
        Your profile could not be loaded. Refresh the page to try again.
      </p>
    );
  }

  const providers = Array.from(
    new Set(authUser?.identities?.map((identity) => identity.provider).filter(Boolean) ?? [])
  );
  const nameChanged = nameDraft.trim() !== (savedName ?? "").trim();
  // Counted in characters, as the server counts them, so an emoji is one.
  const tooLong = [...nameDraft.trim()].length > NAME_MAX_LENGTH;

  return (
    <>
      <Suspense fallback={null}>
        <LegacyLinkRedirect />
      </Suspense>

      <SettingsPageHeader
        title="Profile"
        description="How you appear to teammates and how you sign in."
      >
        <div className="flex items-center gap-4">
          <Avatar name={profile.name} email={profile.email} image={profile.image} size="lg" />
          <div className="min-w-0">
            <p className="text-lg font-semibold truncate">{profile.name || profile.email}</p>
            <p className="text-sm text-muted-foreground">
              <Link href="/account/plan" className={settingsLink}>
                {profile.plan === "pro" ? "Pro" : "Free"}
              </Link>{" "}
              plan
            </p>
          </div>
        </div>
      </SettingsPageHeader>

      <div className="space-y-6">
        <Panel
          id="details"
          title="Your details"
          footer={
            <>
              <Button
                onClick={() => void handleSave()}
                disabled={saving || !nameChanged || tooLong}
              >
                {saving ? "Saving..." : "Save name"}
              </Button>
              {message && <InlineMessage tone={message.tone}>{message.text}</InlineMessage>}
            </>
          }
        >
          <PanelRow
            label="Display name"
            htmlFor="display-name"
            hint="Shown to teammates. Leave it empty to use the name from your sign-in provider."
          >
            <Input
              id="display-name"
              value={nameDraft}
              placeholder={profile.email.split("@")[0]}
              aria-invalid={tooLong}
              onChange={(event) => {
                setNameDraft(event.target.value);
                setMessage(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && nameChanged && !tooLong) void handleSave();
              }}
              disabled={saving}
              className="max-w-sm"
            />
            {tooLong && (
              <p className="mt-2 text-xs text-destructive">
                Use {NAME_MAX_LENGTH} characters or fewer.
              </p>
            )}
          </PanelRow>
          <PanelRow label="Email" hint="Team invites go to this address.">
            <p className="py-2">{profile.email}</p>
          </PanelRow>
          <PanelRow label="Sign-in methods">
            {providers.length > 0 ? (
              <ul className="space-y-1.5 py-2">
                {providers.map((provider) => (
                  <SignInMethod key={provider} provider={provider} />
                ))}
              </ul>
            ) : (
              <p className="py-2 text-muted-foreground">None linked</p>
            )}
          </PanelRow>
        </Panel>

        <Panel
          id="delete-account"
          tone="danger"
          title="Delete account"
          description="Deletes your endpoints, captured requests, API keys and connected agents. A Pro subscription, and the subscriptions of teams you own, are cancelled at once."
          footer={<DeleteAccountDialog accessToken={accessToken} />}
        />
      </div>
    </>
  );
}
