import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// DEMO=1 embeds demo-data/demo.json (built from the sample exports by `npm run demo-data`,
// git-ignored because it contains business data) so the page opens with data already loaded.
const demo = process.env.DEMO === "1";
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [preact(), viteSingleFile()],
  define: { __DEMO__: JSON.stringify(demo) },
  resolve: { alias: { "virtual-demo": demo ? r("./demo-data/demo.json") : r("./src/data/demo-stub.json") } },
  build: { chunkSizeWarningLimit: 8000, reportCompressedSize: false },
});
