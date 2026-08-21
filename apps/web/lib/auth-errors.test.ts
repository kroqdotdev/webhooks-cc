import { AuthError } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { describeLoginError, mapAuthError } from "./auth-errors";

describe("mapAuthError", () => {
  it.each([
    ["invalid_credentials", "Incorrect email or password"],
    ["email_not_confirmed", "Confirm your email first. Check your inbox for the link."],
    ["user_already_exists", "An account with this email already exists. Sign in instead."],
    ["email_exists", "An account with this email already exists. Sign in instead."],
    ["weak_password", "Password must be at least 8 characters"],
    ["same_password", "Choose a password you haven't used before"],
    ["over_email_send_rate_limit", "Too many emails sent. Wait a minute and try again."],
    ["over_request_rate_limit", "Too many attempts. Wait a moment and try again."],
  ])("maps %s", (code, copy) => {
    expect(mapAuthError(new AuthError("raw gotrue message", 400, code))).toBe(copy);
  });

  it("falls back to the AuthError message for unknown codes", () => {
    expect(
      mapAuthError(new AuthError("Database error saving new user", 500, "unexpected_failure"))
    ).toBe("Database error saving new user");
    expect(mapAuthError(new AuthError("no code at all", 400))).toBe("no code at all");
  });

  it("uses the message of a plain Error", () => {
    expect(mapAuthError(new Error("fetch failed"))).toBe("fetch failed");
  });

  it("returns generic copy for non-errors", () => {
    expect(mapAuthError("nope")).toBe("Something went wrong. Please try again.");
    expect(mapAuthError(undefined)).toBe("Something went wrong. Please try again.");
    expect(mapAuthError(new AuthError("", 400))).toBe("Something went wrong. Please try again.");
  });
});

describe("describeLoginError", () => {
  it("returns null when there is nothing to show", () => {
    expect(describeLoginError(null)).toBeNull();
    expect(describeLoginError("")).toBeNull();
    expect(describeLoginError("   ")).toBeNull();
  });

  it("renders copy for the known codes", () => {
    expect(describeLoginError("auth_callback_error")).toBe("Sign in failed. Please try again.");
    expect(describeLoginError("link_invalid")).toBe(
      "That link is invalid or has expired. Sign in, or request a new link."
    );
    expect(describeLoginError("oauth_denied")).toMatch(/cancelled/);
    expect(describeLoginError("oauth_error")).toMatch(/provider returned an error/);
  });

  it("collapses unknown values and free text to the generic message", () => {
    expect(describeLoginError("Your account is locked, call +1 555 0100")).toBe(
      "Sign in failed. Please try again."
    );
    expect(describeLoginError("<img src=x onerror=alert(1)>")).toBe(
      "Sign in failed. Please try again."
    );
  });
});
