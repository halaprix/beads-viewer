import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Fixed output names, because the server serves a hardcoded manifest rather than a
// path minus a denylist. Hashed filenames would mean the manifest could not be a
// literal, and seven Vite CVEs exist because denylists lose.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    assetsDir: ".",
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "elk.js",
        assetFileNames: "app.[ext]"
      }
    }
  }
});
