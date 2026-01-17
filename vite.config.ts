// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vercel: SPA default OK. No special rewrites needed.
// Keep it minimal to avoid breaking wallet adapter bundling.

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    sourcemap: false,
    target: "es2022",
  },
});
