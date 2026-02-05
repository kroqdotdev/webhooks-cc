/**
 * Basic usage example for @webhooks-cc/sdk
 *
 * Run with: npx tsx examples/basic.ts
 * Requires: WHK_API_KEY environment variable
 */
import { WebhooksCC } from "../src";

const apiKey = process.env.WHK_API_KEY;
if (!apiKey) {
  console.error("Set WHK_API_KEY environment variable");
  process.exit(1);
}

const client = new WebhooksCC({
  apiKey,
  baseUrl: process.env.WHK_BASE_URL ?? "https://webhooks.cc",
});

async function main() {
  // Create a temporary endpoint
  const endpoint = await client.endpoints.create({ name: "SDK Example" });
  console.log(`Endpoint created: ${endpoint.url}`);
  console.log(`Send a webhook with: curl -X POST ${endpoint.url} -d '{"hello":"world"}'`);

  try {
    // Wait up to 60 seconds for a request
    console.log("\nWaiting for incoming webhook...");
    const request = await client.requests.waitFor(endpoint.slug, {
      timeout: 60000,
    });

    console.log("\nReceived webhook:");
    console.log(`  Method: ${request.method}`);
    console.log(`  Headers: ${JSON.stringify(request.headers, null, 2)}`);
    console.log(`  Body: ${request.body ?? "(empty)"}`);
  } finally {
    // Clean up
    await client.endpoints.delete(endpoint.slug);
    console.log("\nEndpoint deleted.");
  }
}

main().catch(console.error);
