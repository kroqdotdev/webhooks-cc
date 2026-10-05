import { PolarClientError, PolarNetworkError } from "@polar-sh/sdk";
import { errors } from "@polar-sh/sdk/2026-10";
import { describe, expect, test } from "vitest";
import { describePolarError, loggablePolarError, polarErrorCode } from "./polar";

const EMAIL = "someone@example.com";

function validationError(): InstanceType<typeof errors.HTTPValidationError> {
  return new errors.HTTPValidationError(422, {
    detail: [
      {
        loc: ["body", "email"],
        msg: "A customer with this email address already exists.",
        type: "value_error",
        input: EMAIL,
      },
    ],
  } as never);
}

describe("loggablePolarError", () => {
  test("keeps the status and detail of an HTTP error but not its message", () => {
    const loggable = loggablePolarError(validationError());

    expect(loggable).toMatchObject({
      name: "HTTPValidationError",
      statusCode: 422,
      detail: "A customer with this email address already exists.",
    });
    // The message embeds the response body, which echoes the input email.
    expect(JSON.stringify(loggable)).not.toContain(EMAIL);
  });

  test("keeps the message of a network error", () => {
    expect(loggablePolarError(new PolarNetworkError("Request timed out"))).toMatchObject({
      name: "PolarNetworkError",
      statusCode: null,
      message: expect.stringContaining("Request timed out"),
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
  test("reads a string detail from a parsed error body", () => {
    const error = new PolarClientError(400, { detail: "Seats cannot go below assigned seats" });
    expect(describePolarError(error)).toBe("Seats cannot go below assigned seats");
  });

  test("reads validation messages", () => {
    expect(describePolarError(validationError())).toBe(
      "A customer with this email address already exists."
    );
  });

  test("parses the raw text of an undeclared status code", () => {
    const error = new PolarClientError(409, JSON.stringify({ detail: "Already in progress" }));
    expect(describePolarError(error)).toBe("Already in progress");
  });

  test("returns null for a non-JSON body", () => {
    expect(describePolarError(new PolarClientError(400, "<html>Bad gateway</html>"))).toBeNull();
  });
});

describe("polarErrorCode", () => {
  test("reads the code from a parsed body, even when the type says null", () => {
    const error = new errors.CustomerSeatsAssignSeat400Error(400, {
      error: "SeatNotAvailable",
      detail: "No seats available",
    } as never);
    expect(polarErrorCode(error)).toBe("SeatNotAvailable");
  });

  test("reads the code from raw text", () => {
    const error = new PolarClientError(400, JSON.stringify({ error: "SeatAlreadyAssigned" }));
    expect(polarErrorCode(error)).toBe("SeatAlreadyAssigned");
  });

  test("returns null without a code", () => {
    expect(polarErrorCode(new Error("boom"))).toBeNull();
    expect(polarErrorCode(new PolarClientError(400, "plain text"))).toBeNull();
  });
});
