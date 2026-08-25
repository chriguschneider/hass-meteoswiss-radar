import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.mjs"],
    environment: "node",
    // Pin the timezone so DST-boundary tests (issue #66) are deterministic:
    // the timeline label loop uses local-time day arithmetic, and the
    // fall-back bug only reproduces in a zone that observes DST (CET/CEST).
    env: { TZ: "Europe/Zurich" },
    // Coverage config must live under `test`; at the config root vitest
    // ignores it (falling back to default reporters and no lcov output).
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text-summary"],
      include: [
        "custom_components/meteoswiss_radar/frontend/meteoswiss-radar-card.js",
      ],
    },
  },
});
