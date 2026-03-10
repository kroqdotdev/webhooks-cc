/* eslint-env node */
/* global process, URL, console, fetch */

/**
 * Submit all public URLs to IndexNow (Bing, Yandex, etc.).
 *
 * Usage:
 *   node scripts/indexnow.mjs              # submit all sitemap URLs
 *   node scripts/indexnow.mjs /docs/sdk    # submit specific paths
 */

const SITE_URL = "https://webhooks.cc";
const KEY = "131a408db4e92a7c59f8252f8777b7ec";
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/** Collect all public URLs from the sitemap page definitions + docs. */
async function getAllUrls() {
  // Fetch the sitemap index to discover sub-sitemaps
  const sitemapPaths = ["/sitemaps/pages.xml", "/sitemaps/docs.xml", "/sitemaps/blog.xml"];

  const urls = new Set();

  for (const path of sitemapPaths) {
    try {
      const res = await fetch(`${SITE_URL}${path}`);
      if (!res.ok) {
        console.warn(`  warn: ${path} returned ${res.status}, skipping`);
        continue;
      }
      const xml = await res.text();
      // Extract <loc> values from sitemap XML
      const locRegex = /<loc>([^<]+)<\/loc>/g;
      let match;
      while ((match = locRegex.exec(xml)) !== null) {
        urls.add(match[1]);
      }
    } catch (err) {
      console.warn(`  warn: failed to fetch ${path}: ${err.message}`);
    }
  }

  return [...urls];
}

async function submitToIndexNow(urls) {
  if (urls.length === 0) {
    console.log("No URLs to submit.");
    return;
  }

  console.log(`Submitting ${urls.length} URLs to IndexNow...`);

  const body = {
    host: new URL(SITE_URL).host,
    key: KEY,
    keyLocation: `${SITE_URL}/${KEY}.txt`,
    urlList: urls,
  };

  const res = await fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.ok || res.status === 202) {
    console.log(`  OK (${res.status}) — ${urls.length} URLs submitted`);
  } else {
    const text = await res.text().catch(() => "");
    console.error(`  FAIL (${res.status}): ${text}`);
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);

  let urls;
  if (args.length > 0) {
    // Submit specific paths passed as arguments
    urls = args.map((p) => (p.startsWith("http") ? p : `${SITE_URL}${p}`));
  } else {
    // Submit all public URLs from sitemaps
    urls = await getAllUrls();
  }

  console.log(`URLs to submit (${urls.length}):`);
  for (const url of urls) {
    console.log(`  ${url}`);
  }
  console.log();

  await submitToIndexNow(urls);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
