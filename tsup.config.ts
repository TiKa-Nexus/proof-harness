import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    shared: "src/shared/index.ts",
    node: "src/node/index.ts",
    playwright: "src/playwright/index.ts",
    server: "src/server/index.ts",
    "portable-vocabulary": "src/portable-vocabulary.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ["@playwright/test", "@supabase/supabase-js", "next"],
  tsconfig: "tsconfig.build.json",
});
