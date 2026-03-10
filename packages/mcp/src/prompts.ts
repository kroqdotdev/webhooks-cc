import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "debug_webhook_delivery",
    {
      title: "Debug Webhook Delivery",
      description: "Guide an agent through diagnosing why webhook delivery is failing or missing.",
      argsSchema: {
        provider: z.string().optional().describe("Webhook provider, if known"),
        endpointSlug: z.string().optional().describe("Hosted endpoint slug, if known"),
        targetUrl: z.string().optional().describe("Your app's receiving URL, if known"),
      },
    },
    async ({ provider, endpointSlug, targetUrl }) => {
      const scope = [
        provider ? `Provider: ${provider}.` : null,
        endpointSlug ? `Endpoint slug: ${endpointSlug}.` : null,
        targetUrl ? `Target URL: ${targetUrl}.` : null,
      ]
        .filter(Boolean)
        .join(" ");

      return {
        description: "Diagnose a missing or broken webhook delivery.",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                scope,
                "Diagnose webhook delivery step by step.",
                "Use list_endpoints or get_endpoint to confirm the endpoint and URL.",
                "Use list_requests, wait_for_request, or wait_for_requests to check whether anything arrived.",
                "If the provider is known, use preview_webhook or send_webhook to reproduce the webhook with realistic signing.",
                "Use verify_signature when a secret is available.",
                "Use compare_requests to compare retries or changed payloads.",
                "Conclude with the most likely cause and the next concrete fix.",
              ]
                .filter(Boolean)
                .join(" "),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "setup_provider_testing",
    {
      title: "Setup Provider Testing",
      description: "Guide an agent through setting up webhook testing for a provider.",
      argsSchema: {
        provider: z.string().describe("Webhook provider to test"),
        targetUrl: z.string().optional().describe("Optional local or remote target URL"),
      },
    },
    async ({ provider, targetUrl }) => {
      return {
        description: `Set up webhook testing for ${provider}.`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Set up webhook testing for ${provider}.`,
                "Use list_provider_templates to inspect supported templates and signing details first.",
                "Create an endpoint with create_endpoint, preferably ephemeral.",
                "If a target URL is provided, use preview_webhook before send_to so the request shape is visible.",
                targetUrl ? `Target URL: ${targetUrl}.` : null,
                "Send a realistic provider webhook, wait for capture, and verify the signature if a secret is available.",
                "Return the endpoint URL, the exact tools used, and the next step for the developer.",
              ]
                .filter(Boolean)
                .join(" "),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "compare_webhook_attempts",
    {
      title: "Compare Webhook Attempts",
      description: "Guide an agent through comparing two webhook deliveries or retries.",
      argsSchema: {
        endpointSlug: z
          .string()
          .optional()
          .describe("Endpoint slug to inspect for recent attempts"),
        leftRequestId: z.string().optional().describe("First request ID, if already known"),
        rightRequestId: z.string().optional().describe("Second request ID, if already known"),
      },
    },
    async ({ endpointSlug, leftRequestId, rightRequestId }) => {
      return {
        description: "Compare two webhook deliveries and explain the difference.",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                endpointSlug ? `Endpoint slug: ${endpointSlug}.` : null,
                leftRequestId && rightRequestId
                  ? `Compare request ${leftRequestId} against ${rightRequestId}.`
                  : "Find the most relevant two webhook attempts first.",
                "Use compare_requests for the structured diff.",
                "If request IDs are not provided, use list_requests or the endpoint recent resource to find the last two attempts.",
                "Explain what changed in the body, headers, or timing, and whether the difference looks expected, retried, or broken.",
              ]
                .filter(Boolean)
                .join(" "),
            },
          },
        ],
      };
    }
  );
}
