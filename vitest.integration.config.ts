import { defineConfig } from "vitest/config";

// Test di integrazione contro servizi reali (PostgreSQL/PostGIS, GeoServer, nginx): vedi test/integration/README.md.
// Senza le variabili INT_* i test si saltano.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["test/integration/**/*.int.test.ts"],
    setupFiles: ["test/setup-dom.ts"],
    restoreMocks: true,
    fileParallelism: false, // database e workspace condivisi: un file alla volta
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
