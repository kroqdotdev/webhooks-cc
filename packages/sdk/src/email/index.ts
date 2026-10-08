/**
 * `@webhooks-cc/sdk/email`: email types, the code and link extractor, the
 * `email.received` JSON builder and address helpers. No network code and no
 * other SDK modules, so it is safe to import in a browser bundle.
 */
export * from "./types";
export {
  extractFromEmail,
  extractCode,
  extractLink,
  htmlToText,
  type EmailContent,
  type EmailLike,
} from "./extract";
export { buildEmailJson } from "./json";
export { emailAddress, isValidEmailTag, DEFAULT_EMAIL_DOMAIN } from "./address";
