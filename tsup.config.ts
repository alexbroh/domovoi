import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "providers/index": "src/providers/index.ts",
    "calibration/index": "src/calibration/index.ts",
    "testing/index": "src/testing/index.ts",
  },
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  // Declarations are emitted by `tsc --emitDeclarationOnly` (see the
  // `build` script). tsup's rollup-based dts builder injects a deprecated
  // `baseUrl` that fails clean compilation under TypeScript 6.
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
