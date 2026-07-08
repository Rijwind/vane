import { defineConfig } from "vite";

export default defineConfig({
  build: { target: "es2022" },
  esbuild: { target: "es2022" },
  optimizeDeps: {
    // Don't pre-bundle the local workspace package: Vite caches the optimized
    // copy keyed on config/lockfile, not on dist content, so a `bun run build`
    // of @rijwind/vane wouldn't show up on restart. Excluded → Vite serves its
    // dist straight, so a rebuild + browser refresh is enough (no --force).
    exclude: ["@rijwind/vane"],
    esbuildOptions: { target: "es2022" },
  },
});
