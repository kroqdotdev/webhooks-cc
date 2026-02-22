import type { MetadataRoute } from "next";
import { getPublicSitemapEntries } from "@/lib/sitemap-utils";

export default function sitemap(): MetadataRoute.Sitemap {
  return getPublicSitemapEntries().map((entry) => ({
    url: entry.url,
    lastModified: entry.lastModified,
    changeFrequency: entry.changeFrequency,
    priority: entry.priority,
  }));
}
