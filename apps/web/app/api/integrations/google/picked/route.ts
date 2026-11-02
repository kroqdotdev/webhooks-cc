import { isPickNonce, pickedFileId } from "@/lib/integrations/google";

/** The channel the dashboard listens on while a Drive pick is open. */
const CHANNEL = "whcc-drive-pick";

/**
 * GET /api/integrations/google/picked?n=&file= (or &error=): where the
 * Drive picker's pop-up ends, on the site the pick started on (the callback
 * sends it here). It hands the file to the dashboard over a BroadcastChannel,
 * which reaches the page that opened it even when Google's pages cut the
 * pop-up off from its opener, and closes itself. The dashboard takes only
 * the nonce it made, so a link here with anything else does nothing.
 */
export function GET(request: Request) {
  const url = new URL(request.url);
  const nonce = url.searchParams.get("n");
  const file = pickedFileId(url.searchParams.get("file"));
  const error = url.searchParams.get("error") === "cancelled" ? "cancelled" : "failed";
  const message = isPickNonce(nonce) ? (file ? { nonce, file } : { nonce, error }) : null;
  // Only checked values reach the script, and "<" is escaped regardless.
  const json = JSON.stringify(message).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Google Drive</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:28rem;padding:0 1rem;color:#1f2933}</style>
</head>
<body>
<p>${file ? "Spreadsheet chosen." : "No spreadsheet was chosen."} You can close this window and go back to the dashboard.</p>
<script>
(function () {
  var message = ${json};
  history.replaceState(null, "", location.pathname);
  if (message && typeof BroadcastChannel === "function") {
    var channel = new BroadcastChannel(${JSON.stringify(CHANNEL)});
    channel.postMessage(message);
    channel.close();
  }
  window.close();
})();
</script>
</body>
</html>
`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
