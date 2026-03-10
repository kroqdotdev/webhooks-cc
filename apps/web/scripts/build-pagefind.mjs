/* eslint-env node */
/* global URL, Buffer, process */
import { gunzipSync, gzipSync } from "node:zlib";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const outputDir = path.resolve("public/_pagefind");
const fragmentDir = path.join(outputDir, "fragment");

function normalizePagefindUrl(url) {
  const parsed = new URL(url, "https://docs.webhooks.cc");

  if (parsed.pathname === "/index.html") {
    parsed.pathname = "/";
  } else if (parsed.pathname.endsWith("/index.html")) {
    parsed.pathname = parsed.pathname.slice(0, -"/index.html".length) || "/";
  } else if (parsed.pathname.endsWith(".html")) {
    parsed.pathname = parsed.pathname.slice(0, -".html".length) || "/";
  }

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function decodePagefindFile(buffer) {
  let decoded = buffer;

  if (decoded.subarray(0, 12).toString() !== "pagefind_dcd") {
    decoded = gunzipSync(decoded);
  }

  if (decoded.subarray(0, 12).toString() !== "pagefind_dcd") {
    throw new Error("Unexpected Pagefind fragment format");
  }

  return decoded.subarray(12);
}

function encodePagefindFile(buffer) {
  return gzipSync(Buffer.concat([Buffer.from("pagefind_dcd"), buffer]));
}

function normalizeFragments() {
  if (!statSync(fragmentDir, { throwIfNoEntry: false })?.isDirectory()) {
    return;
  }

  for (const file of readdirSync(fragmentDir)) {
    const filePath = path.join(fragmentDir, file);
    const raw = readFileSync(filePath);
    const fragment = JSON.parse(decodePagefindFile(raw).toString("utf8"));

    fragment.url = normalizePagefindUrl(fragment.url);

    writeFileSync(filePath, encodePagefindFile(Buffer.from(JSON.stringify(fragment))));
  }
}

rmSync(outputDir, { recursive: true, force: true });

const pagefind = spawnSync(
  process.platform === "win32" ? "pagefind.cmd" : "pagefind",
  ["--site", ".next/server/app", "--output-path", "public/_pagefind"],
  { stdio: "inherit" }
);

if (pagefind.status !== 0) {
  process.exit(pagefind.status ?? 1);
}

normalizeFragments();
