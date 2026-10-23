"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { isAuthError } from "@supabase/supabase-js";
import { PASSWORD_MIN_LENGTH } from "@/components/auth/email-password-form";
import { InlineMessage, Panel, PanelRow, settingsLink } from "@/components/settings/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { mapAuthError } from "@/lib/auth-errors";
import { createClient } from "@/lib/supabase/client";

type Field = "current" | "next" | "confirm";
const FIELD_IDS: Record<Field, string> = {
  current: "current-password",
  next: "new-password",
  confirm: "confirm-new-password",
};
type Message = { tone: "success" | "error"; text: string; field?: Field };

/** The field a GoTrue refusal is about, so focus can go back to it. */
function fieldForError(error: unknown): Field | undefined {
  if (!isAuthError(error)) return undefined;
  switch (error.code) {
    case "current_password_invalid":
    case "current_password_required":
      return "current";
    case "weak_password":
    case "same_password":
      return "next";
    default:
      return undefined;
  }
}

/**
 * Password change for accounts that sign in with email and password.
 *
 * GoTrue checks the current password itself
 * (GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD, see
 * infra/supabase/gotrue-email-auth.md): its user endpoint is public, so a
 * check made here could be skipped by calling it directly. GoTrue skips the
 * check for sessions that began with an email link: the reset link offered
 * here relies on that, and so do accounts created by agent registration,
 * which sign in with email codes and hold a random password from GoTrue that
 * nobody knows. A change ends every other session of the account, and GoTrue
 * emails the account (GOTRUE_MAILER_NOTIFICATIONS_PASSWORD_CHANGED_ENABLED).
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

  const fail = (text: string, field?: Field) => {
    setMessage({ tone: "error", text, field });
    if (field) document.getElementById(FIELD_IDS[field])?.focus();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setMessage(null);

    if (next.length < PASSWORD_MIN_LENGTH) {
      fail(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`, "next");
      return;
    }
    if (next !== confirm) {
      fail("New passwords don't match", "confirm");
      return;
    }

    setBusy(true);
    try {
      const { error } = await createClient().auth.updateUser({
        password: next,
        current_password: current,
      });
      if (error) {
        fail(mapAuthError(error), fieldForError(error));
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
      fail(mapAuthError(err));
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
        fail(mapAuthError(error));
        return;
      }
      setMessage({ tone: "success", text: `Reset link sent to ${email}.` });
    } catch (err) {
      fail(mapAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  // Read-only rather than disabled while a request runs, so focus stays put.
  const fieldProps = (field: Field) => ({
    id: FIELD_IDS[field],
    name: FIELD_IDS[field],
    readOnly: busy,
    "aria-invalid": message?.field === field || undefined,
    className: "max-w-sm",
  });

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
            <Button type="submit" disabled={busy || !next || !confirm}>
              {busy ? "Saving..." : "Change password"}
            </Button>
            {message && <InlineMessage tone={message.tone}>{message.text}</InlineMessage>}
          </>
        }
      >
        <PanelRow
          label="Current password"
          htmlFor={FIELD_IDS.current}
          hint={
            <>
              Forgot it, or never set one?{" "}
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
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={edit(setCurrent)}
            {...fieldProps("current")}
          />
        </PanelRow>
        <PanelRow
          label="New password"
          htmlFor={FIELD_IDS.next}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        >
          <Input
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            value={next}
            onChange={edit(setNext)}
            {...fieldProps("next")}
          />
        </PanelRow>
        <PanelRow label="Confirm new password" htmlFor={FIELD_IDS.confirm}>
          <Input
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            value={confirm}
            onChange={edit(setConfirm)}
            {...fieldProps("confirm")}
          />
        </PanelRow>
      </Panel>
    </form>
  );
}
