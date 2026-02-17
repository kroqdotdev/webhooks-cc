export type BodyFormat = "json" | "xml" | "form" | "text" | "binary";

/** Detect the body format from content type and body content. */
export function detectFormat(contentType?: string, body?: string): BodyFormat {
  if (!body) return "text";

  const ct = contentType?.toLowerCase() ?? "";

  if (ct.includes("application/json") || ct.includes("+json")) return "json";
  if (ct.includes("xml") || ct.includes("+xml")) return "xml";
  if (ct.includes("application/x-www-form-urlencoded")) return "form";
  if (ct.includes("application/octet-stream")) return "binary";

  // Sniff from body content
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(body);
      return "json";
    } catch {
      // not valid JSON
    }
  }
  if (trimmed.startsWith("<?xml")) return "xml";
  if (/^<[a-zA-Z][\w-]*[\s>/]/.test(trimmed)) return "xml";
  if (/^[\w.%+-]+=/.test(trimmed)) return "form";

  return "text";
}

/** Pretty-print a body string based on its detected format. */
export function formatBody(body: string, format: BodyFormat): string {
  if (!body) return "(empty)";

  switch (format) {
    case "json":
      return formatJson(body);
    case "xml":
      return formatXml(body);
    case "form":
      return formatFormData(body);
    default:
      return body;
  }
}

/**
 * Pretty-print JSON without parsing through JS numbers.
 * JSON.parse → JSON.stringify destroys precision for integers > 2^53.
 * This regex-based formatter preserves the raw string exactly.
 */
function formatJson(body: string): string {
  try {
    // Validate it's actually JSON first
    JSON.parse(body);
  } catch {
    return body;
  }

  // Regex-based pretty-printer that preserves raw values
  let result = "";
  let indent = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && inString) {
      result += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }

    if (inString) {
      result += ch;
      continue;
    }

    // Skip existing whitespace outside strings
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      continue;
    }

    if (ch === "{" || ch === "[") {
      // Check if empty object/array
      let j = i + 1;
      while (
        j < body.length &&
        (body[j] === " " || body[j] === "\n" || body[j] === "\r" || body[j] === "\t")
      )
        j++;
      const closing = ch === "{" ? "}" : "]";
      if (body[j] === closing) {
        result += ch + closing;
        i = j;
        continue;
      }
      indent++;
      result += ch + "\n" + "  ".repeat(indent);
    } else if (ch === "}" || ch === "]") {
      indent--;
      result += "\n" + "  ".repeat(indent) + ch;
    } else if (ch === ",") {
      result += ",\n" + "  ".repeat(indent);
    } else if (ch === ":") {
      result += ": ";
    } else {
      result += ch;
    }
  }

  return result;
}

/** Indent XML with simple regex-based formatter. */
export function formatXml(xml: string): string {
  let indent = 0;
  const lines: string[] = [];

  // Split on tags while preserving content between tags
  const parts = xml.replace(/>\s*</g, ">\n<").split("\n");

  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;

    // Closing tag
    if (part.startsWith("</")) {
      indent = Math.max(indent - 1, 0);
      lines.push("  ".repeat(indent) + part);
    }
    // Self-closing or processing instruction
    else if (part.endsWith("/>") || part.startsWith("<?")) {
      lines.push("  ".repeat(indent) + part);
    }
    // Opening tag with inline content and close (e.g. <tag>text</tag>)
    else if (/<\/[^>]+>\s*$/.test(part) && /<[^/][^>]*>/.test(part)) {
      lines.push("  ".repeat(indent) + part);
    }
    // Opening tag
    else if (part.startsWith("<") && !part.startsWith("<!")) {
      lines.push("  ".repeat(indent) + part);
      indent++;
    }
    // Text content or other
    else {
      lines.push("  ".repeat(indent) + part);
    }
  }

  return lines.join("\n");
}

/** Format URL-encoded form data as key: value lines. */
export function formatFormData(body: string): string {
  try {
    const params = new URLSearchParams(body);
    const lines: string[] = [];
    for (const [key, value] of params.entries()) {
      lines.push(`${key}: ${value}`);
    }
    return lines.length > 0 ? lines.join("\n") : body;
  } catch {
    return body;
  }
}

const FORMAT_LABELS: Record<BodyFormat, string> = {
  json: "JSON",
  xml: "XML",
  form: "FORM",
  text: "TEXT",
  binary: "BINARY",
};

/** Get a display label for a body format. */
export function getFormatLabel(format: BodyFormat): string {
  return FORMAT_LABELS[format];
}
