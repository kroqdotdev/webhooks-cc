/**
 * How the pages a person answers an agent's request on (/approve, a
 * checkout link's /checkout/{id}) say where and when it was asked.
 */

/** A country's name from Cloudflare's code (CF-IPCountry); T1 is Tor. */
export function countryName(code: string): string {
  if (code === "T1") return "the Tor network";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** "Less than a minute ago", "1 minute ago", "12 minutes ago", "3 hours ago". */
export function askedAgo(timestamp: number, now = Date.now()): string {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return "Less than a minute ago";
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}
