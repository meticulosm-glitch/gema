import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node", // logica pura e script di entrypoint; i test dei componenti scelgono jsdom con `// @vitest-environment jsdom`
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: ["test/integration/**", "**/node_modules/**"], // i test di integrazione hanno la loro config (vitest.integration.config.ts)
    setupFiles: ["test/setup-dom.ts"],
    restoreMocks: true,
  },
});
