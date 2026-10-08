/** The domain endpoints receive email on. */
export const DEFAULT_EMAIL_DOMAIN = "mailhooks.cc";

/** An address's local part, slug and tag together, may be at most 64 bytes. */
const MAX_LOCAL_PART = 64;
/** Printable ASCII without the characters an unquoted local part cannot hold. */
const TAG_PATTERN = /^[!#-'*+\-./0-9=?A-Z^-~]+$/;

/**
 * Whether `tag` can follow the plus sign in an endpoint's address. The mail
 * server takes printable ASCII without spaces, quotes, brackets, `@`, `,`,
 * `;` or `:`, and a local part (slug, `+`, tag) of at most 64 bytes.
 */
export function isValidEmailTag(tag: string, slug = ""): boolean {
  return (
    tag.length > 0 &&
    TAG_PATTERN.test(tag) &&
    (slug ? slug.length + 1 + tag.length : tag.length) <= MAX_LOCAL_PART
  );
}

/**
 * The address an endpoint receives email at, with an optional tag:
 * `emailAddress("my-app", "run-42")` is `my-app+run-42@mailhooks.cc`. Mail to
 * a tagged address lands on the same endpoint, and the tag is kept on the
 * captured email, so a test can tell its own email apart.
 */
export function emailAddress(slug: string, tag?: string, domain = DEFAULT_EMAIL_DOMAIN): string {
  if (!/^[a-zA-Z0-9_-]{1,50}$/.test(slug)) {
    throw new Error(`Invalid endpoint slug: "${slug}"`);
  }
  if (tag !== undefined && !isValidEmailTag(tag, slug)) {
    throw new Error(
      `Invalid email tag: "${tag}". Use letters, digits and . _ - = (no spaces), at most ${MAX_LOCAL_PART - slug.length - 1} characters`
    );
  }
  const local = tag === undefined ? slug.toLowerCase() : `${slug.toLowerCase()}+${tag}`;
  return `${local}@${domain}`;
}
