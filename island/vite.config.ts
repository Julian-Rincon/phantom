// `defineConfig` from "vitest/config" re-exports Vite's own and adds the
// `test` field's typing, so one file covers both `vite build` and `vitest` —
// no separate vitest.config.ts needed.
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// All UI sounds are synthesized at runtime with WebAudio (see src/core/sound.ts)
// — no audio files to serve or bundle, and nothing borrowed from the reference
// app's unlicensed assets.

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        island: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
