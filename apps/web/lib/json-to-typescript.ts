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
  let subCount = 0;

  function inferType(value: unknown, fieldName: string, depth: number): string {
    if (value === null) return "unknown";
    if (typeof value === "string") return "string";
    if (typeof value === "number") return "number";
    if (typeof value === "boolean") return "boolean";

    if (Array.isArray(value)) {
      if (value.length === 0) return "unknown[]";
      const elementType = inferType(value[0], fieldName, depth);
      return `${elementType}[]`;
    }

    if (typeof value === "object") {
      const subName = capitalize(fieldName);
      const subLines: string[] = [];
      subLines.push(`interface ${subName} {`);
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        const safeName = JS_IDENT.test(key) ? key : `"${key}"`;
        subLines.push(`  ${safeName}: ${inferType(val, key, depth + 1)};`);
      }
      subLines.push("}");
      subInterfaces.push(subLines.join("\n"));
      subCount++;
      return subName;
    }

    return "unknown";
  }

  function capitalize(s: string): string {
    const clean = s.replace(/[^a-zA-Z0-9_]/g, "");
    if (!clean) return `Sub${++subCount}`;
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return `type ${name} = unknown[];`;
    const elementType = inferType(parsed[0], name + "Item", 0);
    const result = [...subInterfaces, `type ${name} = ${elementType}[];`];
    return result.join("\n\n");
  }

  lines.push(`interface ${name} {`);
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    const safeName = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `"${key}"`;
    lines.push(`  ${safeName}: ${inferType(val, key, 0)};`);
  }
  lines.push("}");

  const result = [...subInterfaces, lines.join("\n")];
  return result.join("\n\n");
}
