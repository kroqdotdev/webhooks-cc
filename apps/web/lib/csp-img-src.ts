const BASE_IMG_SRC =
  "img-src 'self' data: blob: https://avatars.githubusercontent.com https://lh3.googleusercontent.com";

/**
 * The pages' img-src directive, which also allows any https image: the email
 * preview (components/dashboard/email-detail.tsx) renders in a srcdoc
 * iframe, which inherits the page's policy, and "Load images" must be able
 * to fetch an email's remote images. Every page allows it, not only the
 * dashboard: a document keeps the policy of the page it was first loaded as,
 * and signing in reaches the dashboard without loading a new one. The
 * preview's own policy keeps images blocked until the viewer asks, and
 * scripts stay restricted everywhere.
 */
export function imgSrcDirective(): string {
  return `${BASE_IMG_SRC} https:`;
}
