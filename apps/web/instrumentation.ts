export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    require("source-map-support/register");

    const { Appsignal } = await import("@appsignal/nodejs");

    new Appsignal({
      active: process.env.NODE_ENV === "production" && !!process.env.APPSIGNAL_PUSH_API_KEY,
      name: process.env.APPSIGNAL_APP_NAME || "webhooks-cc-web",
      pushApiKey: process.env.APPSIGNAL_PUSH_API_KEY || "",
    });
  }
}

export async function onRequestError(
  error: Error,
  _request: unknown,
  _context: unknown,
) {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { sendError } = await import("@appsignal/nodejs");
    sendError(error);
  }
}
