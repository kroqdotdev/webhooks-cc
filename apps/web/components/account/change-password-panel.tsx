"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { PASSWORD_MIN_LENGTH } from "@/components/auth/email-password-form";
import { InlineMessage, Panel, PanelRow, settingsLink } from "@/components/settings/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { mapAuthError } from "@/lib/auth-errors";
import { createClient } from "@/lib/supabase/client";

type Message = { tone: "success" | "error"; text: string };

/**
 * Password change for accounts that sign in with email and password.
 *
 * GoTrue checks the current password itself
 * (GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD, see
 * infra/supabase/gotrue-email-auth.md): its user endpoint is public, so a
 * check made here could be skipped by calling it directly. It skips that
 * check for sessions that came from an email link, which is what the reset
 * link offered here relies on, and it ends every other session of the account.
 */
export function ChangePasswordPanel({ email }: { email: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const edit = (setter: (value: string) => void) => (event: ChangeEvent<HTMLInputElement>) => {
    setter(event.target.value);
    setMessage(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setMessage(null);

    if (next.length < PASSWORD_MIN_LENGTH) {
      setMessage({
        tone: "error",
        text: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
      });
      return;
    }
    if (next !== confirm) {
      setMessage({ tone: "error", text: "New passwords don't match" });
      return;
    }

    setBusy(true);
    try {
      const { error } = await createClient().auth.updateUser({
        password: next,
        current_password: current,
      });
      if (error) {
        setMessage({ tone: "error", text: mapAuthError(error) });
        return;
      }
      setCurrent("");
      setNext("");
      setConfirm("");
      setMessage({
        tone: "success",
        text: "Password changed. You were signed out on every other browser and device.",
      });
    } catch (err) {
      setMessage({ tone: "error", text: mapAuthError(err) });
    } finally {
      setBusy(false);
    }
  };

  const sendResetLink = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const { error } = await createClient().auth.resetPasswordForEmail(email);
      if (error) {
        setMessage({ tone: "error", text: mapAuthError(error) });
        return;
      }
      setMessage({ tone: "success", text: `Reset link sent to ${email}.` });
    } catch (err) {
      setMessage({ tone: "error", text: mapAuthError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      {/* Tells password managers which account the new password belongs to. */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      <Panel
        id="password"
        title="Password"
        description="Changing it signs you out everywhere else. API keys and connected agents keep working; revoke them on their own pages."
        footer={
          <>
            <Button type="submit" disabled={busy || !current || !next || !confirm}>
              {busy ? "Saving..." : "Change password"}
            </Button>
            {message && <InlineMessage tone={message.tone}>{message.text}</InlineMessage>}
          </>
        }
      >
        <PanelRow
          label="Current password"
          htmlFor="current-password"
          hint={
            <>
              Forgot it?{" "}
              <button
                type="button"
                onClick={() => void sendResetLink()}
                disabled={busy}
                className={`${settingsLink} disabled:opacity-50`}
              >
                Email me a reset link
              </button>
            </>
          }
        >
          <Input
            id="current-password"
            name="current-password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={edit(setCurrent)}
            disabled={busy}
            className="max-w-sm"
          />
        </PanelRow>
        <PanelRow
          label="New password"
          htmlFor="new-password"
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        >
          <Input
            id="new-password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            value={next}
            onChange={edit(setNext)}
            disabled={busy}
            className="max-w-sm"
          />
        </PanelRow>
        <PanelRow label="Confirm new password" htmlFor="confirm-new-password">
          <Input
            id="confirm-new-password"
            name="confirm-new-password"
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            value={confirm}
            onChange={edit(setConfirm)}
            disabled={busy}
            className="max-w-sm"
          />
        </PanelRow>
      </Panel>
    </form>
  );
}
