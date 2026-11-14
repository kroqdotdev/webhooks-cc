/**
 * Choosing a spreadsheet from Drive in the browser (lib/integrations/google.ts,
 * pickerUrl): Google's picker opens in a pop-up as a page of its own, and the
 * pick comes back from the picked page (app/api/integrations/google/picked)
 * on a BroadcastChannel with the nonce this pick made. Used by the Sheets
 * editor and the approval page. Client-only.
 */

/** Where the picked page posts the pick. */
export const DRIVE_PICK_CHANNEL = "whcc-drive-pick";

export function pickNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export class DrivePickError extends Error {}

/**
 * Opens the picker and resolves with the chosen file's id, or null when the
 * person closed it without choosing. Call it from the click itself, so pop-up
 * blockers let the window through. `pickerUrl` asks the server for Google's
 * URL for this nonce.
 */
export function pickFromDrive(
  pickerUrl: (nonce: string) => Promise<string>
): Promise<string | null> {
  if (typeof BroadcastChannel !== "function") {
    return Promise.reject(
      new DrivePickError(
        "This browser cannot take the pick back from Google. Use a current browser."
      )
    );
  }
  const popup = window.open("", "whcc-drive-pick", "popup,width=960,height=720");
  if (!popup) {
    return Promise.reject(
      new DrivePickError(
        "Your browser blocked Google's window. Allow pop-ups for this site and try again."
      )
    );
  }
  const nonce = pickNonce();
  const channel = new BroadcastChannel(DRIVE_PICK_CHANNEL);
  return new Promise<string | null>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      channel.close();
      clearInterval(watch);
      fn();
    };
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { nonce?: unknown; file?: unknown; error?: unknown } | null;
      if (data?.nonce !== nonce) return;
      if (typeof data.file === "string") finish(() => resolve(data.file as string));
      else if (data.error === "cancelled") finish(() => resolve(null));
      else if (data.error === "expired") {
        finish(() =>
          reject(new DrivePickError("Google's window was open too long. Choose from Drive again."))
        );
      } else finish(() => reject(new DrivePickError("Google did not say which spreadsheet.")));
    };
    // Closed without a pick: give up after a moment (the message may still
    // be on its way when the window closes itself).
    const watch = setInterval(() => {
      if (popup.closed) setTimeout(() => finish(() => resolve(null)), 1500);
    }, 500);
    pickerUrl(nonce)
      .then((url) => {
        if (!settled) popup.location.href = url;
      })
      .catch((error: unknown) => {
        popup.close();
        finish(() =>
          reject(error instanceof Error ? error : new DrivePickError("The picker could not open."))
        );
      });
  });
}
