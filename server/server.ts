// HTTP + WebSocket wiring around the Room. Kept thin on purpose: the logic
// worth testing lives in room.ts; this file adds heartbeats, payload limits and
// static file serving for the built UI.

import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { Room, type Conn, type RoomOptions } from "./room.ts";
import { sqliteStore } from "./store.ts";

export interface ServerOptions extends RoomOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  /** Serve the built UI from here (production). Omit in dev, where Vite does it. */
  staticDir?: string;
  heartbeatMs?: number;
}

export interface Running {
  url: string;
  port: number;
  room: Room;
  http: Server;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

export async function startServer(opts: ServerOptions = {}): Promise<Running> {
  const store = sqliteStore(opts.dbPath ?? ":memory:");
  const room = new Room(store, opts);

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, seq: room.state.seq, connections: room.connections }));
      return;
    }
    if (!opts.staticDir || req.method !== "GET") {
      res.writeHead(404).end();
      return;
    }
    const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
    if (rel.includes("..")) {
      res.writeHead(400).end();
      return;
    }
    try {
      const body = await readFile(join(opts.staticDir, rel));
      res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      const index = await readFile(join(opts.staticDir, "index.html"));
      res.writeHead(200, { "content-type": TYPES[".html"] });
      res.end(index);
    }
  });

  // 16 KB is far above any legal message (titles cap at 200 chars).
  const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 16 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on("connection", (ws) => {
    alive.set(ws, true);
    const conn: Conn = {
      send: (msg) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      close: (code, reason) => ws.close(code, reason),
    };
    room.open(conn);
    ws.on("pong", () => alive.set(ws, true));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(1003, "text only");
      room.receive(conn, data.toString());
    });
    ws.on("close", () => room.close(conn));
    ws.on("error", () => room.close(conn));
  });

  // Protocol-level ping: drops sockets whose peer vanished without a FIN
  // (laptop lid closed, phone left wifi), so presence doesn't show ghosts.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, opts.heartbeatMs ?? 15_000);

  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    room,
    http,
    async close() {
      clearInterval(heartbeat);
      room.dispose();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
      store.close();
    },
  };
}
