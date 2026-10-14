import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  updateUserById: vi.fn(),
  usersUpdate: vi.fn(),
  usersEq: vi.fn(),
}));

vi.mock("./admin", () => ({
  createAdminClient: mockFns.createAdminClient,
}));

import {
  DISPLAY_NAME_MAX_LENGTH,
  cleanStoredName,
  effectiveDisplayName,
  parseDisplayName,
  updateDisplayName,
} from "./profile";

beforeEach(() => {
  vi.clearAllMocks();
  mockFns.usersEq.mockResolvedValue({ error: null });
  mockFns.usersUpdate.mockReturnValue({ eq: mockFns.usersEq });
  mockFns.createAdminClient.mockReturnValue({
    auth: { admin: { updateUserById: mockFns.updateUserById } },
    from: (table: string) => {
      expect(table).toBe("users");
      return { update: mockFns.usersUpdate };
    },
  });
});

describe("parseDisplayName", () => {
  test("trims a string", () => {
    expect(parseDisplayName("  Ada Lovelace  ")).toEqual({ ok: true, value: "Ada Lovelace" });
  });

  test("null and blank strings clear the override", () => {
    expect(parseDisplayName(null)).toEqual({ ok: true, value: null });
    expect(parseDisplayName("")).toEqual({ ok: true, value: null });
    expect(parseDisplayName("   ")).toEqual({ ok: true, value: null });
  });

  test("rejects non-strings", () => {
    expect(parseDisplayName(42)).toEqual({ ok: false, error: "name must be a string or null" });
    expect(parseDisplayName(undefined)).toMatchObject({ ok: false });
    expect(parseDisplayName({ first: "Ada" })).toMatchObject({ ok: false });
  });

  test("enforces the length limit in characters, not UTF-16 units", () => {
    const max = "a".repeat(DISPLAY_NAME_MAX_LENGTH);
    expect(parseDisplayName(max)).toEqual({ ok: true, value: max });
    expect(parseDisplayName(`${max}b`)).toEqual({
      ok: false,
      error: "Name must be 80 characters or fewer",
    });
    // Astral characters are two UTF-16 units each but count once.
    const emoji = "\u{1F600}".repeat(DISPLAY_NAME_MAX_LENGTH);
    expect(parseDisplayName(emoji)).toEqual({ ok: true, value: emoji });
  });

  test.each([
    ["newline", "Ada\nLovelace"],
    ["tab", "Ada\tLovelace"],
    ["NUL", "Ada\u0000"],
    ["DEL", "Ada\u007f"],
    ["C1 control", "Ada\u0085"],
    ["line separator", "Ada\u2028Lovelace"],
    ["bidi override", "Ada\u202Eecalevol"],
    ["bidi isolate", "\u2066Ada"],
  ])("rejects a %s", (_label, value) => {
    expect(parseDisplayName(value)).toEqual({
      ok: false,
      error: "Name cannot contain control characters",
    });
  });

  test("keeps zero-width joiners used by emoji sequences", () => {
    const family = "Ada \u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(parseDisplayName(family)).toEqual({ ok: true, value: family });
  });
});

describe("cleanStoredName", () => {
  test("strips control and bidi characters, trims, and caps at 80 characters", () => {
    expect(cleanStoredName("  Ada\u202E Lovelace\n ")).toBe("Ada Lovelace");
    expect(cleanStoredName("\u2066\u0007")).toBeNull();
    expect(cleanStoredName(null)).toBeNull();
    const emoji = "\u{1F600}".repeat(DISPLAY_NAME_MAX_LENGTH + 5);
    expect([...(cleanStoredName(emoji) ?? "")]).toHaveLength(DISPLAY_NAME_MAX_LENGTH);
  });
});

describe("effectiveDisplayName", () => {
  test("prefers a non-blank app_metadata override, then full_name, then name", () => {
    const provider = { full_name: "Full", name: "Short" };
    expect(effectiveDisplayName({ display_name: "Custom" }, provider)).toBe("Custom");
    expect(effectiveDisplayName({ display_name: "  " }, provider)).toBe("Full");
    expect(effectiveDisplayName({}, { name: "Short" })).toBe("Short");
    expect(effectiveDisplayName({}, {})).toBeNull();
    expect(effectiveDisplayName(null, null)).toBeNull();
  });

  test("ignores a display_name in user_metadata, which users can write themselves", () => {
    expect(effectiveDisplayName({}, { display_name: "Spoofed", full_name: "Full" })).toBe("Full");
  });

  test("cleans a provider name the same way the trigger does", () => {
    expect(effectiveDisplayName({}, { full_name: "Eve\u202Elivé" })).toBe("Evelivé");
  });

  test("skips a blank provider name and trims only plain spaces, as btrim() does", () => {
    expect(effectiveDisplayName({}, { full_name: " ", name: "Short" })).toBe("Short");
    expect(effectiveDisplayName({}, { full_name: "", name: "Short" })).toBe("Short");
    expect(effectiveDisplayName({}, { full_name: " Ada\u00A0" })).toBe("Ada\u00A0");
  });
});

describe("updateDisplayName", () => {
  test("stores the override in auth metadata and writes the effective name", async () => {
    mockFns.updateUserById.mockResolvedValue({
      data: {
        user: {
          app_metadata: { display_name: "Custom" },
          user_metadata: { full_name: "Provider" },
        },
      },
      error: null,
    });

    await expect(updateDisplayName("user_1", "Custom")).resolves.toBe("Custom");

    expect(mockFns.updateUserById).toHaveBeenCalledWith("user_1", {
      app_metadata: { display_name: "Custom" },
    });
    expect(mockFns.usersUpdate).toHaveBeenCalledWith({ name: "Custom" });
    expect(mockFns.usersEq).toHaveBeenCalledWith("id", "user_1");
  });

  test("clearing sends null and falls back to the provider name", async () => {
    mockFns.updateUserById.mockResolvedValue({
      data: { user: { app_metadata: {}, user_metadata: { full_name: "Provider" } } },
      error: null,
    });

    await expect(updateDisplayName("user_1", null)).resolves.toBe("Provider");

    expect(mockFns.updateUserById).toHaveBeenCalledWith("user_1", {
      app_metadata: { display_name: null },
    });
    expect(mockFns.usersUpdate).toHaveBeenCalledWith({ name: "Provider" });
  });

  test("clearing without a provider name writes null", async () => {
    mockFns.updateUserById.mockResolvedValue({
      data: { user: { app_metadata: {}, user_metadata: {} } },
      error: null,
    });

    await expect(updateDisplayName("user_1", null)).resolves.toBeNull();
    expect(mockFns.usersUpdate).toHaveBeenCalledWith({ name: null });
  });

  test("an auth error throws before touching public.users", async () => {
    const authError = new Error("User not found");
    mockFns.updateUserById.mockResolvedValue({ data: { user: null }, error: authError });

    await expect(updateDisplayName("user_1", "Custom")).rejects.toBe(authError);
    expect(mockFns.usersUpdate).not.toHaveBeenCalled();
  });

  test("a users update error throws", async () => {
    const dbError = { code: "57014", message: "canceling statement" };
    mockFns.updateUserById.mockResolvedValue({
      data: { user: { app_metadata: { display_name: "Custom" }, user_metadata: {} } },
      error: null,
    });
    mockFns.usersEq.mockResolvedValue({ error: dbError });

    await expect(updateDisplayName("user_1", "Custom")).rejects.toBe(dbError);
  });
});
