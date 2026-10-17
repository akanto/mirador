import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 300_000,
  // A Windows runner under four workers needs more patience than a dev machine for the page to catch up.
  expect: { timeout: process.platform === "win32" ? 60_000 : 20_000 },
  workers: 4,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    channel: process.platform === "darwin" ? "chrome" : undefined,
    viewport: { width: 1600, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
