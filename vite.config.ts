import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, Vite serves the UI and forwards /ws to the board server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_PORT ?? 5196),
    strictPort: true,
    proxy: { "/ws": { target: `ws://127.0.0.1:${process.env.PORT ?? 8790}`, ws: true } },
  },
});
