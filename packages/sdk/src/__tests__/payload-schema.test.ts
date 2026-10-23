import { describe, expect, it } from "vitest";
import ts from "typescript";
import { z } from "zod";
import {
  generatePayloadSchema,
  generateRequestSchema,
  payloadSample,
  PAYLOAD_SCHEMA_FORMATS,
} from "../payload-schema";

const invoicePaid = {
  id: "evt_1",
  type: "invoice.paid",
  created: 1700000000,
  livemode: false,
  data: {
    object: {
      id: "in_1",
      amount_paid: 2000,
      currency: "usd",
      customer_email: "billing@acme.test",
      discount: null,
      lines: [
        { id: "il_1", amount: 2000, description: "Pro plan" },
        { id: "il_2", amount: 0, description: null, proration: true },
      ],
      billing_address: { line1: "1 Main St", city: "Springfield" },
      shipping_address: { line1: "2 Side St", city: "Shelbyville" },
    },
  },
};

const invoicePaidAgain = {
  id: "evt_2",
  type: "invoice.paid",
  created: 1700000500,
  livemode: false,
  data: {
    object: {
      id: "in_2",
      amount_paid: 12.5,
      currency: "eur",
      customer_email: null,
      discount: null,
      lines: [],
      billing_address: { line1: "3 High St", city: "Ogdenville" },
      shipping_address: { line1: "4 Low St", city: "North Haverbrook" },
    },
    previous_attributes: { status: "open" },
  },
};

// Parsed from text: a `__proto__` key in an object literal would set the prototype.
const awkwardKeys: unknown = JSON.parse(
  JSON.stringify({
    "x-request-id": "abc",
    class: "first",
    PROTO: "kept",
    "123": 1,
    json: true,
    model_id: "m1",
    Address: { street: "5 Elm" },
    nested: { deep: { deeper: [1, 2.5, "three"] } },
  }).replace('"PROTO"', '"__proto__"')
);

/** Type-check `code` plus one assignment per sample, as a strict TS module. */
function typeErrors(code: string, name: string, samples: unknown[]): string[] {
  const assignments = samples
    .map((sample, i) => `export const sample${i}: ${name} = ${JSON.stringify(sample)};`)
    .join("\n");
  const fileName = "generated.ts";
  const source = `${code}\n${assignments}\n`;
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    // Finds zod in node_modules, so Zod output is checked with its real types.
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    // zod's declarations expect DOM types this lib leaves out.
    skipLibCheck: true,
    types: [],
    lib: ["lib.es2022.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (file) => (file === fileName ? source : readFile(file));
  host.fileExists = (file) => file === fileName || fileExists(file);
  host.getSourceFile = (file, languageVersion, onError, shouldCreate) =>
    file === fileName
      ? ts.createSourceFile(file, source, languageVersion, true)
      : getSourceFile(file, languageVersion, onError, shouldCreate);
  const program = ts.createProgram([fileName], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

/** Evaluate generated Zod source and return its root schema. */
function loadZod(code: string, name: string): z.ZodType {
  const body = code
    .replace('import { z } from "zod";', "")
    .replace(/^export type .*$/gm, "")
    .replace(/^export const /gm, "const ");
  return new Function("z", `${body}\nreturn ${name};`)(z) as z.ZodType;
}

describe("generatePayloadSchema", () => {
  it("writes TypeScript interfaces for one sample", () => {
    const code = generatePayloadSchema([invoicePaid]);
    expect(code).toContain("export interface WebhookPayload {");
    expect(code).toContain("  data: Data;");
    // `Object` is a global, so the nested type takes its parent's name.
    expect(code).toContain("  object: DataObject;");
    expect(code).toContain("  lines: Line[];");
    expect(code).toContain("  discount: unknown; // null in every sample");
    expect(code).toContain("  amount_paid: number;");
    expect(typeErrors(code, "WebhookPayload", [invoicePaid])).toEqual([]);
  });

  it("learns optional and nullable fields from several samples", () => {
    const code = generatePayloadSchema([invoicePaid, invoicePaidAgain]);
    expect(code).toContain("  customer_email: string | null;");
    expect(code).toContain("  previous_attributes?: PreviousAttributes;");
    expect(code).toContain("  proration?: boolean;");
    expect(code).toContain("  description: string | null;");
    expect(typeErrors(code, "WebhookPayload", [invoicePaid, invoicePaidAgain])).toEqual([]);
  });

  it("declares identical nested objects once", () => {
    const code = generatePayloadSchema([invoicePaid]);
    expect(code).toContain("  billing_address: BillingAddress;");
    expect(code).toContain("  shipping_address: BillingAddress;");
    expect(code).not.toContain("interface ShippingAddress");
  });

  it("keeps integers apart from fractions", () => {
    const zodCode = generatePayloadSchema([invoicePaid], { format: "zod" });
    expect(zodCode).toContain("amount_paid: z.number().int(),");
    const merged = generatePayloadSchema([invoicePaid, invoicePaidAgain], { format: "zod" });
    expect(merged).toContain("amount_paid: z.number(),");
  });

  it("names the root after the option", () => {
    const code = generatePayloadSchema([invoicePaid], { name: "invoice.paid" });
    expect(code).toContain("export interface InvoicePaid {");
    expect(generatePayloadSchema([invoicePaid], { name: "" })).toContain(
      "export interface WebhookPayload {"
    );
    expect(generatePayloadSchema([invoicePaid], { name: "2fa code" })).toContain(
      "export interface T2faCode {"
    );
  });

  it("handles keys that are not identifiers", () => {
    const samples = [awkwardKeys];
    const code = generatePayloadSchema(samples);
    expect(code).toContain('  "x-request-id": string;');
    expect(code).toContain("  deeper: (string | number)[];");
    expect(code).toContain('  ["__proto__"]: unknown; // named like a built-in object property');
    expect(typeErrors(code, "WebhookPayload", samples)).toEqual([]);

    const zodCode = generatePayloadSchema(samples, { format: "zod" });
    expect(zodCode).toContain('["__proto__"]: z.unknown(),');
    expect(loadZod(zodCode, "WebhookPayload").safeParse(samples[0]).success).toBe(true);
  });

  it("types a root that is not an object", () => {
    const list = [[{ id: 1 }, { id: 2, name: "b" }]];
    const code = generatePayloadSchema(list);
    expect(code).toContain("export interface WebhookPayloadItem {");
    expect(code).toContain("export type WebhookPayload = WebhookPayloadItem[];");
    expect(typeErrors(code, "WebhookPayload", list)).toEqual([]);

    const mixed = [{ id: 1 }, "ping"];
    const mixedCode = generatePayloadSchema(mixed);
    expect(mixedCode).toContain("export interface WebhookPayloadObject {");
    expect(mixedCode).toContain("export type WebhookPayload = string | WebhookPayloadObject;");
    expect(typeErrors(mixedCode, "WebhookPayload", mixed)).toEqual([]);

    expect(generatePayloadSchema([])).toBe("export type WebhookPayload = unknown;\n");
    expect(generatePayloadSchema([{}])).toBe("export interface WebhookPayload {}\n");
    expect(generatePayloadSchema([{}], { format: "zod" })).toContain(
      "export const WebhookPayload = z.object({});"
    );
  });

  it("writes Zod schemas that accept every sample", () => {
    const samples = [invoicePaid, invoicePaidAgain];
    const code = generatePayloadSchema(samples, { format: "zod", name: "InvoicePaid" });
    expect(code.startsWith('import { z } from "zod";')).toBe(true);
    expect(code).toContain("export const InvoicePaid = z.object({");
    expect(code).toContain("export type InvoicePaid = z.infer<typeof InvoicePaid>;");
    expect(code).toContain("previous_attributes: PreviousAttributes.optional(),");
    expect(code).toContain("customer_email: z.string().nullable(),");
    const schema = loadZod(code, "InvoicePaid");
    for (const sample of samples) expect(schema.safeParse(sample).success).toBe(true);
    expect(schema.safeParse({ ...invoicePaid, id: 42 }).success).toBe(false);
  });

  it("writes Pydantic models with aliases for awkward keys", () => {
    const samples = [invoicePaid, invoicePaidAgain, awkwardKeys];
    const code = generatePayloadSchema(samples, { format: "pydantic" });
    expect(code).toContain("from typing import Any");
    expect(code).toContain("from pydantic import BaseModel, Field");
    expect(code).toContain("class WebhookPayload(BaseModel):");
    expect(code).toContain(
      '    x_request_id: str | None = Field(default=None, alias="x-request-id")'
    );
    expect(code).toContain('    class_: str | None = Field(default=None, alias="class")');
    expect(code).toContain('    json_: bool | None = Field(default=None, alias="json")');
    // Pydantic warns about any field starting with model_, whatever follows.
    expect(code).toContain(
      '    field_model_id: str | None = Field(default=None, alias="model_id")'
    );
    expect(code).toContain('    field_123: int | None = Field(default=None, alias="123")');
    // A field named like a generated class would shadow it in the class body.
    expect(code).toContain('    Address_: Address | None = Field(default=None, alias="Address")');
    expect(code).toContain("    discount: Any  # null in every sample");
    // Dependencies come first: Python evaluates annotations in order.
    expect(code.indexOf("class Data(BaseModel)")).toBeLessThan(
      code.indexOf("class WebhookPayload(BaseModel)")
    );
  });

  it("writes a Pydantic root model for a list payload", () => {
    const code = generatePayloadSchema([[1, 2]], { format: "pydantic" });
    expect(code).toBe(
      "from pydantic import RootModel\n\n\nclass WebhookPayload(RootModel[list[int]]):\n    pass\n"
    );
  });

  it("writes JSON Schema with shared definitions", () => {
    const code = generatePayloadSchema([invoicePaid, invoicePaidAgain], { format: "json-schema" });
    const schema = JSON.parse(code);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.title).toBe("WebhookPayload");
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["id", "type", "created", "livemode", "data"]);
    expect(schema.properties.data).toEqual({ $ref: "#/$defs/Data" });
    const invoice = schema.$defs.DataObject;
    expect(invoice.properties.amount_paid).toEqual({ type: "number" });
    expect(invoice.properties.customer_email).toEqual({ type: ["string", "null"] });
    expect(invoice.properties.discount).toEqual({ description: "null in every sample" });
    expect(invoice.properties.lines).toEqual({ type: "array", items: { $ref: "#/$defs/Line" } });
    expect(invoice.properties.shipping_address).toEqual({ $ref: "#/$defs/BillingAddress" });
    expect(schema.$defs.Data.required).toEqual(["object"]);
  });

  it("types keys named like inherited object members as unknown", () => {
    const samples: unknown[] = [{ id: 1, constructor: true, toString: "x" }, { id: 2 }];
    const code = generatePayloadSchema(samples);
    expect(code).toContain("  constructor?: unknown; // named like a built-in object property");
    expect(typeErrors(code, "WebhookPayload", samples)).toEqual([]);
    const schema = loadZod(generatePayloadSchema(samples, { format: "zod" }), "WebhookPayload");
    for (const sample of samples) expect(schema.safeParse(sample).success).toBe(true);
  });

  it("never names a type after a Python constant", () => {
    const code = generatePayloadSchema([{ none: { a: 1 }, true: { b: 2 } }], {
      format: "pydantic",
    });
    expect(code).not.toMatch(/class (None|True|False)\b/);
    expect(generatePayloadSchema([{ a: 1 }], { format: "pydantic", name: "none" })).toContain(
      "class NonePayload(BaseModel):"
    );
  });

  it("treats integers past 2^53 as plain numbers", () => {
    // Parsed, like a webhook body: the literal itself would lose precision.
    const samples: unknown[] = [JSON.parse('{"id": 1234567890123456789}')];
    const code = generatePayloadSchema(samples, { format: "zod" });
    expect(code).toContain("id: z.number(),");
    expect(loadZod(code, "WebhookPayload").safeParse(samples[0]).success).toBe(true);
  });

  it("keeps a __proto__ key in JSON Schema properties", () => {
    const sample = JSON.parse('{"__proto__": "x", "a": 1}');
    const schema = JSON.parse(generatePayloadSchema([sample], { format: "json-schema" }));
    expect(Object.keys(schema.properties)).toEqual(["__proto__", "a"]);
  });

  it("exports every format", () => {
    for (const format of PAYLOAD_SCHEMA_FORMATS) {
      expect(generatePayloadSchema([invoicePaid], { format }).length).toBeGreaterThan(0);
    }
    expect(() =>
      generatePayloadSchema([invoicePaid], { format: "yaml" as unknown as "zod" })
    ).toThrow("Unknown schema format: yaml");
  });

  it("types values nested too deep as unknown", () => {
    let value: unknown = "leaf";
    for (let i = 0; i < 40; i++) value = { next: value };
    const code = generatePayloadSchema([value]);
    expect(code).toContain("next: unknown;");
    expect(typeErrors(code, "WebhookPayload", [value])).toEqual([]);
  });

  it("stops nesting arrays before Zod's inferred type gets too deep for TypeScript", () => {
    let value: unknown = "leaf";
    for (let i = 0; i < 40; i++) value = [value];
    for (const format of ["typescript", "zod"] as const) {
      const code = generatePayloadSchema([value], { format });
      expect(typeErrors(code, "WebhookPayload", [value]), format).toEqual([]);
    }
  });
});

describe("payloadSample", () => {
  it("parses JSON whatever the content type says", () => {
    expect(payloadSample({ body: '{"a":1}', contentType: "text/plain" })).toEqual({ a: 1 });
    expect(payloadSample({ body: " [1]" })).toEqual([1]);
  });

  it("turns form bodies into string fields", () => {
    expect(
      payloadSample({
        body: "From=%2B15551234567&Body=hi&Tag=a&Tag=b",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      })
    ).toEqual({ From: "+15551234567", Body: "hi", Tag: ["a", "b"] });
  });

  it("skips emails, empty and other bodies", () => {
    expect(payloadSample({ body: '{"a":1}', kind: "email" })).toBeUndefined();
    expect(payloadSample({ body: "" })).toBeUndefined();
    expect(payloadSample({ body: "<xml/>", contentType: "application/xml" })).toBeUndefined();
    expect(payloadSample({ body: "{broken", contentType: "application/json" })).toBeUndefined();
  });
});

describe("generateRequestSchema", () => {
  it("counts the samples it used and the requests it skipped", () => {
    const result = generateRequestSchema(
      [
        { body: JSON.stringify(invoicePaid), contentType: "application/json" },
        { body: JSON.stringify(invoicePaidAgain), contentType: "application/json" },
        { body: "plain text", contentType: "text/plain" },
        { body: "Subject: hi", kind: "email" },
      ],
      { format: "zod", name: "InvoicePaid" }
    );
    expect(result.samples).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.format).toBe("zod");
    expect(result.name).toBe("InvoicePaid");
    expect(result.code).toContain("customer_email: z.string().nullable(),");
  });
});
