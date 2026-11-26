import { describe, expect, it } from "vitest";
import type { Card, Op } from "../src/shared/board.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";
import { addLocal, initialState, receive, view, type SyncState } from "../src/client/sync-state.ts";

const card = (id: string, title = id): Card => ({ id, column: "todo", rank: "V", title });
const create = (id: string, title = id): Op => ({ kind: "create", card: card(id, title) });

function feed(state: SyncState, ...msgs: ServerMessage[]) {
  let s = state;
  const effects = [];
  for (const m of msgs) {
    const r = receive(s, m);
    s = r.state;
    effects.push(r.effect);
  }
  return { state: s, effects };
}

const welcome = (seq = 0, snapshot = {}): ServerMessage => ({ t: "welcome", seq, snapshot, ops: [], presence: [] });

describe("optimistic view", () => {
  it("shows a local op immediately and keeps it until the server confirms it", () => {
    let s = feed(initialState, welcome()).state;
    s = addLocal(s, { clientOpId: "o1", op: create("a") });
    expect(view(s).a).toBeDefined();
    expect(s.confirmed.a).toBeUndefined();
    s = feed(s, { t: "op", seq: 1, op: create("a"), clientOpId: "o1", clientId: "me" }).state;
    expect(s.pending).toEqual([]);
    expect(s.confirmed.a).toBeDefined();
  });

  it("replays pending ops on top of other people's ops (rebase)", () => {
    let s = feed(initialState, welcome(0, { a: card("a") })).state;
    s = addLocal(s, { clientOpId: "o1", op: { kind: "move", id: "a", column: "done", rank: "V" } });
    // Someone else renames the same card meanwhile.
    s = feed(s, { t: "op", seq: 1, op: { kind: "rename", id: "a", from: "a", to: "Theirs" }, clientOpId: "x", clientId: "other" }).state;
    expect(view(s).a).toMatchObject({ title: "Theirs", column: "done" });
  });

  it("a rejected op disappears from the view and leaves a notice with the winner's text", () => {
    let s = feed(initialState, welcome(0, { a: card("a", "Old") })).state;
    s = addLocal(s, { clientOpId: "o1", op: { kind: "rename", id: "a", from: "Old", to: "Mine" } });
    expect(view(s).a!.title).toBe("Mine");
    s = feed(
      s,
      { t: "op", seq: 1, op: { kind: "rename", id: "a", from: "Old", to: "Theirs" }, clientOpId: "x", clientId: "other" },
      { t: "reject", clientOpId: "o1", reason: "stale-title", card: card("a", "Theirs") },
    ).state;
    expect(view(s).a!.title).toBe("Theirs");
    expect(s.notices[0]!.text).toContain("Theirs");
    expect(s.notices[0]!.text).toContain("Mine");
  });

  it("a pending op whose card was deleted remotely has no visible effect", () => {
    let s = feed(initialState, welcome(0, { a: card("a") })).state;
    s = addLocal(s, { clientOpId: "o1", op: { kind: "move", id: "a", column: "done", rank: "V" } });
    s = feed(s, { t: "op", seq: 1, op: { kind: "delete", id: "a" }, clientOpId: "x", clientId: "other" }).state;
    expect(view(s).a).toBeUndefined();
    expect(s.pending).toHaveLength(1); // until the server's reject arrives
  });
});

describe("ordered stream", () => {
  it("ignores ops it already has and asks to resync on a gap", () => {
    const s = feed(initialState, welcome(5, { a: card("a") })).state;
    expect(feed(s, { t: "op", seq: 5, op: create("z"), clientOpId: "x", clientId: "o" }).state).toBe(s);
    expect(feed(s, { t: "op", seq: 7, op: create("z"), clientOpId: "x", clientId: "o" }).effects).toEqual([{ kind: "resync" }]);
  });

  it("asks to resync if a committed op does not apply (diverged state)", () => {
    const s = feed(initialState, welcome(0)).state;
    const r = feed(s, { t: "op", seq: 1, op: { kind: "delete", id: "ghost" }, clientOpId: "x", clientId: "o" });
    expect(r.effects).toEqual([{ kind: "resync" }]);
  });

  it("catch-up after reconnect confirms ops sent before the drop and resends the rest", () => {
    let s = feed(initialState, welcome(0)).state;
    s = addLocal(s, { clientOpId: "o1", op: create("a") });
    s = addLocal(s, { clientOpId: "o2", op: create("b") });
    const r = feed(s, {
      t: "welcome",
      seq: 1,
      snapshot: null,
      ops: [{ seq: 1, op: create("a"), clientOpId: "o1", clientId: "me" }],
      presence: [],
    });
    expect(r.state.pending.map((p) => p.clientOpId)).toEqual(["o2"]);
    expect(r.effects[0]).toEqual({ kind: "resend", pending: r.state.pending });
  });

  it("a dup answer clears the pending op", () => {
    let s = feed(initialState, welcome(3, { a: card("a") })).state;
    s = addLocal(s, { clientOpId: "o1", op: create("a") });
    expect(feed(s, { t: "dup", clientOpId: "o1", seq: 2 }).state.pending).toEqual([]);
  });

  it("keeps at most five notices", () => {
    let s = feed(initialState, welcome(0)).state;
    for (let i = 0; i < 8; i++) s = feed(s, { t: "reject", clientOpId: `o${i}`, reason: "invalid", card: null }).state;
    expect(s.notices.map((n) => n.id)).toEqual(["o3", "o4", "o5", "o6", "o7"]);
  });
});
