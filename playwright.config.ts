import { defineConfig, devices } from "@playwright/test";

const PORT = 8791;

export default defineConfig({
  testDir: "e2e",
  timeout: 20_000,
  fullyParallel: false,
  workers: 1, // one shared board server; tests clean up after themselves
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npm run build && NODE_ENV=production PORT=${PORT} DB_PATH=:memory: node server/main.ts`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
