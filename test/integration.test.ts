// Real server, real sockets, real SyncClient (Node's built-in WebSocket).

import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { columnCards, COLUMN_IDS, rankAt, type Board, type ColumnId, type Op } from "../src/shared/board.ts";
import { SyncClient } from "../src/client/sync-client.ts";
import { startServer, type Running } from "../server/server.ts";

let server: Running | null = null;
const clients: SyncClient[] = [];

afterEach(async () => {
  clients.splice(0).forEach((c) => c.stop());
  await server?.close();
  server = null;
});

function client(name: string, rng = Math.random) {
  const c = new SyncClient({
    url: server!.url.replace("http", "ws") + "/ws",
    identity: { clientId: name, name, color: "#336699" },
    backoffBaseMs: 5,
    backoffMaxMs: 40,
    random: rng,
  });
  clients.push(c);
  c.start();
  return c;
}

async function until(pred: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settled = (cs: SyncClient[]) => () =>
  cs.every((c) => c.status === "online" && c.state.pending.length === 0 && c.state.seq === server!.room.state.seq);

const order = (b: Board) => COLUMN_IDS.map((col) => columnCards(b, col).map((c) => `${c.id}:${c.title}`).join(","));

describe("end to end", () => {
  it("an op from one client shows up on another, and presence is shared", async () => {
    server = await startServer({ presenceIntervalMs: 5 });
    const a = client("ana");
    const b = client("bo");
    await until(() => a.status === "online" && b.status === "online");
    a.submit({ kind: "create", card: { id: "c1", column: "todo", rank: "V", title: "Write tests" } });
    expect(a.board.c1).toBeDefined(); // optimistic: before any network round trip
    await until(() => b.board.c1?.title === "Write tests");

    a.setPresence({ editing: "c1" });
    await until(() => b.state.presence.some((p) => p.clientId === "ana" && p.editing === "c1"));
    a.stop();
    await until(() => !b.state.presence.some((p) => p.clientId === "ana"));
  });

  it("ops made while disconnected are sent once on reconnect, never twice", async () => {
    server = await startServer();
    const a = client("ana");
    const b = client("bo");
    await until(settled([a, b]));
    const before = a.sessions;
    a.dropConnection();
    // The socket is closing, so these stay pending instead of being sent.
    a.submit({ kind: "create", card: { id: "c1", column: "todo", rank: "V", title: "offline" } });
    a.submit({ kind: "rename", id: "c1", from: "offline", to: "offline, renamed" });
    expect(a.board.c1?.title).toBe("offline, renamed");
    expect(server.room.state.seq).toBe(0);
    await until(() => a.sessions > before && settled([a, b])());
    expect(b.board.c1?.title).toBe("offline, renamed");
    expect(server.room.state.seq).toBe(2);
  });

  it("an op whose ack was lost is not applied twice when resent", async () => {
    server = await startServer();
    const a = client("ana");
    await until(settled([a]));
    a.submit({ kind: "create", card: { id: "c1", column: "todo", rank: "V", title: "x" } });
    // Drop the socket right after sending, before the ack can arrive.
    const before = a.sessions;
    a.dropConnection();
    await until(() => a.sessions > before && settled([a])());
    expect(server.room.state.seq).toBe(1);
    expect(Object.keys(a.board)).toEqual(["c1"]);
  });

  it("recovers after a server restart that lost all state (client is ahead)", async () => {
    server = await startServer();
    const port = server.port;
    const a = client("ana");
    await until(settled([a]));
    a.submit({ kind: "create", card: { id: "c1", column: "todo", rank: "V", title: "x" } });
    await until(settled([a]));
    await server.close();
    server = await startServer({ port });
    await until(() => a.status === "online");
    await until(() => a.state.seq === 0 && Object.keys(a.board).length === 0);
  });

  it("chaos: random ops and random disconnects from three clients converge to the server's board", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 31 - 1 }), async (seed) => {
        let x = seed;
        const rng = () => ((x = (x * 48271) % 2147483647) / 2147483647);
        server = await startServer({ ratePerSec: 10_000, burst: 10_000 });
        const cs = ["ana", "bo", "cy"].map((n) => client(n, rng));
        await until(settled(cs));

        let n = 0;
        for (let step = 0; step < 120; step++) {
          const c = cs[Math.floor(rng() * cs.length)]!;
          const board = c.board;
          const ids = Object.keys(board);
          const pick = rng();
          let op: Op;
          if (ids.length === 0 || pick < 0.3) {
            const column = COLUMN_IDS[Math.floor(rng() * 3)] as ColumnId;
            op = { kind: "create", card: { id: `k${n++}`, column, rank: rankAt(board, column, Math.floor(rng() * 5)), title: `t${n}` } };
          } else {
            const id = ids[Math.floor(rng() * ids.length)]!;
            if (pick < 0.65) {
              const column = COLUMN_IDS[Math.floor(rng() * 3)] as ColumnId;
              op = { kind: "move", id, column, rank: rankAt(board, column, Math.floor(rng() * 5), id) };
            } else if (pick < 0.9) {
              op = { kind: "rename", id, from: board[id]!.title, to: `r${step}` };
            } else {
              op = { kind: "delete", id };
            }
          }
          c.submit(op);
          if (rng() < 0.08) c.dropConnection();
          if (rng() < 0.3) await new Promise((r) => setTimeout(r, Math.floor(rng() * 4)));
        }

        await until(settled(cs), 10_000);
        const truth = order(server.room.state.board);
        for (const c of cs) {
          expect(order(c.board)).toEqual(truth);
          expect(c.board).toEqual(server.room.state.board);
        }
        // Ranks in each column are unique on the server.
        for (const col of COLUMN_IDS) {
          const ranks = columnCards(server.room.state.board, col).map((c) => c.rank);
          expect(new Set(ranks).size).toBe(ranks.length);
        }
        clients.splice(0).forEach((c) => c.stop());
        await server.close();
        server = null;
      }),
      { numRuns: 8 },
    );
  }, 60_000);
});
