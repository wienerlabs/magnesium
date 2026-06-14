import { defineConfig } from "tsup";

export default defineConfig({
  entry: { magnesium: "src/cli/main.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  dts: false,
  // better-sqlite3 is a native module and must not be bundled.
  external: ["better-sqlite3"],
  banner: { js: "#!/usr/bin/env node" },
});
