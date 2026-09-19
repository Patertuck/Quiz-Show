import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual",
  timeout: 30_000,
  expect: { timeout: 5_000, toHaveScreenshot: { animations: "disabled", maxDiffPixelRatio: 0.01 } },
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  globalSetup: "./tests/visual/global-setup.mjs",
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    channel: "chrome",
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "de-CH"
  },
  outputDir: "test-results/visual"
});
