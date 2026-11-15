import { describe, it, expect } from "vitest";
import SwaggerParser from "@apidevtools/swagger-parser";
import path from "path";
import { readFileSync } from "fs";

describe("OpenAPI specification", () => {
  it("is a valid OpenAPI 3.1 document", async () => {
    const specPath = path.resolve(__dirname, "../../public/openapi.yaml");
    const api = await SwaggerParser.validate(specPath);

    expect((api as Record<string, unknown>).openapi).toBe("3.1.0");
    expect(api.info.title).toBe("webhooks.cc API");
    expect(api.paths).toBeDefined();
    expect(Object.keys(api.paths!).length).toBeGreaterThan(10);
  });

  it("has no unresolved $ref references", async () => {
    const specPath = path.resolve(__dirname, "../../public/openapi.yaml");
    const api = await SwaggerParser.dereference(specPath);
    expect(api).toBeDefined();
  });

  it("names every approval action the server can answer with", async () => {
    const specPath = path.resolve(__dirname, "../../public/openapi.yaml");
    const api = (await SwaggerParser.dereference(specPath)) as unknown as {
      components: { schemas: Record<string, { properties: Record<string, { enum?: string[] }> }> };
    };
    const documented = api.components.schemas.Approval.properties.action.enum ?? [];
    const source = readFileSync(path.resolve(__dirname, "../../lib/approvals/actions.ts"), "utf8");
    const union = /export type ApprovalAction =([^;]+);/.exec(source)?.[1] ?? "";
    const actions = [...union.matchAll(/"([a-z_.]+)"/g)].map((match) => match[1]);
    expect(actions).toContain("billing.agent_budget");
    expect([...documented].sort()).toEqual([...actions].sort());
  });

  it("documents a browser's plan change apart from one made on the agent budget", async () => {
    const specPath = path.resolve(__dirname, "../../public/openapi.yaml");
    const api = (await SwaggerParser.dereference(specPath)) as unknown as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    for (const route of ["/api/billing/change-plan", "/api/teams/{teamId}/billing/plan"]) {
      const ok = api.paths[route].post.responses["200"] as {
        content: { "application/json": { schema: { oneOf?: { required?: string[] }[] } } };
      };
      const shapes = ok.content["application/json"].schema.oneOf ?? [];
      expect(shapes.map((shape) => shape.required)).toEqual([
        ["applied"],
        ["executed", "applied", "viaBudget"],
      ]);
    }
  });
});
