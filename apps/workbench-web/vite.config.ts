import { defineConfig } from "vite";

import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/memory/",
  plugins: [foldkit(), tailwindcss()],
  build: {
    outDir: "../../src/workbench/public/memory",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4789",
    },
  },
});
