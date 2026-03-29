import { describe, it, expect } from "vitest";
import SwaggerParser from "@apidevtools/swagger-parser";
import path from "path";

describe("OpenAPI specification", () => {
  it("is a valid OpenAPI 3.1 document", async () => {
    const specPath = path.resolve(__dirname, "../../public/openapi.yaml");
    const api = await SwaggerParser.validate(specPath);

    expect(api.openapi).toBe("3.1.0");
    expect(api.info.title).toBe("webhooks.cc API");
    expect(api.paths).toBeDefined();
    expect(Object.keys(api.paths!).length).toBeGreaterThan(10);
  });

  it("has no unresolved $ref references", async () => {
    const specPath = path.resolve(__dirname, "../../public/openapi.yaml");
    const api = await SwaggerParser.dereference(specPath);
    expect(api).toBeDefined();
  });
});
