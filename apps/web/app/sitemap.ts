import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://webhooks.cc";

  const publicPages = [
    "",
    "/docs",
    "/docs/endpoints",
    "/docs/requests",
    "/docs/mock-responses",
    "/docs/cli",
    "/docs/cli/commands",
    "/docs/cli/tunnel",
    "/docs/sdk",
    "/docs/sdk/api",
    "/docs/sdk/testing",
    "/docs/webhooks/stripe",
    "/docs/webhooks/github",
    "/docs/webhooks/shopify",
    "/installation",
    "/privacy",
    "/terms",
  ];

  const lastModified = new Date("2026-02-04");

  return publicPages.map((path) => ({
    url: `${baseUrl}${path}`,
    lastModified,
    changeFrequency: path === "" ? "weekly" : "monthly",
    priority: path === "" ? 1 : path === "/docs" ? 0.9 : 0.7,
  }));
}
