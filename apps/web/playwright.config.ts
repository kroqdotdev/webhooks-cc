import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import path from "path";

// Load .env.local from the monorepo root (symlinked into apps/web)
dotenv.config({ path: path.resolve(__dirname, ".env.local") });

const useProductionServer = process.env.PLAYWRIGHT_USE_PROD_SERVER === "1";
const port = Number(process.env.PLAYWRIGHT_PORT ?? (useProductionServer ? 3100 : 3000));
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`;
const reuseWebServer =
  process.env.PLAYWRIGHT_REUSE_SERVER === "1" || (!process.env.CI && !useProductionServer);
const shouldManageReceiver = !process.env.WHK_WEBHOOK_URL;
const receiverURL = process.env.WHK_WEBHOOK_URL ?? "http://localhost:3101";
const receiverPort = Number(new URL(receiverURL).port || 80);
const cargoBin = process.env.CARGO ?? `${process.env.HOME}/.cargo/bin/cargo`;

// E2E tests exercise encrypted signing-secret paths. Use a deterministic
// test-only key when local development env does not provide one.
const signingSecretKey = process.env.SIGNING_SECRET_KEY ?? Buffer.alloc(32, 7).toString("base64");
process.env.SIGNING_SECRET_KEY = signingSecretKey;
process.env.WHK_WEBHOOK_URL = receiverURL;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./screenshots/test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["html", { outputFolder: "./screenshots/report" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: useProductionServer
        ? `PORT=${port} HOSTNAME=127.0.0.1 pnpm start`
        : `pnpm dev --hostname 127.0.0.1 --port ${port}`,
      url: baseURL,
      reuseExistingServer: reuseWebServer,
      timeout: 120_000,
    },
    ...(shouldManageReceiver
      ? [
          {
            command: `cd ../receiver-rs && set -a && . ../../.env.local && set +a && PORT=${receiverPort} SIGNING_SECRET_KEY=${signingSecretKey} ${cargoBin} run`,
            url: new URL("/health", receiverURL).toString(),
            reuseExistingServer: true,
            timeout: 120_000,
          },
        ]
      : []),
  ],
});
