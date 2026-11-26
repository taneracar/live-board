import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { columnCards, type Card, type Op } from "../src/shared/board.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";
import { Room, type Conn } from "../server/room.ts";
import { sqliteStore, type Store } from "../server/store.ts";

class FakeConn implements Conn {
  inbox: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  send(msg: ServerMessage) {
    this.inbox.push(msg);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  last<T extends ServerMessage["t"]>(t: T): Extract<ServerMessage, { t: T }> {
    const m = [...this.inbox].reverse().find((x) => x.t === t);
    if (!m) throw new Error(`no ${t} message`);
    return m as Extract<ServerMessage, { t: T }>;
  }
}

const presence = (name = "Ana") => ({ name, color: "#336699", editing: null, dragging: null });
const card = (id: string, rank = "V", title = id): Card => ({ id, column: "todo", rank, title });

let rooms: Room[] = [];
let stores: Store[] = [];
afterEach(() => {
  rooms.forEach((r) => r.dispose());
  stores.forEach((s) => s.close());
  rooms = [];
  stores = [];
  vi.useRealTimers();
});

function setup(opts: ConstructorParameters<typeof Room>[1] = {}, store = sqliteStore()) {
  stores.push(store);
  const room = new Room(store, { presenceIntervalMs: 0, ...opts });
  rooms.push(room);
  const join = (clientId: string, lastSeq = 0) => {
    const c = new FakeConn();
    room.open(c);
    room.receive(c, JSON.stringify({ t: "hello", clientId, lastSeq, presence: presence(clientId) }));
    return c;
  };
  const send = (c: FakeConn, clientOpId: string, op: Op) => room.receive(c, JSON.stringify({ t: "op", clientOpId, op }));
  return { room, store, join, send };
}

describe("Room", () => {
  it("orders ops, assigns seq, and broadcasts to everyone including the sender", () => {
    const { join, send, room } = setup();
    const a = join("a");
    const b = join("b");
    send(a, "o1", { kind: "create", card: card("x") });
    send(b, "o2", { kind: "create", card: card("y", "k") });
    for (const c of [a, b]) {
      const ops = c.inbox.filter((m) => m.t === "op");
      expect(ops.map((m) => (m as { seq: number }).seq)).toEqual([1, 2]);
    }
    expect(room.state.seq).toBe(2);
  });

  it("is idempotent on clientOpId: a resend gets `dup`, not a second apply", () => {
    const { join, send, room } = setup();
    const a = join("a");
    send(a, "o1", { kind: "create", card: card("x") });
    send(a, "o1", { kind: "create", card: card("x") });
    expect(a.last("dup")).toEqual({ t: "dup", clientOpId: "o1", seq: 1 });
    expect(room.state.seq).toBe(1);
  });

  it("rejects to the sender only, with the current card so the client can explain", () => {
    const { join, send } = setup();
    const a = join("a");
    const b = join("b");
    send(a, "o1", { kind: "create", card: card("x", "V", "Old") });
    send(a, "o2", { kind: "rename", id: "x", from: "Old", to: "A wins" });
    send(b, "o3", { kind: "rename", id: "x", from: "Old", to: "B loses" });
    expect(b.last("reject")).toMatchObject({ clientOpId: "o3", reason: "stale-title", card: { title: "A wins" } });
    expect(a.inbox.some((m) => m.t === "reject")).toBe(false);
  });

  it("nudges a colliding rank so two concurrent drops into one gap keep a stable order", () => {
    const { join, send, room } = setup();
    const a = join("a");
    send(a, "o1", { kind: "create", card: card("x", "V") });
    send(a, "o2", { kind: "create", card: card("z", "k") });
    send(a, "o3", { kind: "create", card: card("y", "V") }); // same rank as x
    const ranks = columnCards(room.state.board, "todo").map((c) => [c.id, c.rank]);
    expect(ranks.map(([id]) => id)).toEqual(["x", "y", "z"]);
    expect(new Set(ranks.map(([, r]) => r)).size).toBe(3);
    // The broadcast carries the rewritten rank, so clients converge on it.
    const committed = a.inbox.filter((m) => m.t === "op").at(-1) as Extract<ServerMessage, { t: "op" }>;
    expect(committed.op).toMatchObject({ kind: "create", card: { id: "y" } });
    expect((committed.op as { card: Card }).card.rank).not.toBe("V");
  });

  it("reconnect: sends only missed ops, or a snapshot when too far behind or ahead", () => {
    const { join, send } = setup({ catchUpLimit: 3 });
    const a = join("a");
    for (let i = 0; i < 5; i++) send(a, `o${i}`, { kind: "create", card: card(`c${i}`, `${"V".repeat(i + 1)}`) });

    const near = join("b", 3).last("welcome");
    expect(near.snapshot).toBeNull();
    expect(near.ops.map((o) => o.seq)).toEqual([4, 5]);

    const far = join("c", 1).last("welcome");
    expect(far.snapshot).not.toBeNull();
    expect(Object.keys(far.snapshot!)).toHaveLength(5);

    const future = join("d", 99).last("welcome"); // server lost data / was reset
    expect(future.snapshot).not.toBeNull();
    expect(future.seq).toBe(5);
  });

  it("requires hello before ops and ignores garbage without crashing", () => {
    const { room } = setup();
    const c = new FakeConn();
    room.open(c);
    room.receive(c, JSON.stringify({ t: "op", clientOpId: "o1", op: { kind: "delete", id: "x" } }));
    room.receive(c, "{not json");
    room.receive(c, JSON.stringify({ t: "op", clientOpId: "o1", op: { kind: "create", card: { id: "x" } } }));
    expect(c.inbox.map((m) => (m as { message?: string }).message)).toEqual(["hello first", "malformed JSON", "invalid message"]);
    expect(room.state.seq).toBe(0);
  });

  it("rate-limits a flooding connection and closes it", () => {
    let now = 0;
    const { join, room } = setup({ ratePerSec: 10, burst: 5, now: () => now });
    const a = join("a"); // hello used 1 token
    for (let i = 0; i < 4; i++) room.receive(a, JSON.stringify({ t: "ping" }));
    expect(a.closed).toBeNull();
    room.receive(a, JSON.stringify({ t: "ping" }));
    expect(a.closed?.code).toBe(1008);
    expect(room.connections).toBe(0);

    // Tokens refill over time for a well-behaved client.
    const b = join("b");
    for (let i = 0; i < 4; i++) room.receive(b, JSON.stringify({ t: "ping" }));
    now += 1000;
    for (let i = 0; i < 5; i++) room.receive(b, JSON.stringify({ t: "ping" }));
    expect(b.closed).toBeNull();
  });

  it("a second connection with the same clientId replaces the first (no ghost presence)", async () => {
    const { join, room } = setup();
    const first = join("tab1");
    join("tab1");
    expect(first.closed?.code).toBe(4000);
    expect(room.connections).toBe(1);
  });

  it("presence is coalesced and dropped on close", async () => {
    vi.useFakeTimers();
    const { join, room } = setup({ presenceIntervalMs: 50 });
    const a = join("a");
    const b = join("b");
    for (let i = 0; i < 10; i++) {
      room.receive(a, JSON.stringify({ t: "presence", presence: { ...presence("a"), editing: i % 2 ? "x" : null } }));
    }
    const before = b.inbox.filter((m) => m.t === "presence").length;
    vi.advanceTimersByTime(60);
    const after = b.inbox.filter((m) => m.t === "presence");
    expect(after.length - before).toBe(1);
    expect(b.last("presence").presence.find((p) => p.clientId === "a")?.editing).toBe("x");

    room.close(a);
    vi.advanceTimersByTime(60);
    expect(b.last("presence").presence.map((p) => p.clientId)).toEqual(["b"]);
  });

  it("state survives a restart from the same database file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "live-board-")), "b.db");
    const s1 = sqliteStore(path);
    const r1 = new Room(s1, { presenceIntervalMs: 0 });
    const c = new FakeConn();
    r1.open(c);
    r1.receive(c, JSON.stringify({ t: "hello", clientId: "a", lastSeq: 0, presence: presence() }));
    r1.receive(c, JSON.stringify({ t: "op", clientOpId: "o1", op: { kind: "create", card: card("x") } }));
    r1.receive(c, JSON.stringify({ t: "op", clientOpId: "o2", op: { kind: "rename", id: "x", from: "x", to: "Kept" } }));
    r1.dispose();
    s1.close();

    const { room, join: join2, send } = setup({}, sqliteStore(path));
    expect(room.state.seq).toBe(2);
    expect(room.state.board.x!.title).toBe("Kept");
    const again = join2("a");
    send(again, "o1", { kind: "create", card: card("x") }); // resend after restart
    expect(again.last("dup").seq).toBe(1);
  });
});
