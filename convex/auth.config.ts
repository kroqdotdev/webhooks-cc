// Validate required environment variable
const siteUrl = process.env.CONVEX_SITE_URL;
if (!siteUrl) {
  throw new Error("CONVEX_SITE_URL environment variable is required for auth configuration");
}

export default {
  providers: [
    {
      domain: siteUrl,
      applicationID: "convex",
    },
  ],
};
