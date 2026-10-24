/**
 * Vectors for conditions (conformance/rules.json) and placeholders
 * (conformance/placeholders.json). The receiver evaluates response rules and
 * fills in mock responses in Rust and runs these files in its tests
 * (apps/receiver-rs/src/handlers/rules.rs and placeholders.rs), so the
 * dashboard's preview, the forwarding worker and the receiver agree. Expected
 * values are written by hand; the test checks this SDK against them and fails
 * when a file on disk is out of date. After a deliberate change, regenerate
 * with `pnpm --filter @webhooks-cc/sdk exec vitest run rules-conformance -u`.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateConditions,
  type Condition,
  type ConditionGroup,
  type RuleSubject,
} from "../rules";
import {
  renderTemplate,
  requestTemplateContext,
  responseTemplateMode,
  type TemplateMode,
  type TemplateRequest,
} from "../placeholders";

const GENERATED_BY = "packages/sdk/src/__tests__/rules-conformance.test.ts";

interface VectorRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: string;
  contentType: string | null;
  size: number;
}

const ORDER_BODY =
  '{"type":"order.paid","data":{"id":"ord_1","amount":2000,"rate":1.5,"items":[{"sku":"a-1"},{"sku":"b-2"}],"flag":true,"none":null,"odd.key":"dot"}}';

const REQUESTS: Record<string, VectorRequest> = {
  order: {
    method: "POST",
    path: "/orders/123/items",
    headers: {
      "content-type": "application/json",
      "x-event": "order.paid",
      "x-count": "15",
      "x-note": 'say "hi"\t<b>&</b>',
    },
    query: { page: "2", q: "blue shoes" },
    body: ORDER_BODY,
    contentType: "application/json",
    size: 150,
  },
  form: {
    method: "POST",
    path: "/form",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    query: {},
    body: "name=Ada+Lovelace&email=ada%40example.com&tag=a&tag=b",
    contentType: "application/x-www-form-urlencoded; charset=utf-8",
    size: 52,
  },
  empty: {
    method: "GET",
    path: "/",
    headers: {},
    query: {},
    body: "",
    contentType: null,
    size: 0,
  },
  text: {
    method: "PUT",
    path: "/a/b",
    headers: { "content-type": "text/plain" },
    query: {},
    body: "line one\nline two café",
    contentType: "text/plain",
    size: 23,
  },
  numbers: {
    method: "POST",
    path: "/n",
    headers: {},
    query: {},
    body: '{"n":1.0,"big":1e22,"small":0.0000001,"neg":-0.5,"int":42,"text":"42"}',
    contentType: null,
    size: 70,
  },
};

interface ConditionVector {
  name: string;
  request: string;
  group: ConditionGroup;
  expected: boolean;
}

const c = (
  field: Condition["field"],
  op: Condition["op"],
  extra: Omit<Condition, "field" | "op"> = {}
): Condition => ({ field, op, ...extra });

const one = (
  name: string,
  request: string,
  condition: Condition,
  expected: boolean
): ConditionVector => ({ name, request, group: { conditions: [condition] }, expected });

const CONDITION_VECTORS: ConditionVector[] = [
  one("method eq ignores case", "order", c("method", "eq", { value: "post" }), true),
  one("method neq", "order", c("method", "neq", { value: "GET" }), true),
  one("method neq same", "empty", c("method", "neq", { value: "get" }), false),
  one("path eq", "order", c("path", "eq", { value: "/orders/123/items" }), true),
  one("path contains", "order", c("path", "contains", { value: "123" }), true),
  one("path not_contains", "order", c("path", "not_contains", { value: "admin" }), true),
  one("path starts_with", "order", c("path", "starts_with", { value: "/orders" }), true),
  one("path ends_with", "order", c("path", "ends_with", { value: "/items" }), true),
  one("glob star", "order", c("path", "matches", { value: "/orders/*/items" }), true),
  one("glob star stops at slash", "order", c("path", "matches", { value: "/orders/*" }), false),
  one("glob double star", "order", c("path", "matches", { value: "/orders/**" }), true),
  one(
    "glob double star in the middle",
    "order",
    c("path", "matches", { value: "/orders/**/items" }),
    true
  ),
  one("glob double star takes its slash", "text", c("path", "matches", { value: "/a/**/b" }), true),
  one(
    "glob question mark is one character",
    "order",
    c("path", "matches", { value: "/orders/12?/items" }),
    true
  ),
  one("glob question mark is not a slash", "text", c("path", "matches", { value: "/a?b" }), false),
  one("glob is anchored", "order", c("path", "matches", { value: "orders" }), false),
  one("glob dot is literal", "text", c("path", "matches", { value: "/a.b" }), false),
  one("path regex", "order", c("path", "regex", { value: "^/orders/[0-9]+/" }), true),
  one("regex inline case flag", "order", c("path", "regex", { value: "(?i)^/ORDERS" }), true),
  one("regex is a search", "order", c("path", "regex", { value: "items" }), true),
  one("regex miss", "order", c("path", "regex", { value: "^items" }), false),
  one("header exists in any case", "order", c("header", "exists", { name: "X-EVENT" }), true),
  one("header not_exists", "order", c("header", "not_exists", { name: "x-missing" }), true),
  one("header eq", "order", c("header", "eq", { name: "x-event", value: "order.paid" }), true),
  one(
    "header eq is case-sensitive",
    "order",
    c("header", "eq", { name: "x-event", value: "Order.Paid" }),
    false
  ),
  one(
    "header neq when absent",
    "order",
    c("header", "neq", { name: "x-missing", value: "x" }),
    true
  ),
  one(
    "header contains when absent",
    "order",
    c("header", "contains", { name: "x-missing", value: "x" }),
    false
  ),
  one(
    "header not_contains when absent",
    "order",
    c("header", "not_contains", { name: "x-missing", value: "x" }),
    true
  ),
  one("header regex", "order", c("header", "regex", { name: "x-event", value: "^order\\." }), true),
  one("header gt", "order", c("header", "gt", { name: "x-count", value: "10" }), true),
  one("header lte", "order", c("header", "lte", { name: "x-count", value: "15" }), true),
  one("number op on text", "order", c("header", "gt", { name: "x-event", value: "1" }), false),
  one("query eq", "order", c("query", "eq", { name: "page", value: "2" }), true),
  one("query contains", "order", c("query", "contains", { name: "q", value: "shoes" }), true),
  one("query names are case-sensitive", "order", c("query", "exists", { name: "Page" }), false),
  one("body contains", "order", c("body", "contains", { value: "ord_1" }), true),
  one("body not_contains", "order", c("body", "not_contains", { value: "nope" }), true),
  one("body regex", "order", c("body", "regex", { value: '"amount":\\s*2000' }), true),
  one(
    "legacy body_contains",
    "order",
    c("body_contains", "contains", { value: "order.paid" }),
    true
  ),
  one("dot does not match a line break", "text", c("body", "regex", { value: "one.line" }), false),
  one(
    "s flag lets dot match a line break",
    "text",
    c("body", "regex", { value: "(?s)one.line" }),
    true
  ),
  one("body_path string", "order", c("body_path", "eq", { path: "data.id", value: "ord_1" }), true),
  one(
    "body_path integer",
    "order",
    c("body_path", "eq", { path: "data.amount", value: "2000" }),
    true
  ),
  one("body_path gt", "order", c("body_path", "gt", { path: "data.amount", value: "1999" }), true),
  one(
    "body_path gte",
    "order",
    c("body_path", "gte", { path: "data.amount", value: "2000" }),
    true
  ),
  one("body_path lt", "order", c("body_path", "lt", { path: "data.amount", value: "2000" }), false),
  one(
    "body_path decimal",
    "order",
    c("body_path", "eq", { path: "data.rate", value: "1.5" }),
    true
  ),
  one(
    "body_path array index",
    "order",
    c("body_path", "eq", { path: "data.items.1.sku", value: "b-2" }),
    true
  ),
  one(
    "body_path bracket index",
    "order",
    c("body_path", "eq", { path: "data.items[0].sku", value: "a-1" }),
    true
  ),
  one(
    "body_path quoted key",
    "order",
    c("body_path", "eq", { path: 'data["odd.key"]', value: "dot" }),
    true
  ),
  one(
    "body_path boolean",
    "order",
    c("body_path", "eq", { path: "data.flag", value: "true" }),
    true
  ),
  one(
    "body_path null reads null",
    "order",
    c("body_path", "eq", { path: "data.none", value: "null" }),
    true
  ),
  one("body_path null exists", "order", c("body_path", "exists", { path: "data.none" }), true),
  one("body_path missing", "order", c("body_path", "not_exists", { path: "data.missing" }), true),
  one(
    "body_path index past the end",
    "order",
    c("body_path", "exists", { path: "data.items.5" }),
    false
  ),
  one(
    "body_path object as compact JSON",
    "order",
    c("body_path", "eq", { path: "data.items.0", value: '{"sku":"a-1"}' }),
    true
  ),
  one(
    "body_path neq when absent",
    "order",
    c("body_path", "neq", { path: "data.missing", value: "x" }),
    true
  ),
  one(
    "body_path glob",
    "order",
    c("body_path", "matches", { path: "data.items.0.sku", value: "a-*" }),
    true
  ),
  one(
    "body_path empty segments are skipped",
    "order",
    c("body_path", "eq", { path: "data..id", value: "ord_1" }),
    true
  ),
  one("form field", "form", c("body_path", "eq", { path: "name", value: "Ada Lovelace" }), true),
  one(
    "form field is decoded",
    "form",
    c("body_path", "eq", { path: "email", value: "ada@example.com" }),
    true
  ),
  one(
    "form field repeated keeps the last",
    "form",
    c("body_path", "eq", { path: "tag", value: "b" }),
    true
  ),
  one("body_path on an empty body", "empty", c("body_path", "exists", { path: "a" }), false),
  one("body_path on text", "text", c("body_path", "exists", { path: "line" }), false),
  one("integer-valued decimal", "numbers", c("body_path", "eq", { path: "n", value: "1" }), true),
  one("large number", "numbers", c("body_path", "eq", { path: "big", value: "1e+22" }), true),
  one("small number", "numbers", c("body_path", "eq", { path: "small", value: "1e-7" }), true),
  one("negative decimal", "numbers", c("body_path", "lt", { path: "neg", value: "0" }), true),
  one(
    "numeric text compares as a number",
    "numbers",
    c("body_path", "gte", { path: "text", value: "41.5" }),
    true
  ),
  one("content_type contains", "order", c("content_type", "contains", { value: "json" }), true),
  one(
    "content_type ignores case",
    "order",
    c("content_type", "eq", { value: "APPLICATION/JSON" }),
    true
  ),
  one(
    "content_type starts_with",
    "form",
    c("content_type", "starts_with", { value: "application/x-www-form-urlencoded" }),
    true
  ),
  one("content_type absent", "empty", c("content_type", "eq", { value: "" }), false),
  one(
    "content_type not_contains when absent",
    "empty",
    c("content_type", "not_contains", { value: "json" }),
    true
  ),
  one("size gt", "order", c("size", "gt", { value: "100" }), true),
  one("size eq", "order", c("size", "eq", { value: "150" }), true),
  one("size lt", "order", c("size", "lt", { value: "10" }), false),
  {
    name: "or: any condition",
    request: "order",
    group: {
      logic: "or",
      conditions: [c("method", "eq", { value: "GET" }), c("path", "contains", { value: "items" })],
    },
    expected: true,
  },
  {
    name: "and: every condition",
    request: "order",
    group: {
      logic: "and",
      conditions: [c("method", "eq", { value: "GET" }), c("path", "contains", { value: "items" })],
    },
    expected: false,
  },
  { name: "no conditions", request: "order", group: { conditions: [] }, expected: true },
  {
    name: "unknown field never holds",
    request: "order",
    group: { conditions: [{ field: "nope", op: "eq", value: "x" } as unknown as Condition] },
    expected: false,
  },
  {
    name: "operator the field does not take",
    request: "order",
    group: { conditions: [c("method", "contains", { value: "PO" })] },
    expected: false,
  },
];

function subjectOf(request: VectorRequest): RuleSubject {
  return { ...request, kind: "http" };
}

// Filters see more than the receiver does; these run in TypeScript only.
const EMAIL_SUBJECT: RuleSubject = {
  kind: "email",
  method: "POST",
  path: "box+invite@mailhooks.cc",
  headers: { subject: "Your code is 123456" },
  query: {},
  body: "",
  contentType: "message/rfc822",
  size: 2048,
  email: {
    subject: "Your code is 123456",
    from: "no-reply@acme.example",
    to: ["box+invite@mailhooks.cc", "team@acme.example"],
    text: "Use 123456 to sign in.",
    tag: "invite",
    spamScore: 6.5,
    auth: { spf: "pass", dkim: "fail", dmarc: null },
  },
  signature: null,
};

const FILTER_VECTORS: {
  name: string;
  subject: RuleSubject;
  condition: Condition;
  expected: boolean;
}[] = [
  {
    name: "kind",
    subject: EMAIL_SUBJECT,
    condition: c("kind", "eq", { value: "email" }),
    expected: true,
  },
  {
    name: "kind of an HTTP request",
    subject: subjectOf(REQUESTS.order),
    condition: c("kind", "eq", { value: "email" }),
    expected: false,
  },
  {
    name: "subject",
    subject: EMAIL_SUBJECT,
    condition: c("email", "contains", { name: "subject", value: "code" }),
    expected: true,
  },
  {
    name: "any recipient",
    subject: EMAIL_SUBJECT,
    condition: c("email", "ends_with", { name: "to", value: "@acme.example" }),
    expected: true,
  },
  {
    name: "no recipient",
    subject: EMAIL_SUBJECT,
    condition: c("email", "not_contains", { name: "to", value: "acme" }),
    expected: false,
  },
  {
    name: "tag",
    subject: EMAIL_SUBJECT,
    condition: c("email", "eq", { name: "tag", value: "invite" }),
    expected: true,
  },
  {
    name: "email part of an HTTP request",
    subject: subjectOf(REQUESTS.order),
    condition: c("email", "exists", { name: "subject" }),
    expected: false,
  },
  {
    name: "spam score",
    subject: EMAIL_SUBJECT,
    condition: c("spam_score", "gt", { value: "5" }),
    expected: true,
  },
  {
    name: "spf",
    subject: EMAIL_SUBJECT,
    condition: c("email_auth", "eq", { name: "spf", value: "pass" }),
    expected: true,
  },
  {
    name: "dmarc absent",
    subject: EMAIL_SUBJECT,
    condition: c("email_auth", "neq", { name: "dmarc", value: "pass" }),
    expected: true,
  },
  {
    name: "signature missing",
    subject: EMAIL_SUBJECT,
    condition: c("signature", "eq", { value: "missing" }),
    expected: true,
  },
  {
    name: "signature verified",
    subject: { ...subjectOf(REQUESTS.order), signature: "verified" },
    condition: c("signature", "eq", { value: "verified" }),
    expected: true,
  },
];

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

const UUID = "00000000-0000-4000-8000-000000000000";
const NOW = "2026-01-01T00:00:00.000Z";
const RECEIVED_AT = "2026-01-01T00:00:00.123Z";

function templateRequest(name: string): TemplateRequest {
  const request = REQUESTS[name];
  return {
    id: `req_${name}`,
    method: request.method,
    path: request.path,
    headers: request.headers,
    query: request.query,
    body: request.body,
    contentType: request.contentType,
    ip: "203.0.113.7",
    size: request.size,
    receivedAt: RECEIVED_AT,
    endpoint: { slug: "acme-orders", name: name === "empty" ? null : "Acme orders" },
  };
}

interface PlaceholderVector {
  name: string;
  request: string;
  template: string;
  mode: TemplateMode;
  maxBytes?: number;
  expected: string;
}

const p = (
  name: string,
  request: string,
  template: string,
  expected: string,
  mode: TemplateMode = "text",
  maxBytes?: number
): PlaceholderVector => ({
  name,
  request,
  template,
  mode,
  ...(maxBytes === undefined ? {} : { maxBytes }),
  expected,
});

const PLACEHOLDER_VECTORS: PlaceholderVector[] = [
  p("no placeholders", "order", "plain text", "plain text"),
  p("body field", "order", "Order {{ json.data.id }}", "Order ord_1"),
  p("method and path", "order", "{{ method }} {{ path }}", "POST /orders/123/items"),
  p("spaces are optional", "order", "{{method}}", "POST"),
  p("header in any case", "order", "{{ headers.X-Event }}", "order.paid"),
  p("query parameter", "order", "{{ query.page }}", "2"),
  p("integer", "order", "{{ json.data.amount }}", "2000"),
  p("decimal", "order", "{{ json.data.rate }}", "1.5"),
  p("boolean", "order", "{{ json.data.flag }}", "true"),
  p("null is empty in text", "order", "[{{ json.data.none }}]", "[]"),
  p("array as JSON", "order", "{{ json.data.items }}", '[{"sku":"a-1"},{"sku":"b-2"}]'),
  p("missing is empty", "order", "[{{ json.data.missing }}]", "[]"),
  p("default", "order", '{{ json.data.missing | default: "none" }}', "none"),
  p("default keeps a value", "order", '{{ json.data.id | default: "none" }}', "ord_1"),
  p("default replaces null", "order", '{{ json.data.none | default: "-" }}', "-"),
  p("default with a number", "order", "{{ json.data.missing | default: 0 }}", "0"),
  p("unknown root stays", "order", "Hello {{ name }}!", "Hello {{ name }}!"),
  p("upper", "order", "{{ json.data.id | upper }}", "ORD_1"),
  p("lower", "order", "{{ method | lower }}", "post"),
  p("filters chain", "order", '{{ json.data.missing | default: "None" | upper }}', "NONE"),
  p("json filter in text", "order", "{{ json.data.id | json }}", '"ord_1"'),
  p("json filter on missing", "order", "{{ json.data.missing | json }}", "null"),
  p("truncate", "order", "{{ body | truncate: 10 }}", '{"type":"…'),
  p("truncate shorter text", "order", "{{ method | truncate: 10 }}", "POST"),
  p(
    "json mode escapes strings",
    "order",
    '{"note": "{{ headers.x-note }}", "id": "{{ json.data.id }}"}',
    '{"note": "say \\"hi\\"\\t<b>&</b>", "id": "ord_1"}',
    "json"
  ),
  p(
    "json mode writes other values as JSON",
    "order",
    '{"amount": {{ json.data.amount }}, "items": {{ json.data.items }}, "none": {{ json.data.none }}, "flag": {{ json.data.flag }}}',
    '{"amount": 2000, "items": [{"sku":"a-1"},{"sku":"b-2"}], "none": null, "flag": true}',
    "json"
  ),
  p("json mode missing is empty", "order", '{"x": "{{ json.data.missing }}"}', '{"x": ""}', "json"),
  p(
    "json mode json filter is not escaped again",
    "order",
    '{"id": {{ json.data.id | json }}}',
    '{"id": "ord_1"}',
    "json"
  ),
  p(
    "html mode escapes",
    "order",
    "<p>{{ headers.x-note }}</p>",
    "<p>say &quot;hi&quot;\t&lt;b&gt;&amp;&lt;/b&gt;</p>",
    "html"
  ),
  p("generated values", "order", "{{ uuid }} {{ now }}", `${UUID} ${NOW}`),
  p("one uuid per render", "order", "{{ uuid }}={{ uuid }}", `${UUID}=${UUID}`),
  p(
    "request facts",
    "order",
    "{{ id }} {{ kind }} {{ ip }} {{ size }} {{ receivedAt }} {{ contentType }}",
    `req_order http 203.0.113.7 150 ${RECEIVED_AT} application/json`
  ),
  p("endpoint", "order", "{{ endpoint.slug }} / {{ endpoint.name }}", "acme-orders / Acme orders"),
  p("endpoint without a name", "empty", "[{{ endpoint.name }}]", "[]"),
  p("whole body", "text", "{{ body }}", "line one\nline two café"),
  p("form field", "form", "{{ json.name }} <{{ json.email }}>", "Ada Lovelace <ada@example.com>"),
  p("json of a text body is empty", "text", "[{{ json.line }}]", "[]"),
  p("json of an empty body is empty", "empty", "[{{ json }}]", "[]"),
  p("quoted key", "order", '{{ json.data["odd.key"] }}', "dot"),
  p("bracket index", "order", "{{ json.data.items[1].sku }}", "b-2"),
  p("empty braces stay", "order", "{{ }}", "{{ }}"),
  p("unknown filter stays", "order", "{{ method | nope }}", "{{ method | nope }}"),
  p("filter without its argument stays", "order", "{{ body | truncate }}", "{{ body | truncate }}"),
  p(
    "argument on a filter that takes none stays",
    "order",
    "{{ method | upper: 1 }}",
    "{{ method | upper: 1 }}"
  ),
  p("two words stay", "order", "{{ method path }}", "{{ method path }}"),
  p("unclosed stays", "order", "{{ method", "{{ method"),
  p("triple braces", "order", "{{{ method }}}", "{POST}"),
  p("single braces are text", "order", "{ {{ method }} }", "{ POST }"),
  p("path with a space stays", "order", "{{ json.data id }}", "{{ json.data id }}"),
  p(
    "numbers as JavaScript prints them",
    "numbers",
    "{{ json.n }}|{{ json.big }}|{{ json.small }}|{{ json.neg }}|{{ json.int }}",
    "1|1e+22|1e-7|-0.5|42"
  ),
  p(
    "numbers inside JSON",
    "numbers",
    "{{ json }}",
    '{"n":1,"big":1e+22,"small":1e-7,"neg":-0.5,"int":42,"text":"42"}'
  ),
  p("output cap", "order", "{{ body }}", '{"type":"o', "text", 10),
  p(
    "output cap keeps characters whole",
    "text",
    "{{ body }}{{ body }}",
    "line one\nline two caf",
    "text",
    22
  ),
  p("output cap applies to text too", "order", "abcdef{{ method }}", "abcd", "text", 4),
];

interface ModeVector {
  name: string;
  body: string;
  headers: Record<string, string>;
  expected: TemplateMode;
}

const MODE_VECTORS: ModeVector[] = [
  {
    name: "JSON content type",
    body: "ok",
    headers: { "Content-Type": "application/json" },
    expected: "json",
  },
  {
    name: "JSON suffix",
    body: "ok",
    headers: { "content-type": "application/problem+json; charset=utf-8" },
    expected: "json",
  },
  { name: "HTML", body: "{}", headers: { "content-type": "text/html" }, expected: "html" },
  { name: "XML", body: "<a/>", headers: { "content-type": "application/xml" }, expected: "html" },
  { name: "plain text", body: "{}", headers: { "content-type": "text/plain" }, expected: "text" },
  { name: "object without a type", body: '  {"ok": true}', headers: {}, expected: "json" },
  { name: "array without a type", body: "[1]", headers: {}, expected: "json" },
  { name: "text without a type", body: "ok", headers: {}, expected: "text" },
  { name: "empty without a type", body: "", headers: {}, expected: "text" },
];

function render(vector: PlaceholderVector): string {
  return renderTemplate(vector.template, requestTemplateContext(templateRequest(vector.request)), {
    mode: vector.mode,
    uuid: UUID,
    now: NOW,
    ...(vector.maxBytes === undefined ? {} : { maxBytes: vector.maxBytes }),
  });
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe("rule and placeholder vectors", () => {
  it("rules.json", async () => {
    for (const vector of CONDITION_VECTORS) {
      expect(
        evaluateConditions(vector.group, subjectOf(REQUESTS[vector.request])),
        vector.name
      ).toBe(vector.expected);
    }
    for (const vector of FILTER_VECTORS) {
      expect(
        evaluateConditions({ conditions: [vector.condition] }, vector.subject),
        vector.name
      ).toBe(vector.expected);
    }
    await expect(
      json({
        version: 1,
        generatedBy: GENERATED_BY,
        description:
          "Conditions of response rules and forwarding filters. Evaluate group (logic and conditions) against requests[request] and compare with expected. The receiver runs these for response rules.",
        requests: REQUESTS,
        vectors: CONDITION_VECTORS,
      })
    ).toMatchFileSnapshot("../../conformance/rules.json");
  });

  it("placeholders.json", async () => {
    for (const vector of PLACEHOLDER_VECTORS) {
      expect(render(vector), vector.name).toBe(vector.expected);
    }
    for (const vector of MODE_VECTORS) {
      expect(responseTemplateMode(vector.body, vector.headers), vector.name).toBe(vector.expected);
    }
    await expect(
      json({
        version: 1,
        generatedBy: GENERATED_BY,
        description:
          "Placeholders in mock responses. Build the template context from requests[request] with id req_<request>, ip 203.0.113.7, receivedAt " +
          RECEIVED_AT +
          ", endpoint slug acme-orders and name Acme orders (null for empty), uuid " +
          UUID +
          " and now " +
          NOW +
          "; render template in mode, stopping at maxBytes when given, and compare with expected. modes: the mode a mock response body gets from its body and headers.",
        requests: REQUESTS,
        vectors: PLACEHOLDER_VECTORS,
        modes: MODE_VECTORS,
      })
    ).toMatchFileSnapshot("../../conformance/placeholders.json");
  });
});
