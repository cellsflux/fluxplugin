import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const r = (p: string) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), p);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^fluxplugin$/, replacement: r("src/core/index.ts") },
      { find: /^fluxplugin\/main$/, replacement: r("src/main/index.ts") },
      { find: /^fluxplugin\/preload$/, replacement: r("src/preload/index.ts") },
      { find: /^fluxplugin\/react$/, replacement: r("src/react/index.ts") },
      { find: /^fluxplugin\/manager-ui$/, replacement: r("src/manager-ui/index.tsx") },
      { find: /^fluxplugin\/cli$/, replacement: r("src/cli/index.ts") },
    ],
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}", "packages/*/test/**/*.test.{ts,tsx}"],
    environment: "node",
    testTimeout: 10000,
  },
});
