import { describe, expect, it } from "vitest";
import schema from "zapier-platform-schema";
import App from "../index.js";

/** The app definition as Zapier's CLI checks it before a push (functions stand in as code). */
describe("the Zapier app definition", () => {
  it("passes Zapier's schema", () => {
    const definition = JSON.parse(
      JSON.stringify(App, (key, value) =>
        typeof value === "function" ? { source: "return []" } : value
      )
    );
    const result = schema.validateAppDefinition(definition);
    expect(result.errors.map((error) => `${error.property} ${error.message}`)).toEqual([]);
  });

  it("offers a trigger, two actions and a search", () => {
    expect(Object.keys(App.triggers)).toEqual(["endpoint", "new_email"]);
    expect(Object.keys(App.creates)).toEqual(["create_endpoint", "send_test_email"]);
    expect(Object.keys(App.searches)).toEqual(["find_email"]);
    expect(App.triggers.new_email.operation.type).toBe("hook");
  });
});
