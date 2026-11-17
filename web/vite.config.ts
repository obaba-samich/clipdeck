import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "../clipdeck/static", emptyOutDir: true, assetsInlineLimit: 0 },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:7878",
      "/media": "http://127.0.0.1:7878",
      "/s/": "http://127.0.0.1:7878",
    },
  },
});
