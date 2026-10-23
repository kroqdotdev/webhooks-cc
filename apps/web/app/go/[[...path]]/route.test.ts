import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";
import { GET } from "./route";

const GO_IMPORT =
  '<meta name="go-import" content="webhooks.cc/go git https://github.com/kroqdotdev/webhooks-cc packages/sdk-go">';

describe("GET /go (the Go SDK's import path)", () => {
  it.each(["/go?go-get=1", "/go/whktest?go-get=1", "/go/verify?go-get=1"])(
    "answers the go command at %s with the module's go-import tag",
    async (path) => {
      const response = GET(new NextRequest(`https://webhooks.cc${path}`));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("x-robots-tag")).toBe("noindex");
      expect(await response.text()).toContain(GO_IMPORT);
    }
  );

  it("sends browsers on a package path to the docs", () => {
    const response = GET(new NextRequest("https://webhooks.cc/go/verify"));

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/docs/sdk/go");
  });

  it("keeps the retired /go page's redirect for browsers, but not for the go command", async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    const goRedirect = redirects.find((redirect) => redirect.source === "/go");

    expect(goRedirect?.destination).toBe("/");
    expect(goRedirect?.missing).toEqual([{ type: "query", key: "go-get" }]);
  });
});
