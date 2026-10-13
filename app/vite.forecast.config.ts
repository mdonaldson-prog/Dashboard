// Builds the standalone Demand Forecast page (forecast.html) to one self-contained file.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [preact(), viteSingleFile()],
  build: {
    outDir: "dist-forecast",
    chunkSizeWarningLimit: 8000,
    reportCompressedSize: false,
    rollupOptions: { input: fileURLToPath(new URL("./forecast.html", import.meta.url)) },
  },
});
