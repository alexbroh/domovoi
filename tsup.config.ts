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
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
