import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import NotFound from "./not-found";

function renderAt(pathname: string): string {
  navigation.pathname = pathname;
  return renderToStaticMarkup(<NotFound />);
}

describe("NotFound", () => {
  afterEach(() => {
    navigation.pathname = "/";
  });

  // Next prerenders the 404 page once, as /_not-found, and hydrates that HTML
  // at whatever missing URL the browser asked for. Anything the page renders
  // differently for the browser's path is a hydration mismatch (React #418).
  it("renders the same markup at every missing URL as it was prerendered with", () => {
    const prerendered = renderAt("/_not-found");
    for (const path of [
      "/loginlog-in",
      "/login/foo",
      "/auth/foo",
      "/dashboard/missing",
      "/account/nope",
      "/teams/x",
      "/docs/missing-page",
      "/blog/missing-post",
    ]) {
      expect(renderAt(path), path).toBe(prerendered);
    }
  });
});
