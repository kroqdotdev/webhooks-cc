/**
 * `@webhooks-cc/sdk/email`: email types, the code and link extractor, reply
 * stripping, named fields, the `email.received` JSON builder, the inbound
 * provider shapes and address helpers. No network code and no other SDK
 * modules, so it is safe to import in a browser bundle.
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
export {
  MAX_LAYOUTS,
  MAX_LAYOUT_NAME_CHARS,
  MAX_LINE_ITEMS,
  MAX_LINE_ITEM_COLUMNS,
  MAX_LINE_ITEM_PATTERN_CHARS,
  type Layout,
  type LineItemSource,
  type LineItemsSpec,
  type ParsedAttachment,
  type ParsedEmail,
} from "./layouts";
export { parseReply, replyText, type ParsedReply } from "./reply";
export {
  EMAIL_FIELD_SOURCES,
  MAX_EMAIL_FIELDS,
  MAX_EMAIL_FIELD_PATTERN_CHARS,
  MAX_EMAIL_FIELD_TEXT_CHARS,
  MAX_EMAIL_FIELD_VALUE_CHARS,
  emailFieldIssues,
  extractEmailFields,
  type EmailField,
  type EmailFieldFinder,
  type EmailFieldSource,
  type EmailFieldSourceData,
} from "./fields";
export {
  INBOUND_EMAIL_FORMATS,
  INBOUND_EMAIL_FORMAT_NAMES,
  emailHeaderList,
  inboundEmailPayload,
  isInboundEmailFormat,
  renderInboundEmail,
  type InboundEmailFormat,
  type InboundEmailOptions,
  type InboundEmailPayload,
  type InboundSyncOptions,
} from "./inbound";
export { emailAddress, isValidEmailTag, DEFAULT_EMAIL_DOMAIN } from "./address";
