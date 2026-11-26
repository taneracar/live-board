// The board model and the one function that changes it. The same applyOp runs
// on the server (authoritative) and in the browser (optimistic view), so the
// two can't drift apart in how an operation is interpreted.

import { isValidRank, rankBetween } from "./rank.ts";

export const COLUMNS = [
  { id: "todo", title: "To do" },
  { id: "doing", title: "Doing" },
  { id: "done", title: "Done" },
] as const;

export type ColumnId = (typeof COLUMNS)[number]["id"];
export const COLUMN_IDS: readonly string[] = COLUMNS.map((c) => c.id);

export const MAX_TITLE = 200;
export const MAX_CARDS = 500;

export interface Card {
  id: string;
  column: ColumnId;
  rank: string;
  title: string;
}

/** Cards keyed by id. Plain object so it serialises as-is. */
export type Board = Readonly<Record<string, Card>>;

export type Op =
  | { kind: "create"; card: Card }
  | { kind: "move"; id: string; column: ColumnId; rank: string }
  // Compare-and-set: applies only if the title is still what this client saw.
  | { kind: "rename"; id: string; from: string; to: string }
  | { kind: "delete"; id: string };

export type Rejection =
  | "unknown-card"
  | "duplicate-id"
  | "stale-title"
  | "invalid"
  | "board-full";

export type ApplyResult = { ok: true; board: Board } | { ok: false; reason: Rejection };

export function validTitle(title: unknown): title is string {
  return typeof title === "string" && title.trim().length > 0 && title.length <= MAX_TITLE;
}

export function applyOp(board: Board, op: Op): ApplyResult {
  switch (op.kind) {
    case "create": {
      const { card } = op;
      if (!validTitle(card.title) || !isValidRank(card.rank) || !COLUMN_IDS.includes(card.column)) {
        return { ok: false, reason: "invalid" };
      }
      if (board[card.id]) return { ok: false, reason: "duplicate-id" };
      if (Object.keys(board).length >= MAX_CARDS) return { ok: false, reason: "board-full" };
      return { ok: true, board: { ...board, [card.id]: { ...card } } };
    }
    case "move": {
      const card = board[op.id];
      if (!card) return { ok: false, reason: "unknown-card" };
      if (!isValidRank(op.rank) || !COLUMN_IDS.includes(op.column)) return { ok: false, reason: "invalid" };
      // Moves are last-writer-wins in server order: position is cheap to redo.
      return { ok: true, board: { ...board, [op.id]: { ...card, column: op.column, rank: op.rank } } };
    }
    case "rename": {
      const card = board[op.id];
      if (!card) return { ok: false, reason: "unknown-card" };
      if (!validTitle(op.to)) return { ok: false, reason: "invalid" };
      // Text is not cheap to redo: never silently overwrite someone else's edit.
      if (card.title !== op.from) return { ok: false, reason: "stale-title" };
      return { ok: true, board: { ...board, [op.id]: { ...card, title: op.to } } };
    }
    case "delete": {
      if (!board[op.id]) return { ok: false, reason: "unknown-card" };
      const { [op.id]: _gone, ...rest } = board;
      return { ok: true, board: rest };
    }
  }
}

/** Cards of one column in display order. Ties (two concurrent moves picking the
 * same rank) break by id, so every client shows the same order. */
export function columnCards(board: Board, column: string): Card[] {
  return Object.values(board)
    .filter((c) => c.column === column)
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Rank for putting `cardId` at position `index` of `column` (0 = top),
 * computed against the column as it looks without that card. */
export function rankAt(board: Board, column: string, index: number, cardId?: string): string {
  const cards = columnCards(board, column).filter((c) => c.id !== cardId);
  const i = Math.max(0, Math.min(index, cards.length));
  const before = cards[i - 1]?.rank ?? null;
  let after = cards[i]?.rank ?? null;
  // Equal neighbours can only exist transiently in an optimistic view; place
  // after the run of equals rather than failing.
  if (before !== null && after !== null && before >= after) {
    after = cards.slice(i).find((c) => c.rank > before)?.rank ?? null;
  }
  return rankBetween(before, after);
}
