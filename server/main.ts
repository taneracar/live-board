import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const production = process.env.NODE_ENV === "production";
const dbPath = process.env.DB_PATH ?? resolve(root, "data/board.db");
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

const running = await startServer({
  port: Number(process.env.PORT ?? 8790),
  host: process.env.HOST ?? "127.0.0.1",
  dbPath,
  staticDir: production ? resolve(root, "dist") : undefined,
});
console.log(`live-board server on ${running.url} (ws at /ws, db ${dbPath})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void running.close().then(() => process.exit(0)));
}
