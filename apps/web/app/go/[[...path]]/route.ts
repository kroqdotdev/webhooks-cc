import type { NextRequest } from "next/server";

/**
 * The Go SDK's import path. `go get webhooks.cc/go` (or any package below it)
 * asks for this page with ?go-get=1 and reads the go-import meta tag: the
 * module lives in packages/sdk-go of the public repository, and its versions
 * are the tags packages/sdk-go/v*. The fourth field, the subdirectory, needs
 * Go 1.25 when the go command resolves the path itself; the module proxy does
 * that for everyone else.
 *
 * Browsers get the docs. A plain /go without go-get never reaches this route:
 * next.config.ts still sends it to the home page, where the retired /go page's
 * links went.
 */
const MODULE_PATH = "webhooks.cc/go";
const REPOSITORY = "https://github.com/kroqdotdev/webhooks-cc";
const MODULE_DIRECTORY = "packages/sdk-go";
const DOCS_PATH = "/docs/sdk/go";

const GO_IMPORT_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="go-import" content="${MODULE_PATH} git ${REPOSITORY} ${MODULE_DIRECTORY}">
<meta name="robots" content="noindex">
<title>${MODULE_PATH}</title>
</head>
<body>
<p><code>go get ${MODULE_PATH}</code>. See the <a href="${DOCS_PATH}">Go SDK docs</a>.</p>
</body>
</html>
`;

export function GET(request: NextRequest): Response {
  if (request.nextUrl.searchParams.get("go-get") !== "1") {
    return new Response(null, { status: 308, headers: { Location: DOCS_PATH } });
  }
  return new Response(GO_IMPORT_PAGE, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Robots-Tag": "noindex",
    },
  });
}
