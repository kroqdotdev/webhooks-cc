import type { Request } from "@/types/request";

/** Export requests as a JSON string. */
export function exportToJson(requests: Request[]): string {
  const data = requests.map((r) => ({
    id: r._id,
    method: r.method,
    path: r.path,
    headers: r.headers,
    body: r.body ?? null,
    queryParams: r.queryParams,
    contentType: r.contentType ?? null,
    ip: r.ip,
    size: r.size,
    receivedAt: new Date(r.receivedAt).toISOString(),
  }));
  return JSON.stringify(data, null, 2);
}

/** Export requests as a CSV string. */
export function exportToCsv(requests: Request[]): string {
  const headers = ["id", "method", "path", "content_type", "ip", "size", "received_at", "body"];
  const rows = requests.map((r) => [
    r._id,
    r.method,
    r.path,
    r.contentType ?? "",
    r.ip,
    String(r.size),
    new Date(r.receivedAt).toISOString(),
    r.body ?? "",
  ]);

  const escape = (value: string) => {
    let escaped = value;
    // Prevent CSV formula injection for values starting with dangerous characters
    if (/^[=+\-@\t\r|]/.test(escaped)) {
      escaped = "'" + escaped;
    }
    if (escaped.includes(",") || escaped.includes('"') || escaped.includes("\n")) {
      return `"${escaped.replace(/"/g, '""')}"`;
    }
    return escaped;
  };

  const lines = [headers.join(","), ...rows.map((row) => row.map(escape).join(","))];
  return lines.join("\n");
}

/** Trigger a file download in the browser. */
export function downloadFile(content: string, filename: string, mimeType: string) {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
