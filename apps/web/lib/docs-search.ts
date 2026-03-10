function toRelativeUrl(url: string): URL {
  return new URL(url, "https://docs.webhooks.cc");
}

export function normalizePagefindUrl(url: string): string {
  const parsed = toRelativeUrl(url);

  if (parsed.pathname === "/index.html") {
    parsed.pathname = "/";
  } else if (parsed.pathname.endsWith("/index.html")) {
    parsed.pathname = parsed.pathname.slice(0, -"/index.html".length) || "/";
  } else if (parsed.pathname.endsWith(".html")) {
    parsed.pathname = parsed.pathname.slice(0, -".html".length) || "/";
  }

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function isDocsSearchUrl(url: string): boolean {
  const parsed = toRelativeUrl(normalizePagefindUrl(url));
  return parsed.pathname === "/docs" || parsed.pathname.startsWith("/docs/");
}
