import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/gate-f-e2e.json" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    launchOptions: { args: ["--disable-web-security"] },
    trace: "retain-on-failure",
    video: "off"
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173/",
    reuseExistingServer: true,
    timeout: 120_000
  }
});
