import { describe, expect, it } from "vitest";
import { applyOp, columnCards, COLUMN_IDS, MAX_CARDS, rankAt, type Board, type Card } from "../src/shared/board.ts";
import { clientMessageSchema, columnSchema } from "../src/shared/protocol.ts";

const card = (id: string, column: Card["column"], rank: string, title = id): Card => ({ id, column, rank, title });

function must(board: Board, op: Parameters<typeof applyOp>[1]): Board {
  const r = applyOp(board, op);
  if (!r.ok) throw new Error(r.reason);
  return r.board;
}

describe("applyOp", () => {
  const base = must(must({}, { kind: "create", card: card("a", "todo", "V") }), { kind: "create", card: card("b", "todo", "k") });

  it("creates, moves, renames, deletes", () => {
    let b = must(base, { kind: "move", id: "a", column: "doing", rank: "V" });
    expect(b.a!.column).toBe("doing");
    b = must(b, { kind: "rename", id: "a", from: "a", to: "Alpha" });
    expect(b.a!.title).toBe("Alpha");
    b = must(b, { kind: "delete", id: "a" });
    expect(b.a).toBeUndefined();
  });

  it("never mutates its input", () => {
    const frozen = Object.freeze({ ...base });
    applyOp(frozen, { kind: "move", id: "a", column: "done", rank: "z" });
    expect(frozen.a!.column).toBe("todo");
  });

  it("rename is compare-and-set: a stale `from` is rejected, not overwritten", () => {
    const renamed = must(base, { kind: "rename", id: "a", from: "a", to: "First" });
    expect(applyOp(renamed, { kind: "rename", id: "a", from: "a", to: "Second" })).toEqual({ ok: false, reason: "stale-title" });
  });

  it("ops on a deleted card are rejected", () => {
    const b = must(base, { kind: "delete", id: "a" });
    expect(applyOp(b, { kind: "move", id: "a", column: "done", rank: "V" })).toEqual({ ok: false, reason: "unknown-card" });
    expect(applyOp(b, { kind: "rename", id: "a", from: "a", to: "x" })).toEqual({ ok: false, reason: "unknown-card" });
    expect(applyOp(b, { kind: "delete", id: "a" })).toEqual({ ok: false, reason: "unknown-card" });
  });

  it("validates input even though the server also parses it", () => {
    expect(applyOp(base, { kind: "create", card: card("a", "todo", "x") }).ok).toBe(false); // duplicate id
    expect(applyOp(base, { kind: "create", card: card("c", "todo", "x", "   ") }).ok).toBe(false);
    expect(applyOp(base, { kind: "create", card: card("c", "todo", "x", "t".repeat(201)) }).ok).toBe(false);
    expect(applyOp(base, { kind: "create", card: card("c", "todo", "x0") }).ok).toBe(false);
    expect(applyOp(base, { kind: "create", card: { ...card("c", "todo", "x"), column: "nope" as Card["column"] } }).ok).toBe(false);
    expect(applyOp(base, { kind: "move", id: "a", column: "todo", rank: "" }).ok).toBe(false);
  });

  it("caps the board size", () => {
    let b: Board = {};
    for (let i = 0; i < MAX_CARDS; i++) b = { ...b, [`c${i}`]: card(`c${i}`, "todo", "V") };
    expect(applyOp(b, { kind: "create", card: card("extra", "todo", "V") })).toEqual({ ok: false, reason: "board-full" });
  });
});

describe("ordering", () => {
  it("sorts by rank, then id for ties", () => {
    const b: Board = { z: card("z", "todo", "V"), y: card("y", "todo", "V"), x: card("x", "todo", "A") };
    expect(columnCards(b, "todo").map((c) => c.id)).toEqual(["x", "y", "z"]);
  });

  it("rankAt places a card at an index, ignoring the card itself", () => {
    let b: Board = {};
    for (const id of ["a", "b", "c"]) b = must(b, { kind: "create", card: card(id, "todo", rankAt(b, "todo", 99)) });
    expect(columnCards(b, "todo").map((c) => c.id)).toEqual(["a", "b", "c"]);
    b = must(b, { kind: "move", id: "c", column: "todo", rank: rankAt(b, "todo", 0, "c") });
    expect(columnCards(b, "todo").map((c) => c.id)).toEqual(["c", "a", "b"]);
    b = must(b, { kind: "move", id: "c", column: "todo", rank: rankAt(b, "todo", 1, "c") });
    expect(columnCards(b, "todo").map((c) => c.id)).toEqual(["a", "c", "b"]);
  });

  it("rankAt survives equal neighbours", () => {
    const b: Board = { a: card("a", "todo", "V"), b: card("b", "todo", "V"), c: card("c", "todo", "k") };
    const r = rankAt(b, "todo", 1);
    expect(r > "V" && r < "k").toBe(true);
  });
});

describe("protocol", () => {
  it("column enum matches the board's columns", () => {
    expect(columnSchema.options).toEqual(COLUMN_IDS);
  });

  it("rejects messages that would be dangerous to trust", () => {
    const bad = [
      { t: "op", clientOpId: "x", op: { kind: "delete", id: "../etc" } },
      { t: "op", clientOpId: "x", op: { kind: "move", id: "a", column: "archive", rank: "V" } },
      { t: "op", clientOpId: "x", op: { kind: "explode" } },
      { t: "hello", clientId: "c", lastSeq: -1, presence: { name: "A", color: "#ffffff", editing: null, dragging: null } },
      { t: "presence", presence: { name: "A", color: "red;background:url(x)", editing: null, dragging: null } },
      { t: "presence", presence: { name: "", color: "#ffffff", editing: null, dragging: null } },
    ];
    for (const m of bad) expect(clientMessageSchema.safeParse(m).success).toBe(false);
  });
});
