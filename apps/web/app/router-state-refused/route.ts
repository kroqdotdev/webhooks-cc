/**
 * Where next.config.ts rewrites an RSC request whose router state header is
 * not what Next's client writes (lib/router-state-header.ts). Rendering the
 * page would throw on the header, a 500; this answers 400 for every method.
 */

function refused(): Response {
  return new Response("Bad Request", {
    status: 400,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export const GET = refused;
export const HEAD = refused;
export const POST = refused;
export const PUT = refused;
export const PATCH = refused;
export const DELETE = refused;
export const OPTIONS = refused;
