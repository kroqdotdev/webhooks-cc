import { PolarError } from "@polar-sh/sdk/models/errors/polarerror";
import { describe, expect, test } from "vitest";
import { describePolarError, loggablePolarError } from "./polar";

const TOKEN = "polar_oat_super_secret_token";

function polarError(body: string, status = 422): PolarError {
  return new PolarError("API error occurred", {
    response: new Response(body, { status }),
    request: new Request("https://api.polar.sh/v1/customers/", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
    body,
  });
}

describe("loggablePolarError", () => {
  test("strips the request (and its authorization header) from Polar SDK errors", () => {
    const body = JSON.stringify({
      error: "PolarRequestValidationError",
      detail: [
        { loc: ["body", "email"], msg: "A customer with this email address already exists." },
      ],
    });

    const loggable = loggablePolarError(polarError(body));

    expect(JSON.stringify(loggable)).not.toContain(TOKEN);
    expect(loggable).toMatchObject({
      name: "PolarError",
      statusCode: 422,
      body,
      detail: "A customer with this email address already exists.",
    });
  });

  test("passes non-Polar errors through untouched", () => {
    const pgError = { code: "23505", message: "duplicate key", details: "Key (id) exists" };
    expect(loggablePolarError(pgError)).toBe(pgError);

    const plain = new Error("boom");
    expect(loggablePolarError(plain)).toBe(plain);
  });
});

describe("describePolarError", () => {
  test("reads validation detail from the raw body", () => {
    const error = polarError(JSON.stringify({ detail: "Seats cannot go below assigned seats" }));
    expect(describePolarError(error)).toBe("Seats cannot go below assigned seats");
  });
});
