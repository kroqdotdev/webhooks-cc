import { test, expect, type Page, type Request, type Route } from "@playwright/test";

/**
 * The free tools under /tools. Discord and Slack are always stubbed: no test
 * ever posts to a real webhook. The stubs also prove the page's own
 * Content-Security-Policy lets the request out, since a blocked request never
 * reaches a route.
 */

// Made up, in the real shapes: no webhook has these ids.
const DISCORD_URL = "https://discord.com/api/webhooks/123456789012345678/abcDEF123_-xyzTOKEN";
const SLACK_URL = "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX";
const SECRETS = ["abcDEF123_-xyzTOKEN", "XXXXXXXXXXXXXXXXXXXXXXXX", "It's a Secret to Everybody"];

const CORS = { "access-control-allow-origin": "*" };

// The backstop: any Discord or Slack request no test stubbed is aborted, so a
// test written later cannot post for real. A page's own routes come first.
const PROVIDER_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(discord|discordapp|slack|slack-gov)\.com\//;
test.beforeEach(async ({ context }) => {
  await context.route(PROVIDER_HOSTS, (route) => route.abort());
});

/** Every request the page makes, so a test can say where what was typed went. */
function watchRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on("request", (request) => requests.push(request));
  return requests;
}

/**
 * Nothing typed into a tool may reach webhooks.cc: no request to the app's
 * own origin (or anywhere but the provider) carries a secret, in its URL or
 * its body.
 */
function expectNothingLeaked(requests: Request[], providerOrigin: string | null) {
  for (const request of requests) {
    const url = request.url();
    if (providerOrigin && url.startsWith(providerOrigin)) continue;
    const sent = `${url}\n${request.postData() ?? ""}`;
    for (const secret of SECRETS) {
      expect(sent, `${request.method()} ${url}`).not.toContain(secret);
    }
  }
}

async function stub(
  page: Page,
  pattern: string,
  answer: (route: Route, request: Request) => Promise<void>
): Promise<Request[]> {
  const seen: Request[] = [];
  await page.route(pattern, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          ...CORS,
          "access-control-allow-methods": "POST, GET",
          "access-control-allow-headers": "content-type",
        },
      });
      return;
    }
    seen.push(request);
    await answer(route, request);
  });
  return seen;
}

test.describe("Discord webhook tester", () => {
  test("posts the message straight to Discord and explains the answer", async ({ page }) => {
    const requests = watchRequests(page);
    const sent = await stub(page, "https://discord.com/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: CORS,
        body: JSON.stringify({ id: "111", channel_id: "222", content: "Deploy finished" }),
      })
    );

    await page.goto("/tools/discord-webhook-tester");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Discord webhook tester");
    await page.getByRole("textbox", { name: "Webhook URL" }).fill(DISCORD_URL);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Deploy finished");
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Deploy bot");
    await page.getByLabel("Add an embed").check();
    await page.getByRole("textbox", { name: "Embed title" }).fill("Build 42");
    await page.getByRole("textbox", { name: "Embed colour" }).fill("#5865F2");
    await page.getByRole("button", { name: "Send message" }).click();

    const verdict = page.getByRole("status");
    await expect(verdict).toContainText("Message posted");
    await expect(verdict).toContainText("as message 111 in channel 222");
    await expect(page.getByTestId("tool-answer")).toContainText('"channel_id": "222"');
    await expect(page.getByTestId("tool-curl")).toContainText("curl -i -X POST");

    expect(sent).toHaveLength(1);
    expect(sent[0].method()).toBe("POST");
    expect(sent[0].url()).toBe(`${DISCORD_URL}?wait=true`);
    expect(sent[0].headers()["content-type"]).toBe("application/json");
    expect(sent[0].postDataJSON()).toEqual({
      content: "Deploy finished",
      username: "Deploy bot",
      embeds: [{ title: "Build 42", color: 0x5865f2 }],
      allowed_mentions: { parse: [] },
    });

    // The address never carries what was typed, and nothing went to our server.
    expect(new URL(page.url()).search).toBe("");
    expectNothingLeaked(requests, "https://discord.com");
  });

  test("says what 404, 401 and 429 mean", async ({ page }) => {
    let answer = { status: 404, body: { message: "Unknown Webhook", code: 10015 } as object };
    await stub(page, "https://discord.com/**", (route) =>
      route.fulfill({
        status: answer.status,
        contentType: "application/json",
        headers: CORS,
        body: JSON.stringify(answer.body),
      })
    );
    await page.goto("/tools/discord-webhook-tester");
    await page.getByRole("textbox", { name: "Webhook URL" }).fill(DISCORD_URL);
    const send = page.getByRole("button", { name: "Send message" });
    const verdict = page.getByRole("status");

    await send.click();
    await expect(verdict).toContainText("Unknown webhook (404)");
    await expect(verdict).toContainText("it was deleted, or the URL is mistyped");
    await expect(page.getByTestId("tool-answer")).toContainText("Unknown Webhook");

    answer = { status: 401, body: { message: "Invalid Webhook Token", code: 50027 } };
    await send.click();
    await expect(verdict).toContainText("Invalid webhook token (401)");

    answer = {
      status: 429,
      body: { message: "You are being rate limited.", retry_after: 2.4, global: false },
    };
    await send.click();
    await expect(verdict).toContainText("Rate limited (429)");
    await expect(verdict).toContainText("Wait 3 seconds and send again.");
  });

  test("checks a URL without posting, and hides the token Discord sends back", async ({ page }) => {
    const sent = await stub(page, "https://discord.com/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: CORS,
        body: JSON.stringify({
          id: "123456789012345678",
          name: "Alerts",
          channel_id: "222",
          token: "abcDEF123_-xyzTOKEN",
          url: DISCORD_URL,
        }),
      })
    );
    await page.goto("/tools/discord-webhook-tester");
    // The older host is the same API, and is sent through discord.com.
    await page
      .getByRole("textbox", { name: "Webhook URL" })
      .fill(DISCORD_URL.replace("discord.com", "discordapp.com"));
    await page.getByRole("button", { name: "Check URL" }).click();

    await expect(page.getByRole("status")).toContainText("The URL works");
    await expect(page.getByRole("status")).toContainText('"Alerts" exists');
    expect(sent).toHaveLength(1);
    expect(sent[0].method()).toBe("GET");
    expect(sent[0].url()).toBe(DISCORD_URL);
    const shown = await page.getByTestId("tool-answer").innerText();
    expect(shown).toContain('"token": "[hidden]"');
    expect(shown).not.toContain("abcDEF123_-xyzTOKEN");
  });

  test("refuses anything that is not a Discord webhook URL before sending", async ({ page }) => {
    const sent = await stub(page, "https://discord.com/**", (route) => route.abort());
    await page.goto("/tools/discord-webhook-tester");
    const url = page.getByRole("textbox", { name: "Webhook URL" });
    const send = page.getByRole("button", { name: "Send message" });

    await send.click();
    await expect(page.getByText("Paste a Discord webhook URL.")).toBeVisible();

    await url.fill("https://discord.com/channels/1/2");
    await send.click();
    await expect(page.getByText(/link to a channel, not a webhook URL/)).toBeVisible();

    await url.fill(SLACK_URL);
    await send.click();
    await expect(page.getByText(/Use the Slack webhook tester/)).toBeVisible();

    await url.fill(DISCORD_URL);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("");
    await send.click();
    await expect(page.getByText(/Discord refuses an empty message/)).toBeVisible();
    expect(sent).toHaveLength(0);
  });

  test("says so when no answer comes back", async ({ page }) => {
    await stub(page, "https://discord.com/**", (route) => route.abort());
    await page.goto("/tools/discord-webhook-tester");
    await page.getByRole("textbox", { name: "Webhook URL" }).fill(DISCORD_URL);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("status")).toContainText("No answer from Discord");
    await expect(page.getByTestId("tool-curl")).toContainText(`'${DISCORD_URL}?wait=true'`);
  });

  test("reached without a page load, it loads itself to get its own policy", async ({ page }) => {
    const sent = await stub(page, "https://discord.com/**", (route) =>
      route.fulfill({ status: 204, headers: CORS, body: "" })
    );
    await page.goto("/tools");
    // Next's router is there once the page has hydrated.
    await page.waitForLoadState("networkidle");
    // A client-side navigation: the document is still the index page's, whose
    // policy does not allow discord.com. Only a page load fires "load".
    const loaded = page.waitForEvent("load");
    await page.evaluate(() => {
      const next = (window as unknown as { next: { router: { push(href: string): void } } }).next;
      next.router.push("/tools/discord-webhook-tester");
    });
    await loaded;
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Discord webhook tester");
    expect(
      await page.evaluate(
        () => new URL(performance.getEntriesByType("navigation")[0].name).pathname
      )
    ).toBe("/tools/discord-webhook-tester");

    await page.getByRole("textbox", { name: "Webhook URL" }).fill(DISCORD_URL);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("status")).toContainText("Message posted");
    expect(sent).toHaveLength(1);
  });

  test("left without a page load, the next page loads itself and drops discord.com", async ({
    page,
  }) => {
    await page.goto("/tools/discord-webhook-tester");
    await page.waitForLoadState("networkidle");
    // The breadcrumb is a client-side link; the index must not inherit this
    // document's connect-src, which allows discord.com.
    const loaded = page.waitForEvent("load");
    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link").click();
    await loaded;
    await expect(page).toHaveURL(/\/tools$/);
    expect(
      await page.evaluate(
        () => new URL(performance.getEntriesByType("navigation")[0].name).pathname
      )
    ).toBe("/tools");
  });
});

test.describe("Slack webhook tester", () => {
  test("posts the message as a form field and explains the answer", async ({ page }) => {
    const requests = watchRequests(page);
    const preflights: Request[] = [];
    page.on("request", (request) => {
      if (request.method() === "OPTIONS") preflights.push(request);
    });
    const sent = await stub(page, "https://hooks.slack.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", headers: CORS, body: "ok" })
    );

    await page.goto("/tools/slack-webhook-tester");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Slack webhook tester");
    await page.getByRole("textbox", { name: "Webhook URL" }).fill(SLACK_URL);
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Deploy *finished* & live");
    await page.getByRole("button", { name: "Send message" }).click();

    await expect(page.getByRole("status")).toContainText("Message posted");
    await expect(page.getByTestId("tool-answer")).toHaveText("ok");
    // The curl command is the request as Slack documents it.
    const curl = page.getByTestId("tool-curl");
    await expect(curl).toContainText("-H 'Content-type: application/json'");
    await expect(curl).toContainText(`-d '{"text":"Deploy *finished* & live"}'`);

    expect(sent).toHaveLength(1);
    expect(sent[0].method()).toBe("POST");
    expect(sent[0].url()).toBe(SLACK_URL);
    // A form body: the one kind a page may send Slack without a preflight.
    expect(sent[0].headers()["content-type"]).toMatch(/^application\/x-www-form-urlencoded/);
    const form = new URLSearchParams(sent[0].postData() ?? "");
    expect(JSON.parse(form.get("payload") ?? "")).toEqual({ text: "Deploy *finished* & live" });
    expect(preflights).toHaveLength(0);

    expect(new URL(page.url()).search).toBe("");
    expectNothingLeaked(requests, "https://hooks.slack.com");
  });

  test("explains Slack's error words, and sends JSON as written", async ({ page }) => {
    let answer = { status: 404, body: "no_service" };
    const sent = await stub(page, "https://hooks.slack.com/**", (route) =>
      route.fulfill({
        status: answer.status,
        contentType: "text/html",
        headers: CORS,
        body: answer.body,
      })
    );
    await page.goto("/tools/slack-webhook-tester");
    await page.getByRole("textbox", { name: "Webhook URL" }).fill(SLACK_URL);
    const send = page.getByRole("button", { name: "Send message" });
    const verdict = page.getByRole("status");

    await send.click();
    await expect(verdict).toContainText("no_service (404)");
    await expect(verdict).toContainText("disabled, removed or invalid");

    answer = { status: 400, body: "invalid_payload" };
    await page.getByRole("tab", { name: "JSON" }).click();
    await page.getByRole("textbox", { name: "JSON payload" }).fill("{not json");
    await send.click();
    await expect(page.getByText(/This is not valid JSON/)).toBeVisible();
    expect(sent).toHaveLength(1);

    await page
      .getByLabel("JSON payload")
      .fill('{"text":"hi","blocks":[{"type":"divider"}],"unknown_field":true}');
    await send.click();
    await expect(verdict).toContainText("invalid_payload (400)");
    expect(sent).toHaveLength(2);
    const form = new URLSearchParams(sent[1].postData() ?? "");
    expect(JSON.parse(form.get("payload") ?? "")).toEqual({
      text: "hi",
      blocks: [{ type: "divider" }],
      unknown_field: true,
    });
  });

  test("says plainly when the browser cannot read Slack's answer, with the curl command", async ({
    page,
  }) => {
    await stub(page, "https://hooks.slack.com/**", (route) => route.abort());
    await page.goto("/tools/slack-webhook-tester");
    await page.getByRole("textbox", { name: "Webhook URL" }).fill(SLACK_URL);
    await page.getByRole("button", { name: "Send message" }).click();

    const verdict = page.getByRole("status");
    await expect(verdict).toContainText("The browser could not read Slack's answer");
    await expect(verdict).toContainText("may still have been posted");
    await expect(page.getByTestId("tool-answer")).toHaveCount(0);
    await expect(page.getByTestId("tool-curl")).toContainText(`'${SLACK_URL}'`);
  });

  test("refuses workflow webhooks and other addresses before sending", async ({ page }) => {
    const sent = await stub(page, "https://hooks.slack.com/**", (route) => route.abort());
    await page.goto("/tools/slack-webhook-tester");
    const url = page.getByRole("textbox", { name: "Webhook URL" });
    const send = page.getByRole("button", { name: "Send message" });

    await url.fill("https://hooks.slack.com/triggers/T00000000/123/abc");
    await send.click();
    await expect(page.getByText(/workflow webhook, not an incoming webhook/)).toBeVisible();

    await url.fill(DISCORD_URL);
    await send.click();
    await expect(page.getByText(/Use the Discord webhook tester/)).toBeVisible();
    expect(sent).toHaveLength(0);
  });
});

test.describe("Webhook signature checker", () => {
  // The example in GitHub's "Validating webhook deliveries" documentation.
  const SECRET = "It's a Secret to Everybody";
  const PAYLOAD = "Hello, World!";
  const SIGNATURE = "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

  test("computes an HMAC and compares it, without a single request", async ({ page }) => {
    await page.goto("/tools/webhook-signature-checker");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Webhook signature checker");
    await page.waitForLoadState("networkidle");
    const requests = watchRequests(page);

    await page.getByRole("textbox", { name: "Secret", exact: true }).fill(SECRET);
    await page.getByRole("textbox", { name: "Payload", exact: true }).fill(PAYLOAD);
    await page.getByRole("button", { name: "Compute signature" }).click();
    await expect(page.getByTestId("tool-output")).toHaveText(SIGNATURE);

    await page
      .getByRole("textbox", { name: "Signature to compare" })
      .fill(`sha256=${SIGNATURE.toUpperCase()}`);
    await page.getByRole("button", { name: "Compute and compare" }).click();
    await expect(page.getByRole("status")).toContainText("Signatures match");

    await page.getByRole("textbox", { name: "Payload", exact: true }).fill(`${PAYLOAD} `);
    await page.getByRole("button", { name: "Compute and compare" }).click();
    await expect(page.getByRole("status")).toContainText("Signatures differ");

    await page.getByLabel("Signature encoding").click();
    await page.getByRole("option", { name: "Base64", exact: true }).click();
    await page.getByRole("textbox", { name: "Signature to compare" }).fill("");
    await page.getByRole("textbox", { name: "Payload", exact: true }).fill(PAYLOAD);
    await page.getByRole("button", { name: "Compute signature" }).click();
    await expect(page.getByTestId("tool-output")).toHaveText(
      Buffer.from(SIGNATURE, "hex").toString("base64")
    );

    // The secret never left the page: whatever was requested meanwhile
    // (analytics, the dev server's own chatter) carries none of it.
    expectNothingLeaked(requests, null);
    for (const request of requests) {
      expect(`${request.url()}${request.postData() ?? ""}`).not.toContain(SIGNATURE);
    }
    expect(new URL(page.url()).search).toBe("");
  });

  test("checks and signs a request the way a provider does", async ({ page }) => {
    await page.goto("/tools/webhook-signature-checker");
    await page.getByLabel("Scheme").click();
    await page.getByRole("option", { name: "GitHub" }).click();
    await expect(
      page.getByText(/sends the signature in the x-hub-signature-256 header/)
    ).toBeVisible();

    await page.getByRole("textbox", { name: "Secret", exact: true }).fill(SECRET);
    await page.getByRole("textbox", { name: "Payload", exact: true }).fill(PAYLOAD);
    const check = page.getByRole("button", { name: "Check signature" });

    await page
      .getByRole("textbox", { name: "Request headers" })
      .fill("Content-Type: application/json");
    await check.click();
    await expect(page.getByRole("status")).toContainText("No signature in these headers");

    await page
      .getByLabel("Request headers")
      .fill(`Content-Type: application/json\nX-Hub-Signature-256: sha256=${SIGNATURE}`);
    await check.click();
    await expect(page.getByRole("status")).toContainText("Signature valid");

    await page.getByRole("textbox", { name: "Payload", exact: true }).fill(`${PAYLOAD}\n`);
    await check.click();
    await expect(page.getByRole("status")).toContainText("Signature does not match");

    // Signing gives the headers back in the form the check reads.
    await page.getByRole("textbox", { name: "Payload", exact: true }).fill(PAYLOAD);
    await page.getByRole("button", { name: "Sign this payload" }).click();
    await expect(page.getByTestId("tool-output")).toHaveText(
      `x-hub-signature-256: sha256=${SIGNATURE}`
    );
  });

  test("opens with the scheme a provider page asked for", async ({ page }) => {
    await page.goto("/webhooks/docusign");
    await page.waitForLoadState("networkidle");
    await page.getByRole("link", { name: "webhook signature checker" }).click();
    await expect(page).toHaveURL(/\/tools\/webhook-signature-checker\?scheme=docusign$/);
    await expect(page.getByLabel("Scheme")).toHaveText("DocuSign");
    await expect(page.getByText(/in the x-docusign-signature-1 header/)).toBeVisible();
  });
});

test.describe("the tools and the rest of the site", () => {
  test("the index lists every tool, and each page gets only its own provider's origin", async ({
    page,
    request,
  }) => {
    await page.goto("/tools");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Free webhook tools");
    for (const name of [
      "Discord webhook tester",
      "Slack webhook tester",
      "Webhook signature checker",
    ]) {
      await expect(page.getByRole("link", { name: new RegExp(name) })).toBeVisible();
    }

    const connectSrc = async (path: string) => {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      const policy = response.headers()["content-security-policy"] ?? "";
      return policy.split(";").find((part) => part.trim().startsWith("connect-src")) ?? "";
    };
    expect(await connectSrc("/tools/discord-webhook-tester")).toContain("https://discord.com");
    expect(await connectSrc("/tools/discord-webhook-tester")).not.toContain("slack");
    expect(await connectSrc("/tools/slack-webhook-tester")).toContain("https://hooks.slack.com");
    expect(await connectSrc("/tools/slack-webhook-tester")).not.toContain("discord");
    for (const path of ["/tools", "/tools/webhook-signature-checker", "/webhooks/discord", "/"]) {
      const policy = await connectSrc(path);
      expect(policy, path).not.toContain("discord.com");
      expect(policy, path).not.toContain("slack.com");
    }
  });

  test("the Discord and Slack provider pages link to their tester, as a link only", async ({
    page,
  }) => {
    await page.goto("/webhooks/discord");
    // The announcement banner arrives after hydration and moves the page down.
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/^Discord Webhooks: Inspect Payloads/);
    // A link, never the tool itself: no webhook URL field on a provider page.
    await expect(page.getByRole("textbox", { name: "Webhook URL" })).toHaveCount(0);
    await page.getByRole("link", { name: "Discord webhook tester", exact: true }).click();
    await expect(page).toHaveURL(/\/tools\/discord-webhook-tester$/);
    await expect(page).toHaveTitle(/^Discord Webhook Tester/);

    await page.goto("/webhooks/slack");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/^Slack Webhooks: Capture Events/);
    await expect(page.getByRole("textbox", { name: "Webhook URL" })).toHaveCount(0);
    await page.getByRole("link", { name: "Slack webhook tester", exact: true }).click();
    await expect(page).toHaveURL(/\/tools\/slack-webhook-tester$/);
    await expect(page).toHaveTitle(/^Slack Webhook Tester/);
  });
});
