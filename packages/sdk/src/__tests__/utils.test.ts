import { describe, it, expect } from "vitest";
import { parseDuration } from "../utils";

describe("parseDuration", () => {
  describe("number input", () => {
    it("returns number as-is", () => {
      expect(parseDuration(500)).toBe(500);
    });

    it("handles zero", () => {
      expect(parseDuration(0)).toBe(0);
    });

    it("throws on negative numbers", () => {
      expect(() => parseDuration(-100)).toThrow("must be a finite non-negative number");
    });

    it("throws on NaN", () => {
      expect(() => parseDuration(NaN)).toThrow("must be a finite non-negative number");
    });

    it("throws on Infinity", () => {
      expect(() => parseDuration(Infinity)).toThrow("must be a finite non-negative number");
    });
  });

  describe("milliseconds", () => {
    it("parses '500ms'", () => {
      expect(parseDuration("500ms")).toBe(500);
    });

    it("parses '0ms'", () => {
      expect(parseDuration("0ms")).toBe(0);
    });
  });

  describe("seconds", () => {
    it("parses '30s'", () => {
      expect(parseDuration("30s")).toBe(30000);
    });

    it("parses '1s'", () => {
      expect(parseDuration("1s")).toBe(1000);
    });
  });

  describe("minutes", () => {
    it("parses '5m'", () => {
      expect(parseDuration("5m")).toBe(300000);
    });

    it("parses '1m'", () => {
      expect(parseDuration("1m")).toBe(60000);
    });
  });

  describe("hours", () => {
    it("parses '1h'", () => {
      expect(parseDuration("1h")).toBe(3600000);
    });

    it("parses '2h'", () => {
      expect(parseDuration("2h")).toBe(7200000);
    });
  });

  describe("fractional durations", () => {
    it("parses '1.5s'", () => {
      expect(parseDuration("1.5s")).toBe(1500);
    });

    it("parses '0.5m'", () => {
      expect(parseDuration("0.5m")).toBe(30000);
    });
  });

  describe("plain numeric string", () => {
    it("parses '500' as milliseconds", () => {
      expect(parseDuration("500")).toBe(500);
    });

    it("parses '0' as zero", () => {
      expect(parseDuration("0")).toBe(0);
    });
  });

  describe("whitespace handling", () => {
    it("trims whitespace", () => {
      expect(parseDuration("  30s  ")).toBe(30000);
    });
  });

  describe("invalid input", () => {
    it("throws on invalid string", () => {
      expect(() => parseDuration("abc")).toThrow('Invalid duration: "abc"');
    });

    it("throws on empty string", () => {
      expect(() => parseDuration("")).toThrow('Invalid duration: ""');
    });

    it("throws on unsupported unit", () => {
      expect(() => parseDuration("5d")).toThrow('Invalid duration: "5d"');
    });

    it("throws on negative duration string", () => {
      expect(() => parseDuration("-5s")).toThrow('Invalid duration: "-5s"');
    });
  });
});
