const BASE_IMG_SRC =
  "img-src 'self' data: blob: https://avatars.githubusercontent.com https://lh3.googleusercontent.com";

/**
 * The page's img-src directive. Dashboard pages also allow any https image:
 * the email preview (components/dashboard/email-detail.tsx) renders in a
 * srcdoc iframe, which inherits this policy, and "Load images" must be able
 * to fetch an email's remote images. The preview's own policy keeps them
 * blocked until the viewer asks, and scripts stay restricted everywhere.
 */
export function imgSrcDirective(pathname: string): string {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/")
    ? `${BASE_IMG_SRC} https:`
    : BASE_IMG_SRC;
}
