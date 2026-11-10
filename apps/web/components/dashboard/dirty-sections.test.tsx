import { describe, expect, it } from "vitest";
import { listSectionTitles } from "./dirty-sections";
import { isSettingsSection } from "./settings-primitives";

describe("listSectionTitles", () => {
  const section = (title: string) => ({ id: title.toLowerCase(), title });

  it("names one, two or more sections the way a sentence would", () => {
    expect(listSectionTitles([])).toBe("");
    expect(listSectionTitles([section("Responses")])).toBe("Responses");
    expect(listSectionTitles([section("Responses"), section("Alerts")])).toBe(
      "Responses and Alerts"
    );
    expect(listSectionTitles([section("Receiving"), section("Responses"), section("Alerts")])).toBe(
      "Receiving, Responses and Alerts"
    );
  });
});

describe("isSettingsSection", () => {
  it("accepts only the sections the settings panel has", () => {
    expect(isSettingsSection("forwarding")).toBe(true);
    expect(isSettingsSection("delete")).toBe(true);
    expect(isSettingsSection("nope")).toBe(false);
    expect(isSettingsSection("")).toBe(false);
    expect(isSettingsSection(null)).toBe(false);
  });
});
