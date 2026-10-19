import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.hoisted(() => vi.fn().mockResolvedValue({ data: { user: null }, error: null }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser },
  })),
}));

import { proxy } from "./proxy";

beforeEach(() => {
  getUser.mockClear();
});

describe("proxy", () => {
  it("refuses POST requests with Next-Action and RSC headers before touching Supabase auth", async () => {
    const req = new NextRequest("https://webhooks.cc/", {
      method: "POST",
      headers: {
        "Next-Action": "cachefn",
        RSC: "1",
      },
    });
    const res = await proxy(req);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
    expect(getUser).not.toHaveBeenCalled();
  });

  it("refuses any request carrying Next-Action, including on /api routes", async () => {
    const req = new NextRequest("https://webhooks.cc/api/endpoints", {
      method: "POST",
      headers: {
        "next-action": "x",
      },
    });
    const res = await proxy(req);
    expect(res.status).toBe(404);
    expect(getUser).not.toHaveBeenCalled();
  });

  it("refuses POST requests to non-/api routes without Next-Action", async () => {
    const req = new NextRequest("https://webhooks.cc/not-a-route", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    const res = await proxy(req);
    expect(res.status).toBe(404);
    expect(getUser).not.toHaveBeenCalled();
  });

  it("lets POST requests to /api routes and GET requests to pages through", async () => {
    const apiPost = new NextRequest("https://webhooks.cc/api/go/endpoint", {
      method: "POST",
    });
    const apiRes = await proxy(apiPost);
    expect(apiRes.status).toBe(200);
    expect(getUser).toHaveBeenCalledTimes(1);

    const pageGet = new NextRequest("https://webhooks.cc/", {
      method: "GET",
    });
    const pageRes = await proxy(pageGet);
    expect(pageRes.status).toBe(200);
    expect(pageRes.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(getUser).toHaveBeenCalledTimes(2);
  });
});
