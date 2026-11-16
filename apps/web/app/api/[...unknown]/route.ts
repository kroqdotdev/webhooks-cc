/**
 * Any /api path no route answers: a JSON 404 in the shape every API error
 * has, rather than the HTML 404 page, which clients (the CLI's `whk api`,
 * the SDKs, agents) would print or fail to parse. Next matches every real
 * route first, so this only ever sees paths nothing else has.
 */
function notFound(request: Request): Response {
  const { pathname } = new URL(request.url);
  return Response.json(
    {
      error: "not_found",
      message: `No API route at ${request.method} ${pathname}. The API reference is at /docs/api.`,
    },
    { status: 404, headers: { "X-Robots-Tag": "noindex, nofollow" } }
  );
}

export const GET = notFound;
export const HEAD = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
