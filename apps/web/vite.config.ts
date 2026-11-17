import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  root: "apps/web",
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist" },
  server: {
    host: "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:4310", "/mcp": "http://127.0.0.1:4310" },
  },
});
