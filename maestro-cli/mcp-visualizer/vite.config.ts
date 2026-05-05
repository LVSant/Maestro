import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { mockBackendPlugin } from "./dev/mock-server";

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile(), mockBackendPlugin()],
  build: {
    outDir: "build/raw",
    emptyOutDir: true,
  },
});
