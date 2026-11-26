// Durable state: the current cards plus an append-only log of every accepted
// op. The log is what lets a reconnecting client catch up with just the ops it
// missed, and what makes resends idempotent (client_op_id is UNIQUE).

import { DatabaseSync } from "node:sqlite";
import type { Board, Card, Op } from "../src/shared/board.ts";
import type { Committed } from "../src/shared/protocol.ts";

export interface Store {
  load(): { board: Board; seq: number };
  /** Persist one accepted op and its effect on a single card, atomically. */
  commit(entry: Committed, after: Card | null, cardId: string): void;
  seqOf(clientOpId: string): number | null;
  /** Ops with seq > after, oldest first, or null if more than `limit` exist. */
  opsSince(after: number, limit: number): Committed[] | null;
  close(): void;
}

export function sqliteStore(path = ":memory:"): Store {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      col TEXT NOT NULL,
      rank TEXT NOT NULL,
      title TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ops (
      seq INTEGER PRIMARY KEY,
      client_op_id TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      op TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const upsert = db.prepare(
    `INSERT INTO cards (id, col, rank, title) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET col = excluded.col, rank = excluded.rank, title = excluded.title`,
  );
  const remove = db.prepare(`DELETE FROM cards WHERE id = ?`);
  const insertOp = db.prepare(`INSERT INTO ops (seq, client_op_id, client_id, op) VALUES (?, ?, ?, ?)`);
  const findOp = db.prepare(`SELECT seq FROM ops WHERE client_op_id = ?`);
  const since = db.prepare(`SELECT seq, client_op_id, client_id, op FROM ops WHERE seq > ? ORDER BY seq LIMIT ?`);

  return {
    load() {
      const board: Record<string, Card> = {};
      for (const r of db.prepare(`SELECT id, col, rank, title FROM cards`).all() as Array<Record<string, string>>) {
        board[r.id!] = { id: r.id!, column: r.col as Card["column"], rank: r.rank!, title: r.title! };
      }
      const row = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM ops`).get() as { seq: number };
      return { board, seq: row.seq };
    },
    commit(entry, after, cardId) {
      db.exec("BEGIN IMMEDIATE");
      try {
        insertOp.run(entry.seq, entry.clientOpId, entry.clientId, JSON.stringify(entry.op));
        if (after) upsert.run(after.id, after.column, after.rank, after.title);
        else remove.run(cardId);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    seqOf(clientOpId) {
      const row = findOp.get(clientOpId) as { seq: number } | undefined;
      return row ? row.seq : null;
    },
    opsSince(after, limit) {
      const rows = since.all(after, limit + 1) as Array<{ seq: number; client_op_id: string; client_id: string; op: string }>;
      if (rows.length > limit) return null;
      return rows.map((r) => ({ seq: r.seq, clientOpId: r.client_op_id, clientId: r.client_id, op: JSON.parse(r.op) as Op }));
    },
    close() {
      db.close();
    },
  };
}
