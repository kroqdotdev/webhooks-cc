/**
 * What the device login's approval page says about where a login came from.
 *
 * Only a login from the browser's own network goes without a word. A
 * different network gets a warning; one the server could not compare (no
 * address, or the other IP version) gets a caution, because the requester
 * chooses its IP version and could otherwise switch the warning off. The
 * `remote` flag never softens either: the terminal sets it, so a phisher
 * would too, and the page says as much.
 */
export type NetworkNotice = { level: "warning" | "caution"; text: string } | null;

export function networkNotice(
  network: "same" | "different" | "unknown",
  remote: boolean,
  noun: "login" | "request" = "login"
): NetworkNotice {
  if (network === "same") return null;
  const claim = remote
    ? " Its terminal says it runs on another machine, which any terminal can say."
    : "";
  if (network === "different") {
    return {
      level: "warning",
      text: `This ${noun} came from a different network than this browser.${claim} Approve it only if you started it yourself, just now.`,
    };
  }
  return {
    level: "caution",
    text: `We could not check that this ${noun} came from your network.${claim} Approve it only if you started it yourself, just now.`,
  };
}
