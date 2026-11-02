declare const PKG_VERSION: string | undefined;

/** The package version, filled in by the build. */
export const VERSION = typeof PKG_VERSION !== "undefined" ? PKG_VERSION : "0.0.0-dev";

/**
 * The MCP server's product token, sent before the SDK's in the User-Agent of
 * its API calls, so webhooks.cc can tell its calls from other Node clients.
 */
export const MCP_USER_AGENT = `webhooks-cc-mcp/${VERSION}`;
