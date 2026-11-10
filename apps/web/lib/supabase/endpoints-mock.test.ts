import { describe, expect, it } from "vitest";
import { storableMockResponse } from "./endpoints";

describe("storableMockResponse", () => {
  it("fills in the body and headers the receiver needs beside a status", () => {
    expect(storableMockResponse({ status: 402 })).toEqual({ status: 402, body: "", headers: {} });
    expect(
      storableMockResponse({ status: 201, body: "ok", headers: { "x-a": "b" }, delay: 5 })
    ).toEqual({ status: 201, body: "ok", headers: { "x-a": "b" }, delay: 5 });
  });

  it("stores nothing for nothing", () => {
    expect(storableMockResponse(null)).toBeNull();
    expect(storableMockResponse(undefined)).toBeNull();
  });
});
