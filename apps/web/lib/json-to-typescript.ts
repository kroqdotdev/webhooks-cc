const JS_IDENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/**
 * Converts a JSON value to a TypeScript interface string.
 * Returns null if the input is not valid JSON or not an object.
 */
export function jsonToTypeScript(json: string, name = "WebhookPayload"): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object") return null;

  const lines: string[] = [];
  const subInterfaces: string[] = [];
  const usedNames = new Set<string>();

  function uniqueName(base: string): string {
    let candidate = base;
    let i = 2;
    while (usedNames.has(candidate)) {
      candidate = `${base}${i++}`;
    }
    usedNames.add(candidate);
    return candidate;
  }

  function capitalize(s: string): string {
    const clean = s.replace(/[^a-zA-Z0-9_]/g, "");
    if (!clean) return uniqueName("Sub");
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }

  function mergeObjectKeys(items: unknown[]): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const item of items) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        for (const [key, val] of Object.entries(item as Record<string, unknown>)) {
          if (!(key in merged)) merged[key] = val;
        }
      }
    }
    return merged;
  }

  function inferType(value: unknown, fieldName: string, depth: number): string {
    if (value === null) return "unknown";
    if (typeof value === "string") return "string";
    if (typeof value === "number") return "number";
    if (typeof value === "boolean") return "boolean";

    if (Array.isArray(value)) {
      if (value.length === 0) return "unknown[]";
      const allObjects = value.every(
        (v) => v !== null && typeof v === "object" && !Array.isArray(v)
      );
      if (allObjects) {
        const merged = mergeObjectKeys(value);
        const elementType = inferType(merged, fieldName, depth);
        return `${elementType}[]`;
      }
      const elementType = inferType(value[0], fieldName, depth);
      return `${elementType}[]`;
    }

    if (typeof value === "object") {
      const subName = uniqueName(capitalize(fieldName));
      const subLines: string[] = [];
      subLines.push(`interface ${subName} {`);
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        const safeName = JS_IDENT.test(key) ? key : `"${key}"`;
        subLines.push(`  ${safeName}: ${inferType(val, key, depth + 1)};`);
      }
      subLines.push("}");
      subInterfaces.push(subLines.join("\n"));
      return subName;
    }

    return "unknown";
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return `type ${name} = unknown[];`;
    const allObjects = parsed.every(
      (v) => v !== null && typeof v === "object" && !Array.isArray(v)
    );
    if (allObjects) {
      const merged = mergeObjectKeys(parsed);
      const elementType = inferType(merged, name + "Item", 0);
      const result = [...subInterfaces, `type ${name} = ${elementType}[];`];
      return result.join("\n\n");
    }
    const elementType = inferType(parsed[0], name + "Item", 0);
    const result = [...subInterfaces, `type ${name} = ${elementType}[];`];
    return result.join("\n\n");
  }

  usedNames.add(name);
  lines.push(`interface ${name} {`);
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    const safeName = JS_IDENT.test(key) ? key : `"${key}"`;
    lines.push(`  ${safeName}: ${inferType(val, key, 0)};`);
  }
  lines.push("}");

  const result = [...subInterfaces, lines.join("\n")];
  return result.join("\n\n");
}
