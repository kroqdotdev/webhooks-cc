import { describe, expect, it } from "vitest";
import {
  hashPassword,
  newPasswordVersion,
  passwordProblem,
  runPasswordVersion,
  verifyPassword,
} from "./password-hash";

describe("passwords on preview links", () => {
  it("accepts the right password and refuses others", async () => {
    const hash = await hashPassword("correct horse");
    expect(hash.split("$").slice(0, 4)).toEqual(["scrypt", "16384", "8", "1"]);
    expect(await verifyPassword(hash, "correct horse")).toBe(true);
    expect(await verifyPassword(hash, "correct horsE")).toBe(false);
    expect(await verifyPassword(hash, "")).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same password")).not.toBe(await hashPassword("same password"));
  });

  it("refuses a malformed stored hash", async () => {
    expect(await verifyPassword("bcrypt-whatever", "x")).toBe(false);
    expect(await verifyPassword(["scrypt", 0, 8, 1, "aa", "bb"].join("$"), "x")).toBe(false);
  });

  it("names what is wrong with a password", () => {
    expect(passwordProblem("short")).toMatch(/at least 8/);
    expect(passwordProblem("x".repeat(201))).toMatch(/under 200/);
    expect(passwordProblem("long enough")).toBeNull();
  });

  it("gives a run the same version across reconnects, a new run a new one", () => {
    const a = runPasswordVersion("secret", "user-1", "acme", "run-1");
    expect(a).toBe(runPasswordVersion("secret", "user-1", "acme", "run-1"));
    expect(a).not.toBe(runPasswordVersion("secret", "user-1", "acme", "run-2"));
    expect(a).not.toBe(runPasswordVersion("secret", "user-2", "acme", "run-1"));
    expect(a).not.toBe(runPasswordVersion("secret", "user-1", "other", "run-1"));
    expect(runPasswordVersion("secret", "user-1", "acme", null)).not.toBe(
      runPasswordVersion("secret", "user-1", "acme", null)
    );
    expect(a).toHaveLength(32);
    expect(newPasswordVersion()).not.toBe(newPasswordVersion());
  });
});
