export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("source-map-support/register");

    const { Appsignal } = await import("@appsignal/nodejs");

    new Appsignal({
      active: process.env.NODE_ENV === "production" && !!process.env.APPSIGNAL_PUSH_API_KEY,
      name: process.env.APPSIGNAL_APP_NAME || "webhooks-cc-web",
      pushApiKey: process.env.APPSIGNAL_PUSH_API_KEY || "",
    });

    // Pre-connect Redis so the first rate-limited request doesn't fall back to in-memory
    const { waitForRedis } = await import("./lib/redis");
    await waitForRedis();
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function onRequestError(error: Error, request: Request, context: unknown) {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { sendError } = await import("@appsignal/nodejs");
    sendError(error);
  }
}
