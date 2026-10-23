/**
 * Payload schemas from captured requests. One shape is inferred from every
 * sample (a field missing from some samples is optional, a field that is
 * sometimes null is nullable, numbers stay integers until a fraction shows
 * up), then written out as TypeScript, Zod, Pydantic, or JSON Schema.
 *
 * Self-contained on purpose: the dashboard imports it in the browser through
 * `@webhooks-cc/sdk/schema`, so it must not pull in the client.
 */

export type PayloadSchemaFormat = "typescript" | "zod" | "pydantic" | "json-schema";

export const PAYLOAD_SCHEMA_FORMATS: readonly PayloadSchemaFormat[] = [
  "typescript",
  "zod",
  "pydantic",
  "json-schema",
];

export interface PayloadSchemaOptions {
  /** Output language (default: "typescript"). */
  format?: PayloadSchemaFormat;
  /** Name of the root type (default: "WebhookPayload"). */
  name?: string;
}

/** The fields of a captured request that schema generation reads. */
export interface SchemaRequestLike {
  body?: string | null;
  contentType?: string | null;
  headers?: Record<string, string>;
  kind?: string;
}

export interface RequestSchemaResult {
  /** The generated source. */
  code: string;
  format: PayloadSchemaFormat;
  /** Name of the root type. */
  name: string;
  /** Requests whose body was used as a sample. */
  samples: number;
  /** Requests skipped: emails, and bodies that are neither JSON nor form data. */
  skipped: number;
}

const DEFAULT_NAME = "WebhookPayload";
/** Values nested deeper than this are typed as unknown. */
const MAX_DEPTH = 32;

interface Shape {
  /** Values seen at this position, nulls included. */
  count: number;
  null: boolean;
  boolean: boolean;
  string: boolean;
  /** "integer" while every number seen is an integer. */
  number: "integer" | "float" | null;
  /** Shape of the elements of every array seen here. */
  array: Shape | null;
  object: ObjectShape | null;
  /** Something nested past MAX_DEPTH was seen here. */
  deep: boolean;
}

interface ObjectShape {
  /** Objects seen at this position. */
  count: number;
  /** A Map keeps keys in the order they first appeared, numeric keys included. */
  fields: Map<string, Shape>;
}

function emptyShape(): Shape {
  return {
    count: 0,
    null: false,
    boolean: false,
    string: false,
    number: null,
    array: null,
    object: null,
    deep: false,
  };
}

function observe(shape: Shape, value: unknown, depth: number): void {
  shape.count++;
  if (value === null || value === undefined) {
    shape.null = true;
    return;
  }
  switch (typeof value) {
    case "string":
      shape.string = true;
      return;
    case "boolean":
      shape.boolean = true;
      return;
    case "number":
      // Past 2^53 a JSON number has already lost precision, and Zod's int()
      // refuses it, so it counts as a plain number.
      shape.number = shape.number === "float" || !Number.isSafeInteger(value) ? "float" : "integer";
      return;
    case "object":
      break;
    default:
      shape.deep = true;
      return;
  }
  if (depth >= MAX_DEPTH) {
    shape.deep = true;
    return;
  }
  if (Array.isArray(value)) {
    shape.array ??= emptyShape();
    for (const item of value) observe(shape.array, item, depth + 1);
    return;
  }
  shape.object ??= { count: 0, fields: new Map() };
  shape.object.count++;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    let field = shape.object.fields.get(key);
    if (!field) {
      field = emptyShape();
      shape.object.fields.set(key, field);
    }
    observe(field, child, depth + 1);
  }
}

function inferShape(samples: readonly unknown[]): Shape {
  const root = emptyShape();
  for (const sample of samples) observe(root, sample, 0);
  return root;
}

// ---------------------------------------------------------------------------
// Named object types, shared by every output format

interface FieldDecl {
  key: string;
  shape: Shape;
  required: boolean;
}

interface ObjectDecl {
  name: string;
  fields: FieldDecl[];
}

interface Model {
  rootName: string;
  root: Shape;
  /** The root is always an object, so its declaration carries the root name. */
  objectRoot: boolean;
  /** Declarations in dependency order: an object comes after the objects it uses. */
  decls: ObjectDecl[];
  names: Map<ObjectShape, string>;
}

/** Names a generated type must not take: globals in TS, imports in Python. */
const RESERVED_NAMES = new Set([
  "Any",
  "False",
  "None",
  "True",
  "Array",
  "BaseModel",
  "Blob",
  "Boolean",
  "Date",
  "Error",
  "Event",
  "Field",
  "File",
  "Function",
  "Headers",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Object",
  "Omit",
  "Partial",
  "Pick",
  "Promise",
  "Readonly",
  "Record",
  "RegExp",
  "Request",
  "Required",
  "Response",
  "RootModel",
  "Set",
  "String",
  "Symbol",
  "URL",
]);

function pascalCase(input: string): string {
  const words = input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
}

function singular(name: string): string {
  if (/ies$/.test(name) && name.length > 4) return name.slice(0, -3) + "y";
  if (/(ss|x|ch|sh)es$/.test(name)) return name.slice(0, -2);
  if (/uses$/.test(name)) return name.slice(0, -2);
  if (/[^su]s$/.test(name) && name.length > 3) return name.slice(0, -1);
  return name + "Item";
}

function buildModel(root: Shape, rootName: string): Model {
  const decls: ObjectDecl[] = [];
  const names = new Map<ObjectShape, string>();
  const used = new Set<string>([rootName]);
  const bySignature = new Map<string, string>();
  // Structural signatures, interned to small ids so nesting stays linear.
  const ids = new Map<string, number>();
  const shapeIds = new WeakMap<Shape, number>();

  function intern(signature: string): number {
    let id = ids.get(signature);
    if (id === undefined) {
      id = ids.size;
      ids.set(signature, id);
    }
    return id;
  }

  function signatureOf(shape: Shape): number {
    const cached = shapeIds.get(shape);
    if (cached !== undefined) return cached;
    const parts = [
      shape.null ? "n" : "",
      shape.boolean ? "b" : "",
      shape.string ? "s" : "",
      shape.number ?? "",
      shape.deep ? "u" : "",
      shape.array ? `[${signatureOf(shape.array)}]` : "",
      shape.object ? `{${objectSignature(shape.object)}}` : "",
    ];
    const id = intern(parts.join("|"));
    shapeIds.set(shape, id);
    return id;
  }

  function objectSignature(object: ObjectShape): string {
    return [...object.fields.entries()]
      .map(
        ([key, field]) =>
          `${JSON.stringify(key)}${field.count < object.count ? "?" : ""}:${signatureOf(field)}`
      )
      .sort()
      .join(",");
  }

  function allocate(hint: string, parent: string): string {
    let base = pascalCase(hint) || "Field";
    if (/^[0-9]/.test(base)) base = `${parent}${base}`;
    if (RESERVED_NAMES.has(base)) base = `${parent}${base}`;
    let name = base;
    for (let i = 2; used.has(name) || RESERVED_NAMES.has(name); i++) name = `${base}${i}`;
    used.add(name);
    return name;
  }

  function visit(shape: Shape, hint: string, parent: string): void {
    if (shape.array) visit(shape.array, singular(pascalCase(hint) || "Item"), parent);
    if (shape.object) visitObject(shape.object, hint, parent, null);
  }

  function visitObject(
    object: ObjectShape,
    hint: string,
    parent: string,
    ownName: string | null
  ): void {
    // An object identical to one already declared reuses that declaration;
    // its own nested objects are never rendered, so they need no names.
    const signature = objectSignature(object);
    const existing = ownName ? undefined : bySignature.get(signature);
    if (existing) {
      names.set(object, existing);
      return;
    }
    const name = ownName ?? allocate(hint, parent);
    if (!ownName) bySignature.set(signature, name);
    names.set(object, name);
    for (const [key, field] of object.fields) visit(field, key, name);
    decls.push({
      name,
      fields: [...object.fields.entries()].map(([key, field]) => ({
        key,
        shape: field,
        required: field.count === object.count,
      })),
    });
  }

  const objectRoot = root.object !== null && !root.null && !hasOtherKinds(root);
  if (root.object && objectRoot) {
    visitObject(root.object, rootName, rootName, rootName);
  } else {
    // The root needs an alias of its own (`type X = A | B[]`), so an object
    // in it takes a derived name.
    if (root.array) visit(root.array, singular(rootName), rootName);
    if (root.object) visitObject(root.object, `${rootName}Object`, rootName, null);
  }
  return { rootName, root, objectRoot, decls, names };
}

function nameOf(model: Model, object: ObjectShape): string {
  const name = model.names.get(object);
  if (!name) throw new Error("payload schema: object without a declaration");
  return name;
}

/** A shape that only ever held null (or nothing) has no type to show. */
function isUntyped(shape: Shape): boolean {
  return !shape.boolean && !shape.string && shape.number === null && !shape.array && !shape.object;
}

const NULL_ONLY_NOTE = "null in every sample";

/**
 * Keys every object inherits (constructor, toString, __proto__...). A typed
 * field with such a name breaks TypeScript and Zod when the key is absent,
 * because both then see the inherited value, so they are typed unknown.
 */
const INHERITED_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype));
const INHERITED_NOTE = "named like a built-in object property";

function fieldNote(field: FieldDecl, comment: string): string {
  if (INHERITED_KEYS.has(field.key)) return ` ${comment} ${INHERITED_NOTE}`;
  return field.shape.null && isUntyped(field.shape) ? ` ${comment} ${NULL_ONLY_NOTE}` : "";
}

// ---------------------------------------------------------------------------
// TypeScript

const JS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function jsKey(key: string): string {
  // A bare or quoted `__proto__:` in an object literal sets the prototype.
  if (key === "__proto__") return '["__proto__"]';
  return JS_IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

function tsType(model: Model, shape: Shape): string {
  if (isUntyped(shape)) return "unknown";
  const variants: string[] = [];
  if (shape.string) variants.push("string");
  if (shape.number) variants.push("number");
  if (shape.boolean) variants.push("boolean");
  if (shape.object) variants.push(nameOf(model, shape.object));
  if (shape.array) {
    const item = tsType(model, shape.array);
    variants.push(/[ |]/.test(item) ? `(${item})[]` : `${item}[]`);
  }
  if (shape.deep) variants.push("unknown");
  if (shape.null) variants.push("null");
  return variants.join(" | ");
}

function renderTypeScript(model: Model): string {
  const blocks = model.decls.map((decl) => {
    const lines = decl.fields.map((field) => {
      const optional = field.required ? "" : "?";
      const type = INHERITED_KEYS.has(field.key) ? "unknown" : tsType(model, field.shape);
      return `  ${jsKey(field.key)}${optional}: ${type};${fieldNote(field, "//")}`;
    });
    return lines.length
      ? `export interface ${decl.name} {\n${lines.join("\n")}\n}`
      : `export interface ${decl.name} {}`;
  });
  if (!model.objectRoot) {
    blocks.push(`export type ${model.rootName} = ${tsType(model, model.root)};`);
  }
  return blocks.join("\n\n") + "\n";
}

/** True when the root is not just an object, so it needs a type alias. */
function hasOtherKinds(shape: Shape): boolean {
  return (
    shape.boolean ||
    shape.string ||
    shape.number !== null ||
    shape.array !== null ||
    shape.deep ||
    isUntyped(shape)
  );
}

// ---------------------------------------------------------------------------
// Zod

function zodType(model: Model, shape: Shape): string {
  if (isUntyped(shape)) return "z.unknown()";
  const variants: string[] = [];
  if (shape.string) variants.push("z.string()");
  if (shape.number === "integer") variants.push("z.number().int()");
  if (shape.number === "float") variants.push("z.number()");
  if (shape.boolean) variants.push("z.boolean()");
  if (shape.object) variants.push(nameOf(model, shape.object));
  if (shape.array) variants.push(`z.array(${zodType(model, shape.array)})`);
  if (shape.deep) variants.push("z.unknown()");
  const base = variants.length === 1 ? variants[0] : `z.union([${variants.join(", ")}])`;
  return shape.null ? `${base}.nullable()` : base;
}

function renderZod(model: Model): string {
  const blocks = ['import { z } from "zod";'];
  for (const decl of model.decls) {
    const lines = decl.fields.map((field) => {
      const optional = field.required ? "" : ".optional()";
      const type = INHERITED_KEYS.has(field.key) ? "z.unknown()" : zodType(model, field.shape);
      return `  ${jsKey(field.key)}: ${type}${optional},${fieldNote(field, "//")}`;
    });
    blocks.push(
      lines.length
        ? `export const ${decl.name} = z.object({\n${lines.join("\n")}\n});`
        : `export const ${decl.name} = z.object({});`
    );
  }
  if (!model.objectRoot) {
    blocks.push(`export const ${model.rootName} = ${zodType(model, model.root)};`);
  }
  blocks.push(`export type ${model.rootName} = z.infer<typeof ${model.rootName}>;`);
  return blocks.join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Pydantic (v2, Python 3.10+)

const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

/**
 * Field names that would shadow something: BaseModel attributes, and the
 * names the annotations use (a field with a default binds its name in the
 * class body, so a later `list[...]` would see the field, not the type).
 */
const PYTHON_SHADOWED = new Set([
  "Any",
  "BaseModel",
  "Field",
  "RootModel",
  "bool",
  "construct",
  "copy",
  "dict",
  "fields",
  "float",
  "int",
  "json",
  "list",
  "schema",
  "str",
  "validate",
]);

function pythonType(model: Model, shape: Shape): string {
  if (isUntyped(shape)) return "Any";
  const variants: string[] = [];
  if (shape.string) variants.push("str");
  if (shape.number === "integer") variants.push("int");
  if (shape.number === "float") variants.push("float");
  if (shape.boolean) variants.push("bool");
  if (shape.object) variants.push(nameOf(model, shape.object));
  if (shape.array) variants.push(`list[${pythonType(model, shape.array)}]`);
  if (shape.deep) variants.push("Any");
  if (shape.null) variants.push("None");
  return variants.join(" | ");
}

function pythonFieldName(key: string, taken: Set<string>, classNames: Set<string>): string {
  let name = key
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");
  if (!name) name = "field";
  if (/^[0-9]/.test(name)) name = `field_${name}`;
  if (
    PYTHON_KEYWORDS.has(name) ||
    PYTHON_SHADOWED.has(name) ||
    classNames.has(name) ||
    name.startsWith("model_")
  ) {
    name = `${name}_`;
  }
  let candidate = name;
  for (let i = 2; taken.has(candidate); i++) candidate = `${name}_${i}`;
  taken.add(candidate);
  return candidate;
}

function renderPydantic(model: Model): string {
  const classNames = new Set([model.rootName, ...model.decls.map((decl) => decl.name)]);
  let usesField = false;
  const classes = model.decls.map((decl) => {
    const taken = new Set<string>();
    const lines = decl.fields.map((field) => {
      const name = pythonFieldName(field.key, taken, classNames);
      const aliased = name !== field.key;
      let type = pythonType(model, field.shape);
      if (!field.required && !field.shape.null && !isUntyped(field.shape)) type += " | None";
      const note = field.shape.null && isUntyped(field.shape) ? `  # ${NULL_ONLY_NOTE}` : "";
      let value = "";
      if (aliased) {
        usesField = true;
        const alias = `alias=${JSON.stringify(field.key)}`;
        value = field.required ? ` = Field(${alias})` : ` = Field(default=None, ${alias})`;
      } else if (!field.required) {
        value = " = None";
      }
      return `    ${name}: ${type}${value}${note}`;
    });
    return `class ${decl.name}(BaseModel):\n${lines.length ? lines.join("\n") : "    pass"}`;
  });

  const needsRoot = !model.objectRoot;
  if (needsRoot) {
    classes.push(`class ${model.rootName}(RootModel[${pythonType(model, model.root)}]):\n    pass`);
  }

  const body = classes.join("\n\n\n");
  const pydanticImports = [
    ...(model.decls.length ? ["BaseModel"] : []),
    ...(usesField ? ["Field"] : []),
    ...(needsRoot ? ["RootModel"] : []),
  ];
  const header = [
    ...(/\bAny\b/.test(body) ? ["from typing import Any", ""] : []),
    `from pydantic import ${pydanticImports.join(", ")}`,
  ];
  return `${header.join("\n")}\n\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// JSON Schema (draft 2020-12)

type JsonSchema = Record<string, unknown>;

function jsonSchemaType(model: Model, shape: Shape): JsonSchema {
  if (shape.deep) return {};
  if (isUntyped(shape)) return shape.null ? { description: NULL_ONLY_NOTE } : {};
  const simple: string[] = [];
  const complex: JsonSchema[] = [];
  if (shape.string) simple.push("string");
  if (shape.number) simple.push(shape.number === "integer" ? "integer" : "number");
  if (shape.boolean) simple.push("boolean");
  if (shape.object) complex.push({ $ref: `#/$defs/${nameOf(model, shape.object)}` });
  if (shape.array) {
    complex.push(
      shape.array.count === 0
        ? { type: "array" }
        : { type: "array", items: jsonSchemaType(model, shape.array) }
    );
  }
  if (shape.null) simple.push("null");
  const type = simple.length === 1 ? simple[0] : simple;
  if (complex.length === 0) return { type };
  if (simple.length === 0 && complex.length === 1) return complex[0];
  return { anyOf: simple.length ? [...complex, { type }] : complex };
}

function objectSchema(model: Model, decl: ObjectDecl): JsonSchema {
  // Null prototype: a "__proto__" key must stay a property.
  const properties: Record<string, JsonSchema> = Object.create(null);
  for (const field of decl.fields) properties[field.key] = jsonSchemaType(model, field.shape);
  const required = decl.fields.filter((field) => field.required).map((field) => field.key);
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function renderJsonSchema(model: Model): string {
  const defs: Record<string, JsonSchema> = Object.create(null);
  let body: JsonSchema | null = null;
  for (const decl of model.decls) {
    if (model.objectRoot && decl.name === model.rootName) body = objectSchema(model, decl);
    else defs[decl.name] = objectSchema(model, decl);
  }
  const schema: JsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: model.rootName,
    ...(body ?? jsonSchemaType(model, model.root)),
    ...(Object.keys(defs).length ? { $defs: defs } : {}),
  };
  return JSON.stringify(schema, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Public API

function rootNameFrom(name: string | undefined): string {
  const cleaned = pascalCase(name ?? "");
  if (!cleaned) return DEFAULT_NAME;
  if (/^[0-9]/.test(cleaned)) return `T${cleaned}`;
  return RESERVED_NAMES.has(cleaned) ? `${cleaned}Payload` : cleaned;
}

/**
 * Generate a schema from parsed payload samples. Pass several samples of the
 * same event to learn which fields are optional or nullable.
 *
 * @example
 * ```ts
 * generatePayloadSchema([{ id: "evt_1", amount: 100 }], { format: "zod", name: "Invoice" });
 * ```
 */
export function generatePayloadSchema(
  samples: readonly unknown[],
  options: PayloadSchemaOptions = {}
): string {
  const format = options.format ?? "typescript";
  const model = buildModel(inferShape(samples), rootNameFrom(options.name));
  switch (format) {
    case "typescript":
      return renderTypeScript(model);
    case "zod":
      return renderZod(model);
    case "pydantic":
      return renderPydantic(model);
    case "json-schema":
      return renderJsonSchema(model);
    default:
      throw new Error(`Unknown schema format: ${String(format)}`);
  }
}

function headerValue(headers: Record<string, string> | undefined, name: string) {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/**
 * The payload of a captured request as a schema sample: its JSON body, or its
 * form fields as strings. Undefined for emails and other bodies.
 */
export function payloadSample(request: SchemaRequestLike): unknown {
  if (request.kind === "email" || !request.body) return undefined;
  const body = request.body;
  const contentType = (request.contentType ?? headerValue(request.headers, "content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      // Not JSON after all; fall through to the form check.
    }
  }
  if (contentType === "application/x-www-form-urlencoded") {
    const fields: Record<string, string | string[]> = Object.create(null);
    for (const [key, value] of new URLSearchParams(body)) {
      const existing = fields[key];
      if (existing === undefined) fields[key] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else fields[key] = [existing, value];
    }
    return { ...fields };
  }
  return undefined;
}

/**
 * Generate a schema from captured requests: JSON bodies and form fields are
 * samples, emails and other bodies are skipped.
 *
 * @example
 * ```ts
 * const requests = await client.requests.list(slug, { limit: 20 });
 * const { code } = generateRequestSchema(requests, { format: "zod" });
 * ```
 */
export function generateRequestSchema(
  requests: readonly SchemaRequestLike[],
  options: PayloadSchemaOptions = {}
): RequestSchemaResult {
  const samples: unknown[] = [];
  for (const request of requests) {
    const sample = payloadSample(request);
    if (sample !== undefined) samples.push(sample);
  }
  return {
    code: generatePayloadSchema(samples, options),
    format: options.format ?? "typescript",
    name: rootNameFrom(options.name),
    samples: samples.length,
    skipped: requests.length - samples.length,
  };
}
