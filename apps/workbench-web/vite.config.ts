import { defineConfig, type ProxyOptions } from "vite";

import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

const workbenchBackendOrigin = new URL(
  process.env.CHATLOG_WORKBENCH_BACKEND_ORIGIN ?? "http://127.0.0.1:4789",
).origin;
const workbenchBackendProxy: ProxyOptions = {
  target: workbenchBackendOrigin,
  changeOrigin: true,
  cookieDomainRewrite: "",
  configure(proxy) {
    proxy.on("proxyReq", (request) => {
      request.setHeader("origin", workbenchBackendOrigin);
    });
  },
};

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
      "/auth": workbenchBackendProxy,
      "/api": workbenchBackendProxy,
    },
  },
});
