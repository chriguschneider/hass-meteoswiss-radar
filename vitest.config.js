import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.mjs"],
    environment: "node",
    // Pin the timezone so DST-boundary tests (issue #66) are deterministic:
    // the timeline label loop uses local-time day arithmetic, and the
    // fall-back bug only reproduces in a zone that observes DST (CET/CEST).
    env: { TZ: "Europe/Zurich" },
  },
  coverage: {
    provider: "v8",
    reporter: ["lcov", "text-summary"],
    // Intended target once the vm limitation is resolved (issue #133):
    //   include: ["custom_components/meteoswiss_radar/frontend/meteoswiss-radar-card.js"]
    // The card is loaded via node:vm; V8 cannot attribute execution inside a
    // vm context back to the source file path, so coverage reports 0 % and
    // the lcov output is not uploaded to SonarCloud (sonar-project.properties
    // leaves sonar.javascript.lcov.reportPaths commented out).
    include: [],
  },
});
