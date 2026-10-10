/** Headers the notify proxy (infra/notify-proxy) reads as instructions; never taken from a delivery. */
export const PROXY_CONTROL_HEADERS = new Set([
  "x-target-url",
  "x-auth",
  "x-proxy-mode",
  "x-sender-ip",
]);
