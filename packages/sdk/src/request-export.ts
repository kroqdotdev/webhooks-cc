import type { CurlExport, HarExport, Request } from "./types";

const OMITTED_EXPORT_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "accept-encoding",
  "cdn-loop",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "true-client-ip",
]);

const VALID_HTTP_METHOD = /^[A-Z]+$/;

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function buildRequestUrl(endpointUrl: string, request: Request): string {
  const url = new URL(`${endpointUrl}${normalizePath(request.path)}`);
  for (const [key, value] of Object.entries(request.queryParams)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function shouldIncludeHeader(name: string): boolean {
  return !OMITTED_EXPORT_HEADERS.has(name.toLowerCase());
}

function escapeForShellDoubleQuotes(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function escapeForShellSingleQuotes(value: string): string {
  return value.replace(/'/g, "'\\''");
}

export function buildCurlExport(endpointUrl: string, requests: Request[]): CurlExport {
  return requests.map((request) => {
    const method = VALID_HTTP_METHOD.test(request.method) ? request.method : "GET";
    const parts = [`curl -X ${method}`];

    for (const [key, value] of Object.entries(request.headers)) {
      if (!shouldIncludeHeader(key)) {
        continue;
      }
      parts.push(`-H "${escapeForShellDoubleQuotes(key)}: ${escapeForShellDoubleQuotes(value)}"`);
    }

    if (request.body) {
      parts.push(`-d '${escapeForShellSingleQuotes(request.body)}'`);
    }

    parts.push(`"${escapeForShellDoubleQuotes(buildRequestUrl(endpointUrl, request))}"`);
    return parts.join(" \\\n  ");
  });
}

export function buildHarExport(
  endpointUrl: string,
  requests: Request[],
  creatorVersion: string
): HarExport {
  return {
    log: {
      version: "1.2",
      creator: {
        name: "@webhooks-cc/sdk",
        version: creatorVersion,
      },
      entries: requests.map((request) => {
        const contentType = request.contentType ?? "application/octet-stream";
        return {
          startedDateTime: new Date(request.receivedAt).toISOString(),
          time: 0,
          request: {
            method: request.method,
            url: buildRequestUrl(endpointUrl, request),
            httpVersion: "HTTP/1.1",
            headers: Object.entries(request.headers)
              .filter(([key]) => shouldIncludeHeader(key))
              .map(([name, value]) => ({ name, value })),
            queryString: Object.entries(request.queryParams).map(([name, value]) => ({
              name,
              value,
            })),
            headersSize: -1,
            bodySize: request.body ? new TextEncoder().encode(request.body).length : 0,
            ...(request.body
              ? {
                  postData: {
                    mimeType: contentType,
                    text: request.body,
                  },
                }
              : {}),
          },
          response: {
            status: 0,
            statusText: "",
            httpVersion: "HTTP/1.1",
            headers: [],
            cookies: [],
            content: {
              size: 0,
              mimeType: "x-unknown",
            },
            redirectURL: "",
            headersSize: -1,
            bodySize: -1,
          },
          cache: {},
          timings: {
            send: 0,
            wait: 0,
            receive: 0,
          },
        };
      }),
    },
  };
}
