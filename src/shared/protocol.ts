// Wire protocol. Everything a client sends is parsed with zod on the server;
// nothing from the socket is trusted as-typed.

import { z } from "zod";
import { MAX_TITLE, type Board, type Op, type Rejection } from "./board.ts";
import { MAX_RANK_LENGTH } from "./rank.ts";

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
// Kept in sync with COLUMNS by a test.
export const columnSchema = z.enum(["todo", "doing", "done"]);
const column = columnSchema;
const rank = z.string().min(1).max(MAX_RANK_LENGTH);
const title = z.string().max(MAX_TITLE);

export const opSchema: z.ZodType<Op> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), card: z.object({ id, column, rank, title }) }),
  z.object({ kind: z.literal("move"), id, column, rank }),
  z.object({ kind: z.literal("rename"), id, from: title, to: title }),
  z.object({ kind: z.literal("delete"), id }),
]) as z.ZodType<Op>;

export interface Presence {
  clientId: string;
  name: string;
  color: string;
  /** Card this person has open for editing, if any. */
  editing: string | null;
  /** Card this person is dragging, if any. */
  dragging: string | null;
}

export const presenceSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  editing: id.nullable(),
  dragging: id.nullable(),
});

export const clientMessageSchema = z.discriminatedUnion("t", [
  // First message on every connection, including reconnects.
  z.object({ t: z.literal("hello"), clientId: id, lastSeq: z.number().int().min(0), presence: presenceSchema }),
  z.object({ t: z.literal("op"), clientOpId: id, op: opSchema }),
  z.object({ t: z.literal("presence"), presence: presenceSchema }),
  z.object({ t: z.literal("ping") }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** One accepted operation, in server order. */
export interface Committed {
  seq: number;
  op: Op;
  clientOpId: string;
  clientId: string;
}

export type ServerMessage =
  // Catch-up after hello: either the ops the client missed, or (if it is too
  // far behind or new) a full snapshot.
  | { t: "welcome"; seq: number; snapshot: Board | null; ops: Committed[]; presence: Presence[] }
  | ({ t: "op" } & Committed)
  // Already applied earlier (a resend after reconnect): here is its seq.
  | { t: "dup"; clientOpId: string; seq: number }
  | { t: "reject"; clientOpId: string; reason: Rejection; card: Board[string] | null }
  | { t: "presence"; presence: Presence[] }
  | { t: "error"; message: string }
  | { t: "pong" };
