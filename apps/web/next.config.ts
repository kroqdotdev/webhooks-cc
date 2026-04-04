import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@webhooks-cc/sdk"],
};

export default nextConfig;
